/**
 * 文件功能：SDK 装配层 —— 把配置、凭据、会话、资源、工具拼装成一个可用的 AgentSession。
 *
 * 这是阶段 A 的入口文件。createAgentSession() 按顺序解析 7 件事：
 *   1. cwd / agentDir（默认 process.cwd() 与 ~/.pi/agent）
 *   2. ModelRuntime（读 auth.json、models.json，封装 pi-ai 的流式调用）
 *   3. SettingsManager（全局 + 项目两级配置合并）与 SessionManager（会话落盘）
 *   4. DefaultResourceLoader（发现 skills / extensions / prompts / AGENTS.md）
 *   5. 模型解析链：会话记录 → settings 默认 → provider 默认
 *   6. thinkingLevel 解析链，并用 clampThinkingLevel 按模型能力夹紧
 *   7. 工具集解析（defaultTools + +/- 修饰符 + allow/deny）后交给 AgentSession
 *
 * 阅读路线：本文件的 createAgentSession（约 196 行）→ 其中注入的 streamFn（约 412 行）
 * → 结尾的 new AgentSession（约 455 行）。
 * 注意：agent 核心不依赖 pi-ai，默认流函数由本文件下方的 setDefaultStreamFn 注入。
 */
import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession, markRuntimeStreamFunction } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { getClientIdentity } from "./client-identity.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { createToolNameMatcher } from "./mcp-servers.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import {
	applyToolModifiers,
	DEFAULT_TOOL_NAMES,
	getToolListError,
	isToolModifier,
	SettingsManager,
} from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";
import { getBranchSelection } from "./virtual-models.ts";

// 保留 0.81 之前的行为：扩展可能自己 new Agent 或调用底层循环而不传 streamFn。
// agent 核心保持与 provider 无关，因此它自己不 import pi-ai/compat。
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	/** 项目本地资源发现的工作目录。默认：process.cwd() */
	cwd?: string;
	/** 全局配置目录。默认：~/.pi/agent */
	agentDir?: string;

	/** 模型与凭据的运行时。默认使用 agentDir/auth.json 与 models.json 构造一个。 */
	modelRuntime?: ModelRuntime;

	/** 使用的模型。默认：取 settings 里的配置，没有则取第一个可用模型 */
	model?: Model<any>;
	/** 思考档位。默认：取 settings 里的配置，没有则 'medium'（会被模型能力夹紧） */
	thinkingLevel?: ThinkingLevel;
	/** 可用于切换的模型列表（交互模式下的 Ctrl+P 轮换） */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * 未显式给出工具白名单时，对默认工具的压制模式。
	 *
	 * - "all"：启动时不启用任何工具
	 * - "builtin"：关闭默认内置工具（read、bash、edit、write），
	 *   但保留扩展/自定义工具
	 */
	noTools?: "all" | "builtin";
	/**
	 * 工具名或模式的白名单，其中 `*` 匹配任意字符。
	 *
	 * 省略时，若配置了 `defaultTools` 就按它决定初始选择，否则启用默认内置工具
	 * （read、bash、edit、write）。扩展/自定义工具默认保持启用，除非 `noTools` 改变该默认值。
	 * 提供本项时只启用匹配的工具。MCP 工具仍会注册给 codemode 与工具搜索，
	 * 除非某一项以 `mcp__` 开头——那样只保留匹配的 MCP 工具。空列表（等同 `noTools: "all"`）
	 * 会把 MCP 工具一起关掉。
	 *
	 * 只含 `+name` 与 `-name` 的列表不是白名单：它是在默认选择上增删，语义同 `defaultTools` 设置。
	 * 这类条目按精确名匹配。与普通条目混用会抛错。
	 */
	tools?: string[];
	/**
	 * 工具名或模式的拒绝列表。与 `tools` 同时出现时在它之后生效，MCP 工具同样适用。
	 */
	excludeTools?: string[];
	/** 额外注册的自定义工具（与内置工具并存）。 */
	customTools?: ToolDefinition[];

	/** 资源加载器。省略时使用 DefaultResourceLoader。 */
	resourceLoader?: ResourceLoader;

	/** 会话管理器。默认：SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** 配置管理器。默认：SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** 会话启动事件的元数据，供扩展运行时初始化使用。 */
	sessionStartEvent?: SessionStartEvent;
}

/** createAgentSession 的返回结果 */
export interface CreateAgentSessionResult {
	/** 创建出来的会话 */
	session: AgentSession;
	/** 扩展加载结果（交互模式用它搭 UI 上下文） */
	extensionsResult: LoadExtensionsResult;
	/** 会话恢复到的模型与保存的不一致时的警告文案 */
	modelFallbackMessage?: string;
}

// 重新导出

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// 工具工厂（用于自定义 cwd）
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

// 辅助函数

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * 按给定选项创建一个 AgentSession。
 *
 * @example
 * ```typescript
 * // 最小用法——全走默认值
 * const { session } = await createAgentSession();
 *
 * // 显式指定模型
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // 继续上一个会话
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // 全手工装配
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// 先看会话里是否已有数据需要恢复
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// assistant 消息只记录真正作答的物理模型，所以虚拟选择只存在于
	// model_change 条目里。
	const sessionModel = getBranchSelection(sessionManager.getBranch(), (provider, modelId) =>
		modelRuntime.getModel(provider, modelId),
	);

	// 会话里有数据时，优先用会话记录的模型
	if (!model && hasExistingSession && sessionModel) {
		const restoredModel = modelRuntime.getModel(sessionModel.provider, sessionModel.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${sessionModel.provider}/${sessionModel.modelId}`;
		}
	}

	// 仍然没有模型时用 findInitialModel（先看 settings 默认值，再看 provider 默认值）
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// 会话里有数据时，恢复会话里记录的思考档位
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// 依次回退到每模型覆盖值、全局默认值
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// 按模型能力夹紧档位
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES);
	// 只含 `+name`/`-name` 的 `tools` 列表是在默认选择上增删，而不是替换默认，
	// 语义与 `defaultTools` 设置一致。
	const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;
	const allowedToolNames = toolModifiers
		? options.noTools === "all"
			? selectedToolNames
			: undefined
		: (options.tools ?? (options.noTools === "all" ? [] : undefined));
	const excludedToolNames = options.excludeTools;
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !isExcludedTool?.(name));

	// 包装 convertToLlm：开启 blockImages 时过滤掉图片（纵深防御）
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// 每次调用时动态读配置，中途改动才能立即生效
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// 把所有消息里的 ImageContent 换成文字占位符
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// 去掉连续重复的 "Image reading is disabled." 文本
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const cacheWarmer = new CacheWarmer(
		modelRuntime,
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,
	);
	const buildRequestOptions = (options: ModelsSimpleStreamOptions = {}): ModelsSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const headerRunner = extensionRunnerRef.current;
		return {
			...options,
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			// 取代循环默认的客户端身份；每次请求现读，使遥测设置立即生效。
			identity: getClientIdentity(settingsManager),
			transformHeaders: async (headers) =>
				headerRunner?.hasHandlers("before_provider_headers")
					? headerRunner.emitBeforeProviderHeaders(headers)
					: headers,
		};
	};
	// 只给选中模型的请求做保温。被虚拟选择路由或被扩展重定向的请求，下一次未必重复，
	// 为它们预热可能是白费力气。
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		const messages = agent.state.messages;
		return () => {
			const currentModel = agent.state.model;
			const currentMessages = agent.state.messages;
			return (
				currentModel.provider === requestModel.provider &&
				currentModel.id === requestModel.id &&
				messages.length <= currentMessages.length &&
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};
	const transformProviderPayload = async (payload: unknown) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		return runner.emitBeforeProviderRequest(payload);
	};
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("after_provider_response")) return;
		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		model,
	) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;
		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
			messages: existingSession.messages,
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const requestOptions = buildRequestOptions(options);
			// 压缩与摘要走自己的路由 id，只有会话主请求会替换缓存项，所以从它们重新开始保温。
			// 只要当前 transcript 仍在请求前缀之上延伸就继续保温。agent 状态可能浅拷贝消息数组
			// 或刷新 model 对象而不改变实际请求，因此顶层对象引用不是可靠的缓存 key。
			if (options?.sessionId === sessionManager.getSessionId()) {
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			return modelRuntime.streamSimple(model, context, requestOptions);
		},
		onPayload: transformProviderPayload,
		onResponse: handleProviderResponse,
		onProviderStreamEvent: handleProviderStreamEvent,
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});
	// 这个流函数自己通过 modelRuntime 解析凭据，所以摘要不应提前解析（#11520）。
	markRuntimeStreamFunction(agent.streamFunction, modelRuntime);

	// 为旧会话补上缺失的配置元数据。
	if (hasExistingSession) {
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// 新会话要记录初始模型与思考档位，resume 时才能恢复
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		cacheWarmer,
		initialActiveToolNames,
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		defaultToolModifiers: toolModifiers,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
	});

	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
