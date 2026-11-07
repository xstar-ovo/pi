/**
 * Entry point for the headless agent server.
 *
 * Parses arguments, assembles the session runtime (settings, models, tools,
 * extensions, session file), and serves it over the JSONL RPC protocol on
 * stdio. All client-facing logic lives outside this package.
 */

import { modelsAreEqual } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { type Args, normalizeSessionName, parseArgs } from "./cli/args.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { resolveProjectTrusted } from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "./core/session-cwd.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./extensions/index.ts";
import { runMigrations } from "./migrations.ts";
import { runHttpMode } from "./modes/http/http-mode.ts";
import { runRpcMode } from "./modes/rpc/rpc-mode.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";

const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

type ResolvedSession =
	| { type: "path"; path: string }
	| { type: "local"; path: string }
	| { type: "global"; path: string; cwd: string }
	| { type: "not_found"; arg: string };

/** Resolve a session argument to a session file, by path or by ID (or ID prefix). */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	const exactPath = SessionManager.findById(cwd, sessionArg, sessionDir);
	if (exactPath) {
		return { type: "local", path: exactPath };
	}

	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((session) => session.id.startsWith(sessionArg));
	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch =
		allSessions.find((session) => session.id === sessionArg) ??
		allSessions.find((session) => session.id.startsWith(sessionArg));
	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	return { type: "not_found", arg: sessionArg };
}

function validateSessionFlags(parsed: Args): void {
	if (parsed.fork) {
		const conflictingFlags = [
			parsed.session ? "--session" : undefined,
			parsed.continue ? "--continue" : undefined,
			parsed.resume ? "--resume" : undefined,
			parsed.noSession ? "--no-session" : undefined,
		].filter((flag): flag is string => flag !== undefined);
		if (conflictingFlags.length > 0) {
			console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
			process.exit(1);
		}
	}

	if (parsed.sessionId !== undefined) {
		const conflictingFlags = [
			parsed.session ? "--session" : undefined,
			parsed.continue ? "--continue" : undefined,
			parsed.resume ? "--resume" : undefined,
		].filter((flag): flag is string => flag !== undefined);
		if (conflictingFlags.length > 0) {
			console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
			process.exit(1);
		}
		try {
			assertValidSessionId(parsed.sessionId);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
	}
}

function exitWithSessionError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	console.error(chalk.red(`Error: ${message}`));
	process.exit(1);
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = SessionManager.findById(cwd, parsed.sessionId, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);
		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				try {
					return SessionManager.forkFrom(resolved.path, cwd, sessionDir, { id: parsed.sessionId });
				} catch (error) {
					exitWithSessionError(error);
				}
				break;
			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);
		switch (resolved.type) {
			case "path":
			case "local":
				try {
					return SessionManager.open(resolved.path, sessionDir);
				} catch (error) {
					exitWithSessionError(error);
				}
				break;
			case "global":
				console.error(chalk.yellow(`Session found in different project: ${resolved.cwd}; forking into ${cwd}`));
				try {
					return SessionManager.forkFrom(resolved.path, cwd, sessionDir, { id: parsed.sessionId });
				} catch (error) {
					exitWithSessionError(error);
				}
				break;
			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		console.error(chalk.red("Error: --resume needs an interactive session picker; use --session <id> instead."));
		process.exit(1);
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = SessionManager.findById(cwd, parsed.sessionId, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession, sessionDir);
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: AgentSessionServices["modelRuntime"],
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	if (parsed.provider && !parsed.model) {
		diagnostics.push({
			type: "error",
			message: `--provider requires --model (for example: --provider ${parsed.provider} --model <pattern>)`,
		});
	}
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			inlineApiKey: Boolean(parsed.apiKey),
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel
			? scopedModels.find((scoped) => modelsAreEqual(scoped.model, savedModel))
			: undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((scoped) => ({
			model: scoped.model,
			thinkingLevel: scoped.thinkingLevel,
		}));
	}

	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

export async function main(args: string[], options?: MainOptions) {
	const appMode = "rpc";
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const diagnostic of parsed.diagnostics) {
			const color = diagnostic.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${diagnostic.type === "error" ? "Error" : "Warning"}: ${diagnostic.message}`));
		}
		if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			process.exit(1);
		}
	}

	validateSessionFlags(parsed);

	runMigrations(cwd);

	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	const sessionManager = await createSessionManager(parsed, cwd, sessionDir);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
		process.exit(1);
	}
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}

	const trustStore = new ProjectTrustStore(agentDir);
	const projectTrustByCwd = new Map<string, boolean>();
	const resolveCliPaths = (paths: string[] | undefined): string[] | undefined =>
		paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
	const resolvedExtensionPaths = resolveCliPaths(parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(parsed.promptTemplates);

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		sessionManager: runtimeSessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const cachedProjectTrust = projectTrustByCwd.get(runtimeCwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(runtimeCwd);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				trustStore.get(runtimeCwd) ??
				!hasTrustRequiringResources);
		const runtimeSettingsManager = SettingsManager.create(runtimeCwd, runtimeAgentDir, { projectTrusted });
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			settingsManager: runtimeSettingsManager,
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trusted = await resolveProjectTrusted({
								cwd: runtimeCwd,
								trustStore,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								projectTrustContext:
									projectTrustContext ?? createProjectTrustContext({ cwd: runtimeCwd, mode: appMode }),
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							projectTrustByCwd.set(runtimeCwd, trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				noExtensions: parsed.noExtensions,
				disabledBuiltinExtensions: parsed.noMcp ? ["mcp"] : undefined,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories,
			},
		});
		const { settingsManager, modelRuntime, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
			...(resourceLoader.getExtensions().warnings ?? []).map(({ path, warning }) => ({
				type: "warning" as const,
				message: `Extension package "${path}": ${warning}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
				: [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			runtimeSessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeSessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return { ...created, services, diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	const { services, session } = runtime;
	const { settingsManager, modelRuntime } = services;
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");

	if (parsed.help) {
		reportDiagnostics(startupDiagnostics);
		console.log(`${APP_NAME} backend (JSONL RPC on stdio). Run with --help for client-facing usage.`);
		process.exit(0);
	}

	reportDiagnostics(startupDiagnostics);
	if (hasRuntimeErrors) {
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}

	if (!session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	// Best-effort catalog refresh in the background.
	const offlineMode = parsed.offline === true || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (!offlineMode) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	const httpPort = readHttpPort(parsed.unknownFlags);
	await (httpPort === undefined ? runRpcMode(runtime) : runHttpMode(runtime, { port: httpPort }));
}

/** `--http[=port]` switches the backend from stdio RPC to the HTTP transport (default port 3000). */
function readHttpPort(unknownFlags: Map<string, boolean | string>): number | undefined {
	const flag = unknownFlags.get("http");
	if (flag === undefined) return undefined;
	const port = typeof flag === "string" ? Number.parseInt(flag, 10) : 3000;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(chalk.red(`Invalid --http port: ${flag}`));
		process.exit(1);
	}
	return port;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
