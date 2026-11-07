#!/usr/bin/env node
// Drives a built pi binary over its HTTP transport (POST /prompt, SSE /events) against a fake
// OpenAI-compatible provider, so the codemode worker inside the binary is exercised end to end.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const WORKER_MARKER = "PI_CODEMODE_WORKER_OK";
const SUCCESS_MARKER = "PI_CODEMODE_BINARY_SMOKE_OK";
const FAILURE_MARKER = "PI_CODEMODE_BINARY_SMOKE_FAILED";
const TIMEOUT_MS = 30_000;

function completionChunk(id, delta, finishReason = null, usage) {
	return {
		id,
		object: "chat.completion.chunk",
		created: 0,
		model: "codemode-smoke",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	};
}

function sendCompletion(response, chunks) {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "close",
	});
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
}

async function readRequest(request) {
	let body = "";
	for await (const chunk of request) body += chunk.toString();
	return body;
}

function toolResultContainsMarker(body) {
	const payload = JSON.parse(body);
	return (
		Array.isArray(payload.messages) &&
		payload.messages.some(
			(message) => message?.role === "tool" && JSON.stringify(message.content).includes(WORKER_MARKER),
		)
	);
}

async function freePort() {
	const server = createServer();
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Free-port probe did not bind to a TCP port");
	await new Promise((resolveClose) => server.close(resolveClose));
	return address.port;
}

async function waitForServer(baseUrl, child) {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`pi exited before serving HTTP (exit ${child.exitCode})`);
		try {
			const response = await fetch(`${baseUrl}/state`);
			if (response.ok) return;
		} catch {
			// Not listening yet.
		}
		await delay(100);
	}
	throw new Error(`Timed out waiting for ${baseUrl}/state`);
}

async function main() {
	const binaryArg = process.argv[2];
	if (!binaryArg || process.argv.length !== 3) {
		throw new Error("Usage: node scripts/smoke-test-codemode-binary.mjs <pi-binary>");
	}
	const binary = resolve(binaryArg);
	const tempDir = await mkdtemp(join(tmpdir(), "pi-codemode-binary-smoke-"));
	let requestCount = 0;
	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		const body = await readRequest(request);
		requestCount++;
		const id = `chatcmpl-codemode-smoke-${requestCount}`;
		if (requestCount === 1) {
			sendCompletion(response, [
				completionChunk(id, {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call_codemode_smoke",
							type: "function",
							function: {
								name: "codemode",
								arguments: JSON.stringify({ code: `text("${WORKER_MARKER}")` }),
							},
						},
					],
				}),
				completionChunk(id, {}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1 }),
			]);
			return;
		}
		const marker = toolResultContainsMarker(body) ? SUCCESS_MARKER : FAILURE_MARKER;
		sendCompletion(response, [
			completionChunk(id, { role: "assistant", content: marker }),
			completionChunk(id, {}, "stop", { prompt_tokens: 1, completion_tokens: 1 }),
		]);
	});

	let child;
	try {
		await new Promise((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Smoke-test server did not bind to a TCP port");
		await writeFile(
			join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					"codemode-smoke": {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						api: "openai-completions",
						apiKey: "smoke-test",
						models: [{ id: "codemode-smoke" }],
					},
				},
			}),
		);

		const port = await freePort();
		const baseUrl = `http://127.0.0.1:${port}`;
		const piArgs = [
			"--provider",
			"codemode-smoke",
			"--model",
			"codemode-smoke",
			"--tools",
			"codemode",
			"--no-session",
			"--offline",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			`--http=${port}`,
		];
		const javaScript = extname(binary) === ".js";
		child = spawn(javaScript ? process.execPath : binary, javaScript ? [binary, ...piArgs] : piArgs, {
			cwd: tempDir,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempDir,
				PI_OFFLINE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const exitPromise = new Promise((resolveExit, reject) => {
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error(`Smoke test timed out after ${TIMEOUT_MS} ms`));
			}, TIMEOUT_MS);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolveExit(code);
			});
		});

		await waitForServer(baseUrl, child);

		const events = await fetch(`${baseUrl}/events`);
		let eventText = "";
		const reader = events.body.getReader();
		const decoder = new TextDecoder();
		const pump = (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				eventText += decoder.decode(value, { stream: true });
			}
		})().catch(() => {});

		const promptResponse = await fetch(`${baseUrl}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "Run the codemode binary smoke test." }),
		});
		if (!promptResponse.ok) throw new Error(`POST /prompt failed with ${promptResponse.status}`);

		const deadline = Date.now() + TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (eventText.includes(SUCCESS_MARKER) || eventText.includes(FAILURE_MARKER)) break;
			await delay(100);
		}

		child.kill();
		await exitPromise;
		await pump;

		if (requestCount < 2 || !eventText.includes(SUCCESS_MARKER)) {
			throw new Error(
				`Codemode binary smoke test failed (requests ${requestCount})\nevents:\n${eventText}\nstderr:\n${stderr}`,
			);
		}
	} finally {
		child?.kill();
		await new Promise((resolveClose) => server.close(resolveClose));
		await rm(tempDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
