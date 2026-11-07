import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { type HttpServerHandle, startHttpServer } from "../src/modes/http/http-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("HTTP mode", () => {
	let harness: Harness | undefined;
	let handle: HttpServerHandle | undefined;

	afterEach(async () => {
		await handle?.close();
		harness?.cleanup();
		handle = undefined;
		harness = undefined;
	});

	test("reports session state", async () => {
		harness = await createHarness();
		handle = await startHttpServer({ session: harness.session, port: 0 });

		const response = await fetch(`http://127.0.0.1:${handle.port}/state`);

		expect(response.status).toBe(200);
		const state = (await response.json()) as { sessionId: string; isStreaming: boolean; messageCount: number };
		expect(state.sessionId).toBe(harness.session.sessionId);
		expect(state.isStreaming).toBe(false);
		expect(state.messageCount).toBe(0);
	});

	test("streams session events while a prompt runs", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("hello from the backend")]);
		handle = await startHttpServer({ session: harness.session, port: 0 });

		const events: Array<{ type: string }> = [];
		const stream = await fetch(`http://127.0.0.1:${handle.port}/events`);
		const reader = stream.body?.getReader();
		expect(reader).toBeDefined();
		const decoder = new TextDecoder();
		const collected = (async () => {
			let buffer = "";
			while (reader) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let index = buffer.indexOf("\n\n");
				while (index !== -1) {
					const frame = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					index = buffer.indexOf("\n\n");
					if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as { type: string });
				}
				if (events.some((event) => event.type === "agent_settled")) break;
			}
			return reader?.cancel();
		})();

		const response = await fetch(`http://127.0.0.1:${handle.port}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});
		expect(response.status).toBe(202);

		await collected;
		const types = events.map((event) => event.type);
		expect(types).toContain("agent_start");
		expect(types).toContain("message_end");
	});

	test("rejects a prompt without a message", async () => {
		harness = await createHarness();
		handle = await startHttpServer({ session: harness.session, port: 0 });

		const response = await fetch(`http://127.0.0.1:${handle.port}/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ nope: true }),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "message must be a non-empty string" });
	});
});
