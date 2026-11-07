// Stand-in for a pi RPC child: reads the task from the prompt command on stdin,
// emits session events on stdout, and settles after the final message.
import fs from "node:fs";

const requestedModelIndex = process.argv.indexOf("--model");
const requestedModel = requestedModelIndex >= 0 ? process.argv[requestedModelIndex + 1] : "fixture-model";

const zeroUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (text, options = {}) => ({
	role: "assistant",
	content: options.toolCall
		? [
				{ type: "text", text },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			]
		: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "fixture",
	model: options.model ?? requestedModel,
	usage: options.usage ?? zeroUsage(),
	stopReason: options.stopReason ?? "stop",
	...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
	timestamp: Date.now(),
});

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const emitMessage = (message) => emit({ type: "message_end", message });
const settle = () => emit({ type: "agent_settled" });

function run(task) {
	if (task.startsWith("record-argv:")) {
		fs.writeFileSync(task.slice("record-argv:".length), JSON.stringify(process.argv));
		emitMessage(assistant("done"));
		settle();
	} else if (task.startsWith("record-invocation:")) {
		fs.writeFileSync(
			task.slice("record-invocation:".length),
			JSON.stringify({ argv: process.argv, cwd: process.cwd() }),
		);
		emitMessage(assistant("done"));
		settle();
	} else if (task === "tool-then-final") {
		emitMessage(assistant("working", { stopReason: "toolUse", toolCall: true }));
		setTimeout(() => {
			emitMessage(assistant("finished"));
			settle();
		}, 150);
	} else if (task.startsWith("tool-wait:")) {
		const releaseFile = task.slice("tool-wait:".length);
		emitMessage(assistant("working", { stopReason: "toolUse", toolCall: true }));
		const timer = setInterval(() => {
			if (!fs.existsSync(releaseFile)) return;
			clearInterval(timer);
			emitMessage(assistant("finished"));
			settle();
		}, 10);
	} else if (task === "signal") {
		process.kill(process.pid, "SIGTERM");
	} else if (task === "error" || task === "model-error") {
		process.stderr.write("stderr evidence\n");
		emitMessage(
			assistant("assistant evidence", {
				stopReason: "error",
				errorMessage: "provider evidence",
			}),
		);
		if (task === "error") process.exitCode = 1;
		process.exit(process.exitCode ?? 0);
	} else if (task.startsWith("large")) {
		emitMessage(assistant(`${"x".repeat(60 * 1024)}\n${"line\n".repeat(2100)}`));
		settle();
	} else if (task.startsWith("ignore-sigterm:")) {
		fs.writeFileSync(task.slice("ignore-sigterm:".length), String(process.pid));
		process.on("SIGTERM", () => {});
		emitMessage(assistant("partial", { stopReason: "toolUse" }));
		setInterval(() => {}, 1000);
	} else if (task.startsWith("hold:")) {
		fs.appendFileSync(task.slice("hold:".length), `${process.pid}\n`);
		setInterval(() => {}, 1000);
	} else {
		process.stderr.write(`Unknown fixture task: ${task}\n`);
		process.exit(2);
	}
}

let started = false;
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (started || !line.trim()) continue;
		const command = JSON.parse(line);
		if (command.type !== "prompt") continue;
		started = true;
		run(command.message.replace(/^Task: /, ""));
	}
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
