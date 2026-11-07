import { describe, expect, test } from "vitest";
import { normalizeSessionName, parseArgs } from "../src/cli/args.ts";

describe("parseArgs", () => {
	describe("--version flag", () => {
		test("parses --version flag", () => {
			const result = parseArgs(["--version"]);
			expect(result.version).toBe(true);
		});

		test("parses -v shorthand", () => {
			const result = parseArgs(["-v"]);
			expect(result.version).toBe(true);
		});

		test("--version takes precedence over other args", () => {
			const result = parseArgs(["--version", "--help", "some message"]);
			expect(result.version).toBe(true);
			expect(result.help).toBe(true);
			expect(result.messages).toContain("some message");
		});
	});

	describe("--help flag", () => {
		test("parses --help flag", () => {
			const result = parseArgs(["--help"]);
			expect(result.help).toBe(true);
		});

		test("parses -h shorthand", () => {
			const result = parseArgs(["-h"]);
			expect(result.help).toBe(true);
		});
	});

	describe("removed flags", () => {
		test("rejects the -p shorthand", () => {
			const result = parseArgs(["-p"]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "Unknown option: -p" }]);
		});

		test.each(["--print", "--export", "--theme", "--use-theme", "--no-themes", "--tui-mode"])(
			"leaves %s to unknown-flag handling",
			(flag) => {
				const result = parseArgs([flag]);
				expect(result.diagnostics).toEqual([]);
				expect(result.unknownFlags.has(flag.slice(2))).toBe(true);
			},
		);
	});

	describe("--continue flag", () => {
		test("parses --continue flag", () => {
			const result = parseArgs(["--continue"]);
			expect(result.continue).toBe(true);
		});

		test("parses -c shorthand", () => {
			const result = parseArgs(["-c"]);
			expect(result.continue).toBe(true);
		});
	});

	describe("--resume flag", () => {
		test("parses --resume flag", () => {
			const result = parseArgs(["--resume"]);
			expect(result.resume).toBe(true);
		});

		test("parses -r shorthand", () => {
			const result = parseArgs(["-r"]);
			expect(result.resume).toBe(true);
		});
	});

	describe("flags with values", () => {
		test("parses --provider", () => {
			const result = parseArgs(["--provider", "openai"]);
			expect(result.provider).toBe("openai");
		});

		test("parses --model", () => {
			const result = parseArgs(["--model", "gpt-4o"]);
			expect(result.model).toBe("gpt-4o");
		});

		test("parses --api-key", () => {
			const result = parseArgs(["--api-key", "sk-test-key"]);
			expect(result.apiKey).toBe("sk-test-key");
		});

		test("parses --system-prompt", () => {
			const result = parseArgs(["--system-prompt", "You are a helpful assistant"]);
			expect(result.systemPrompt).toBe("You are a helpful assistant");
		});

		test("parses --append-system-prompt", () => {
			const result = parseArgs(["--append-system-prompt", "Additional context"]);
			expect(result.appendSystemPrompt).toEqual(["Additional context"]);
		});

		test("parses multiple --append-system-prompt flags", () => {
			const result = parseArgs(["--append-system-prompt", "Context A", "--append-system-prompt", "Context B"]);
			expect(result.appendSystemPrompt).toEqual(["Context A", "Context B"]);
		});

		test("parses --session", () => {
			const result = parseArgs(["--session", "/path/to/session.jsonl"]);
			expect(result.session).toBe("/path/to/session.jsonl");
		});

		test("parses --session-id", () => {
			const result = parseArgs(["--session-id", "orchestrated-session"]);
			expect(result.sessionId).toBe("orchestrated-session");
		});

		test("parses --fork", () => {
			const result = parseArgs(["--fork", "1234abcd"]);
			expect(result.fork).toBe("1234abcd");
			expect(result.messages).toEqual([]);
		});

		test("parses --thinking", () => {
			const result = parseArgs(["--thinking", "high"]);
			expect(result.thinking).toBe("high");
		});

		test("parses --models as comma-separated list", () => {
			const result = parseArgs(["--models", "gpt-4o,claude-sonnet,gemini-pro"]);
			expect(result.models).toEqual(["gpt-4o", "claude-sonnet", "gemini-pro"]);
		});

		// Issue #10334
		test("ignores empty entries in --models", () => {
			const result = parseArgs(["--models", "gpt-4o, ,claude-sonnet,"]);
			expect(result.models).toEqual(["gpt-4o", "claude-sonnet"]);
		});
	});

	describe("--http flag", () => {
		test("defaults to port 3000", () => {
			const result = parseArgs(["--http"]);
			expect(result.httpPort).toBe(3000);
			expect(result.diagnostics).toEqual([]);
		});

		test.each([
			[["--http=4000"], 4000],
			[["--http", "8080"], 8080],
		] as const)("parses %j", (args, port) => {
			const result = parseArgs([...args]);
			expect(result.httpPort).toBe(port);
			expect(result.diagnostics).toEqual([]);
		});

		test.each(["--http=0", "--http=70000", "--http=abc"])("rejects invalid --http value %s", (arg) => {
			const result = parseArgs([arg]);
			expect(result.httpPort).toBeUndefined();
			expect(result.diagnostics).toHaveLength(1);
		});
	});

	// Issue #9045
	describe("--mode flag", () => {
		test.each(["text", "json", "rpc"] as const)("parses --mode %s", (mode) => {
			const result = parseArgs(["--mode", mode]);
			expect(result.mode).toBe(mode);
			expect(result.diagnostics).toEqual([]);
		});

		test.each(["yaml", ""])("rejects invalid --mode value %j", (mode) => {
			const result = parseArgs(["--mode", mode, "--version"]);
			expect(result.mode).toBeUndefined();
			expect(result.version).toBe(true);
			expect(result.messages).toEqual([]);
			expect(result.unknownFlags.size).toBe(0);
			expect(result.diagnostics).toEqual([
				{ type: "error", message: `Invalid mode "${mode}". Valid values: text, json, rpc` },
			]);
		});

		test("reports a missing --mode value", () => {
			const result = parseArgs(["--mode"]);
			expect(result.mode).toBeUndefined();
			expect(result.unknownFlags.size).toBe(0);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--mode requires text, json, or rpc" }]);
		});

		test("does not consume another option as a --mode value", () => {
			const result = parseArgs(["--mode", "--version"]);
			expect(result.mode).toBeUndefined();
			expect(result.version).toBe(true);
			expect(result.unknownFlags.size).toBe(0);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--mode requires text, json, or rpc" }]);
		});

		test("reports an invalid --mode value after a valid one", () => {
			const result = parseArgs(["--mode", "json", "--mode", "yaml"]);
			expect(result.diagnostics).toEqual([
				{ type: "error", message: 'Invalid mode "yaml". Valid values: text, json, rpc' },
			]);
		});
	});

	describe("--name flag", () => {
		test("parses --name flag with value", () => {
			const result = parseArgs(["--name", "my-session"]);
			expect(result.name).toBe("my-session");
		});

		test("parses -n shorthand", () => {
			const result = parseArgs(["-n", "quick-session"]);
			expect(result.name).toBe("quick-session");
		});

		test("preserves empty values for main validation", () => {
			const result = parseArgs(["--name", ""]);
			expect(result.name).toBe("");
		});

		test("normalizes display names and rejects whitespace-only values", () => {
			expect(normalizeSessionName("  named session  ")).toBe("named session");
			expect(normalizeSessionName("   ")).toBeUndefined();
		});

		test("reports missing value", () => {
			const result = parseArgs(["--name"]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--name requires a value" }]);
		});

		test("works alongside other flags", () => {
			const result = parseArgs(["--name", "named-run", "--model", "gpt-4o", "hello"]);
			expect(result.name).toBe("named-run");
			expect(result.model).toBe("gpt-4o");
			expect(result.messages).toEqual(["hello"]);
		});
	});

	describe("--no-session flag", () => {
		test("parses --no-session flag", () => {
			const result = parseArgs(["--no-session"]);
			expect(result.noSession).toBe(true);
		});

		test("preserves custom session IDs for non-persisting commands", () => {
			expect(parseArgs(["--session-id", "ephemeral-id", "--help"])).toMatchObject({
				sessionId: "ephemeral-id",
				help: true,
			});
			expect(parseArgs(["--session-id", "ephemeral-id", "--list-models"])).toMatchObject({
				sessionId: "ephemeral-id",
				listModels: true,
			});
			expect(parseArgs(["--session-id", "ephemeral-id", "--no-session"])).toMatchObject({
				sessionId: "ephemeral-id",
				noSession: true,
			});
		});
	});

	describe("--extension flag", () => {
		test("parses single --extension", () => {
			const result = parseArgs(["--extension", "./my-extension.ts"]);
			expect(result.extensions).toEqual(["./my-extension.ts"]);
		});

		test("parses -e shorthand", () => {
			const result = parseArgs(["-e", "./my-extension.ts"]);
			expect(result.extensions).toEqual(["./my-extension.ts"]);
		});

		test("parses multiple --extension flags", () => {
			const result = parseArgs(["--extension", "./ext1.ts", "-e", "./ext2.ts"]);
			expect(result.extensions).toEqual(["./ext1.ts", "./ext2.ts"]);
		});
	});

	describe("--no-extensions flag", () => {
		test("parses --no-extensions flag", () => {
			const result = parseArgs(["--no-extensions"]);
			expect(result.noExtensions).toBe(true);
		});

		test("parses --no-extensions with explicit -e flags", () => {
			const result = parseArgs(["--no-extensions", "-e", "foo.ts", "-e", "bar.ts"]);
			expect(result.noExtensions).toBe(true);
			expect(result.extensions).toEqual(["foo.ts", "bar.ts"]);
		});
	});

	describe("--no-mcp flag", () => {
		test("parses --no-mcp flag", () => {
			const result = parseArgs(["--no-mcp"]);
			expect(result.noMcp).toBe(true);
			expect(result.unknownFlags.size).toBe(0);
		});
	});

	describe("--skill flag", () => {
		test("parses single --skill", () => {
			const result = parseArgs(["--skill", "./skill-dir"]);
			expect(result.skills).toEqual(["./skill-dir"]);
		});

		test("parses multiple --skill flags", () => {
			const result = parseArgs(["--skill", "./skill-a", "--skill", "./skill-b"]);
			expect(result.skills).toEqual(["./skill-a", "./skill-b"]);
		});
	});

	describe("--prompt-template flag", () => {
		test("parses single --prompt-template", () => {
			const result = parseArgs(["--prompt-template", "./prompts"]);
			expect(result.promptTemplates).toEqual(["./prompts"]);
		});

		test("parses multiple --prompt-template flags", () => {
			const result = parseArgs(["--prompt-template", "./one", "--prompt-template", "./two"]);
			expect(result.promptTemplates).toEqual(["./one", "./two"]);
		});
	});

	describe("--no-skills flag", () => {
		test("parses --no-skills flag", () => {
			const result = parseArgs(["--no-skills"]);
			expect(result.noSkills).toBe(true);
		});
	});

	describe("--no-prompt-templates flag", () => {
		test("parses --no-prompt-templates flag", () => {
			const result = parseArgs(["--no-prompt-templates"]);
			expect(result.noPromptTemplates).toBe(true);
		});
	});

	describe("--no-context-files flag", () => {
		test("parses --no-context-files flag", () => {
			const result = parseArgs(["--no-context-files"]);
			expect(result.noContextFiles).toBe(true);
		});

		test("parses -nc shorthand", () => {
			const result = parseArgs(["-nc"]);
			expect(result.noContextFiles).toBe(true);
		});
	});

	describe("project approval flags", () => {
		test("parses --approve", () => {
			const result = parseArgs(["--approve"]);
			expect(result.projectTrustOverride).toBe(true);
		});

		test("parses -a shorthand", () => {
			const result = parseArgs(["-a"]);
			expect(result.projectTrustOverride).toBe(true);
		});

		test("parses --no-approve", () => {
			const result = parseArgs(["--no-approve"]);
			expect(result.projectTrustOverride).toBe(false);
		});

		test("parses -na shorthand", () => {
			const result = parseArgs(["-na"]);
			expect(result.projectTrustOverride).toBe(false);
		});
	});

	describe("--verbose flag", () => {
		test("parses --verbose flag", () => {
			const result = parseArgs(["--verbose"]);
			expect(result.verbose).toBe(true);
		});
	});

	describe("--offline flag", () => {
		test("parses --offline flag", () => {
			const result = parseArgs(["--offline"]);
			expect(result.offline).toBe(true);
		});
	});

	describe("tool flags", () => {
		test("parses --no-tools flag", () => {
			const result = parseArgs(["--no-tools"]);
			expect(result.noTools).toBe(true);
		});

		test("parses -nt shorthand", () => {
			const result = parseArgs(["-nt"]);
			expect(result.noTools).toBe(true);
		});

		test("parses --no-builtin-tools flag", () => {
			const result = parseArgs(["--no-builtin-tools"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses -nbt shorthand", () => {
			const result = parseArgs(["-nbt"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses --tools flag", () => {
			const result = parseArgs(["--tools", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses -t shorthand", () => {
			const result = parseArgs(["-t", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses +name and -name tool modifiers", () => {
			const result = parseArgs(["-t", "+codemode,-write"]);
			expect(result.tools).toEqual(["+codemode", "-write"]);
			expect(result.diagnostics).toEqual([]);
		});

		test("rejects tool names mixed with modifiers", () => {
			const result = parseArgs(["--tools", "read,+codemode"]);
			expect(result.tools).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{ type: "error", message: "--tools: tool names cannot be mixed with +name or -name entries" },
			]);
		});

		test("rejects patterns in tool modifiers", () => {
			const result = parseArgs(["-t", "+mcp__radius__*"]);
			expect(result.tools).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{
					type: "error",
					message: "-t: +name and -name entries take exact tool names, not patterns: +mcp__radius__*",
				},
			]);
		});

		test("parses --exclude-tools flag", () => {
			const result = parseArgs(["--exclude-tools", "read,bash"]);
			expect(result.excludeTools).toEqual(["read", "bash"]);
		});

		test("parses -xt shorthand", () => {
			const result = parseArgs(["-xt", "read,bash"]);
			expect(result.excludeTools).toEqual(["read", "bash"]);
		});

		test("parses --no-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-tools", "--tools", "read,bash"]);
			expect(result.noTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses --no-builtin-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-builtin-tools", "--tools", "read,bash"]);
			expect(result.noBuiltinTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});
	});

	describe("messages and file args", () => {
		test("parses plain text messages", () => {
			const result = parseArgs(["hello", "world"]);
			expect(result.messages).toEqual(["hello", "world"]);
		});

		test("parses @file arguments", () => {
			const result = parseArgs(["@README.md", "@src/main.ts"]);
			expect(result.fileArgs).toEqual(["README.md", "src/main.ts"]);
		});

		test("parses mixed messages and file args", () => {
			const result = parseArgs(["@file.txt", "explain this", "@image.png"]);
			expect(result.fileArgs).toEqual(["file.txt", "image.png"]);
			expect(result.messages).toEqual(["explain this"]);
		});

		test("captures unknown long flags with string values", () => {
			const result = parseArgs(["--unknown-flag", "message"]);
			expect(result.messages).toEqual([]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("message");
		});

		test("captures unknown boolean long flags", () => {
			const result = parseArgs(["--unknown-flag"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe(true);
		});

		test("captures unknown long flags with equals syntax", () => {
			const result = parseArgs(["--unknown-flag=value"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("value");
		});
	});

	describe("complex combinations", () => {
		test("parses multiple flags together", () => {
			const result = parseArgs([
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet",
				"--thinking",
				"high",
				"@prompt.md",
				"Do the task",
			]);
			expect(result.provider).toBe("anthropic");
			expect(result.model).toBe("claude-sonnet");
			expect(result.thinking).toBe("high");
			expect(result.fileArgs).toEqual(["prompt.md"]);
			expect(result.messages).toEqual(["Do the task"]);
		});
	});
});
