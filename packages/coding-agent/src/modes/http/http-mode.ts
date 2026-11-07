/**
 * HTTP transport for the backend: POST /prompt, POST /abort, GET /state, GET /events (server-sent events).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../../core/extensions/index.ts";
import { toJsonEvent } from "../json-event.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;

export interface HttpServerOptions {
	session: AgentSession;
	host?: string;
	port?: number;
}

export interface HttpServerHandle {
	port: number;
	close: () => Promise<void>;
}

export interface HttpModeOptions {
	host?: string;
	port?: number;
}

interface PromptBody {
	message: string;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
}

/** Starts the HTTP transport and returns a handle that stops it. */
export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
	const host = options.host ?? "127.0.0.1";
	const session = options.session;
	const clients = new Set<ServerResponse>();

	const unsubscribe = session.subscribe((event) => broadcast(clients, toJsonEvent(event)));
	const keepalive = setInterval(() => {
		for (const client of clients) client.write(": keepalive\n\n");
	}, KEEPALIVE_MS);

	const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", "http://localhost");

		if (request.method === "GET" && url.pathname === "/state") {
			sendJson(response, 200, describeSession(session));
			return;
		}
		if (request.method === "GET" && url.pathname === "/events") {
			openEventStream(request, response, clients);
			return;
		}
		if (request.method === "POST" && url.pathname === "/prompt") {
			const body = await readPromptBody(request);
			void session
				.prompt(body.message, {
					images: body.images,
					streamingBehavior: body.streamingBehavior,
					source: "rpc",
				})
				.catch((error: unknown) => {
					broadcast(clients, { type: "http_error", message: errorMessage(error) });
				});
			sendJson(response, 202, { accepted: true });
			return;
		}
		if (request.method === "POST" && url.pathname === "/abort") {
			await session.abort();
			sendJson(response, 200, { aborted: true });
			return;
		}

		sendJson(response, 404, { error: `no route for ${request.method} ${url.pathname}` });
	};

	const server = createServer((request, response) => {
		void handleRequest(request, response).catch((error: unknown) => {
			if (!response.headersSent) {
				sendJson(response, 500, { error: errorMessage(error) });
			} else {
				response.end();
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 3000, host, resolve);
	});

	const address = server.address();
	const boundPort = typeof address === "object" && address ? address.port : (options.port ?? 3000);

	return {
		port: boundPort,
		close: async () => {
			clearInterval(keepalive);
			unsubscribe();
			for (const client of clients) client.end();
			clients.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** Runs the backend over HTTP until the process is interrupted. */
export async function runHttpMode(runtimeHost: AgentSessionRuntime, options: HttpModeOptions = {}): Promise<never> {
	const session = runtimeHost.session;
	await session.bindExtensions({ uiContext: createHeadlessUiContext(), mode: "rpc" });
	const handle = await startHttpServer({ session, host: options.host, port: options.port });
	process.stderr.write(`Listening on http://${options.host ?? "127.0.0.1"}:${handle.port}\n`);

	const shutdown = async (): Promise<void> => {
		await handle.close();
		await runtimeHost.dispose();
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown());
	process.once("SIGTERM", () => void shutdown());

	return new Promise<never>(() => {});
}

function describeSession(session: AgentSession) {
	return {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		messageCount: session.messages.length,
	};
}

function openEventStream(request: IncomingMessage, response: ServerResponse, clients: Set<ServerResponse>): void {
	response.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	response.write(": connected\n\n");
	clients.add(response);
	request.on("close", () => clients.delete(response));
}

function broadcast(clients: Set<ServerResponse>, payload: unknown): void {
	const frame = `data: ${JSON.stringify(payload)}\n\n`;
	for (const client of clients) client.write(frame);
}

async function readPromptBody(request: IncomingMessage): Promise<PromptBody> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(chunk as Buffer);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("request body must be JSON");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("request body must be a JSON object");
	}

	const body = parsed as Partial<PromptBody>;
	if (typeof body.message !== "string" || body.message.length === 0) {
		throw new Error("message must be a non-empty string");
	}
	if (body.images !== undefined && !Array.isArray(body.images)) {
		throw new Error("images must be an array");
	}
	if (
		body.streamingBehavior !== undefined &&
		body.streamingBehavior !== "steer" &&
		body.streamingBehavior !== "followUp"
	) {
		throw new Error('streamingBehavior must be "steer" or "followUp"');
	}

	return { message: body.message, images: body.images, streamingBehavior: body.streamingBehavior };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
	response.end(payload);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** No human is attached to an HTTP session, so dialogs resolve as unanswered. */
function createHeadlessUiContext(): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		notify: (message) => process.stderr.write(`[extension] ${message}\n`),
		setStatus: () => {},
		setTitle: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
	};
}
