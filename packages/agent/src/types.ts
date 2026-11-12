import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ImageContent,
	JsonValue,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-schema";

/**
 * 文件功能：agent 包的契约类型 —— 循环、工具、事件、状态的全部接口定义。
 *
 * 阶段 B 只关心四个声明：
 *   StreamFn（约 34 行）          模型层唯一入口
 *   AgentLoopConfig（约 193 行）  循环的全部可注入行为（三个 turn 钩子 + 两个队列 + 两个工具钩子）
 *   AgentContext（约 514 行）     循环持有的上下文（messages + tools）
 *   AgentEvent（约 528 行）       循环对外发出的事件联合类型
 *
 * 本文件只有类型与 JSDoc 注释，无运行时代码。
 */
/**
 * agent 循环使用的流函数。`Models.streamSimple` 满足这个形状。
 *
 * 循环传进来的是已归一化的 transcript：系统提示与工具声明由 transcript 里的 system 消息承载，
 * 永远不走 `context.systemPrompt` 或 `context.tools`。
 *
 * 契约：
 * - 请求/模型/运行时失败时不得抛异常或返回 rejected promise。
 * - 必须返回 AssistantMessageEventStream。
 * - 失败必须通过协议事件 + 一条 stopReason 为 "error" 或 "aborted"（带 errorMessage）
 *   的最终 AssistantMessage 编码到返回的流里。
 */
export type StreamFn = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * 一条 assistant 消息里的多个工具调用的执行方式。
 *
 * - "sequential"：每个调用依次完成准备、执行、定稿，下一个才开始。
 * - "parallel"：调用依次准备，然后被允许的执行并发跑。
 *   `tool_execution_end` 在每个工具定稿后按完成顺序发出，
 *   而 tool-result 消息稍后按 assistant 源顺序发出。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 控制循环到达队列抽干点时一次注入多少条排队消息。
 *
 * - "all"：抽干并注入当时队列里的所有消息。
 * - "one-at-a-time"：只抽干并注入最旧的一条，其余留给后续抽干点。
 */
export type QueueMode = "all" | "one-at-a-time";

/** assistant 消息发出的单个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * `beforeToolCall` 的返回值。
 *
 * 返回 `{ block: true }` 阻止工具执行，循环会改为发一条错误工具结果，
 * `reason` 就是那条错误结果的文本；省略时用默认的“已阻止”文案。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	/**
	 * 提示 agent 在本批工具执行完后停下（此调用被阻止时）。
	 * 只有当批次里每个定稿的工具结果都把它设成 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/**
 * `afterToolCall` 返回的部分覆盖值。
 *
 * 合并语义是逐字段的：
 * - `content`：提供则整块替换工具结果的内容数组
 * - `details`：提供则整体替换 details
 * - `isError`：提供则替换错误标记
 * - `usage`：提供则替换工具结果用量
 * - `terminate`：提供则替换提前终止提示
 * - `structuredContent`：提供则替换结构化内容。若只给了 `content` 没给它，结构化内容会被丢弃，
 *   因为两者可能已不匹配；要保留就与 `content` 一起返回。
 *
 * 其余未提供的字段保留执行结果的原值。`content`、`details`、`usage` 都不做深合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	/** 工具本次执行自身的用量（若有）。不参与主 LLM 上下文的计量。 */
	usage?: Usage;
	/**
	 * 提示 agent 在本批工具执行完后停下。
	 * 只有当批次里每个定稿的工具结果都把它设成 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/** 传给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** 发起该工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 里的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 按目标工具 schema 校验过的参数。 */
	args: unknown;
	/** 准备该调用时刻的当前 agent 上下文。 */
	context: AgentContext;
}

/** 传给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** 发起该工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 里的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 按目标工具 schema 校验过的参数。 */
	args: unknown;
	/** 执行后的工具结果，尚未应用 `afterToolCall` 的任何覆盖。 */
	result: AgentToolResult<any>;
	/** 执行结果当前是否被当作错误。 */
	isError: boolean;
	/** 定稿该调用时刻的当前 agent 上下文。 */
	context: AgentContext;
}

/** 传给“回合完成”回调的上下文。 */
export interface AgentTurnContext {
	/** 完成本回合的 assistant 消息。 */
	message: AssistantMessage;
	/** 本回合发出的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** 本回合的 assistant 消息与工具结果都追加之后的当前 agent 上下文。 */
	context: AgentContext;
	/** 若循环在此刻退出，本次调用将返回的消息。prompt 运行包含初始 prompt 消息；续跑运行不包含已有上下文消息。 */
	newMessages: AgentMessage[];
}

/** {@link FinishTurn} 的返回值。返回 undefined 表示保持正常调度。 */
export type AgentTurnDecision = { action: "continue" } | { action: "end" };

/**
 * 在 assistant 回合及其全部工具结果消息完成之后、`turn_end` 之前调用。
 * 正常回合里 `{ action: "continue" }` 保证再发一次请求：工具结果、插话或 followUp 的调度
 * 可以满足这次请求（不会额外多发），否则循环带着当前上下文再跑一次。
 * error 与 aborted 响应仍然是硬退出。
 */
export type FinishTurn = (
	turn: AgentTurnContext,
	signal?: AbortSignal,
) => AgentTurnDecision | void | Promise<AgentTurnDecision | undefined> | Promise<void>;

/** agent 循环在发起下一次 provider 请求前可替换的运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** 下一次 provider 请求用的上下文。 */
	context?: AgentContext;
	/** 在下一次请求前追加的消息（带正常生命周期事件）。 */
	messages?: AgentMessage[];
	/** 下一次 provider 请求用的模型。 */
	model?: Model<any>;
	/** 下一次 provider 请求用的思考档位。 */
	thinkingLevel?: ThinkingLevel;
}

/** 紧邻一次会话请求之前可用的运行时状态。 */
export interface PrepareRequestContext {
	context: AgentContext;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
}

/** 正在准备的这次 provider 请求可替换的运行时状态。 */
export type AgentRequestUpdate = Omit<AgentLoopTurnUpdate, "messages">;

/**
 * 在每次会话请求前立即调用，首次请求也算。回调运行时，待处理消息已经追加并发出事件。
 */
export type PrepareRequest = (
	request: PrepareRequestContext,
	signal?: AbortSignal,
) => AgentRequestUpdate | void | Promise<AgentRequestUpdate | undefined> | Promise<void>;

export interface PrepareNextTurnContext extends AgentTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 在每次 LLM 调用前把 AgentMessage[] 转成 LLM 能识别的 Message[]。
	 *
	 * 每条 AgentMessage 都必须转成 SystemMessage、UserMessage、AssistantMessage 或 ToolResultMessage。
	 * 无法转换的（如纯 UI 通知、状态消息）应当过滤掉。
	 *
	 * 契约：不得抛异常或 reject。请返回安全的降级值。
	 * 抛异常会中断底层循环，导致事件序列不完整。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 可选：在 `convertToLlm` 之前对上下文做的变换。
	 *
	 * 在 AgentMessage 这一层做的事：
	 * - 上下文窗口管理（裁剪旧消息）
	 * - 从外部来源注入上下文
	 *
	 * 契约：不得抛异常或 reject。拿不到结果就返回原消息或其他安全的降级值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 每次 LLM 调用时动态解析 API key。
	 *
	 * 用于会过期的短期 OAuth token（如 GitHub Copilot）——长时间的工具执行阶段里可能失效。
	 *
	 * 契约：不得抛异常或 reject。没有可用 key 时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 在 assistant 消息及全部工具结果消息发出之后、`turn_end` 之前调用。
	 * `{ action: "end" }` 直接结束本次 run，不再轮询队列也不再准备下一次请求。
	 * 正常回合里 `{ action: "continue" }` 保证再发一次请求（工具结果/插话/followUp 的调度可以满足它，
	 * 不会额外多发），否则循环带着当前上下文再跑一次。返回 undefined 保持默认调度。
	 * error 与 aborted 响应仍然是硬退出。
	 */
	finishTurn?: FinishTurn;

	/**
	 * 在每次会话请求前立即调用，首次请求也算。此时待处理消息已经追加完成。
	 * 返回的 context / model / thinkingLevel 会替换本次 run 后续请求的运行时值。
	 * 这个钩子不会轮询队列。
	 */
	prepareRequest?: PrepareRequest;

	/**
	 * 循环决定继续后、`turn_end` 之后调用，紧接下一个 turn 开始前。
	 * 返回替换用的 context/model/thinking 状态，或要追加到该 turn 的消息。
	 * 返回 undefined 表示继续用当前 context/config。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 返回要在 run 中途注入的插话（steering）消息。
	 *
	 * 在当前 assistant 回合执行完工具调用后调用（除非 `finishTurn` 已经结束 run）。
	 * 有消息则在下一次 LLM 调用前加入上下文。当前 assistant 消息里的工具调用不会被跳过。
	 *
	 * 用于在 agent 干活时“插话”。
	 *
	 * 契约：不得抛异常或 reject。没有插话时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回 agent 本该停下后要处理的 followUp 消息。
	 *
	 * 当 agent 既没有工具调用也没有插话消息时调用。
	 * 有消息则加入上下文，agent 再跑一个 turn。
	 *
	 * 用于必须等 agent 完成当前工作后才处理的后续消息。
	 *
	 * 契约：不得抛异常或 reject。没有 followUp 消息时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 工具执行方式。
	 * - "sequential"：一个接一个执行
	 * - "parallel"：先依次预检，再并发执行被允许的工具；每个工具定稿后按完成顺序发
	 *   `tool_execution_end`，随后按 assistant 源顺序发 tool-result 消息
	 *
	 * 默认："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 在工具执行前调用，此时参数已校验完毕。
	 *
	 * 返回 `{ block: true }` 阻止执行，循环会改为发一条错误工具结果。
	 * 被阻止的结果也可以设 `terminate: true`，参与批次的提前终止规则。
	 * 钩子会收到 agent 的 abort signal，需自行尊重它。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 在工具执行完成之后、`tool_execution_end` 与 tool-result 消息事件之前调用。
	 *
	 * 返回 `AfterToolCallResult` 可以覆盖执行结果的局部：
	 * - `content` 整块替换内容数组
	 * - `details` 整体替换 details
	 * - `isError` 替换错误标记
	 * - `usage` 替换工具结果用量
	 * - `terminate` 替换提前终止提示
	 *
	 * 未提供的字段保留原值，不做深合并。
	 * 钩子会收到 agent 的 abort signal，需自行尊重它。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 支持思考的模型的思考/推理档位。
 * 注意："xhigh" 与 "max" 只有部分模型家族支持。要判断具体模型是否支持，
 * 请用 @earendil-works/pi-ai 里的模型 thinking-level 元数据。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 可扩展的自定义应用消息接口。
 * 应用可通过 declaration merging（声明合并）扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空 —— 应用通过 declaration merging 扩展
}

/**
 * AgentMessage：LLM 消息与自定义消息的联合类型。
 * 该抽象允许应用添加自定义消息类型，同时保持类型安全并与基础 LLM 消息兼容。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * 公开的 agent 状态。
 *
 * `tools` 与 `messages` 用访问器属性实现，让实现能在存储前拷贝赋进来的数组。
 */
export interface AgentState {
	/**
	 * 当前系统提示，由 transcript 里的 system 消息回放得出。
	 *
	 * 只读：要改提示就得追加一条带 `content` 或 `sections` 的 system 消息。
	 * 在 `initialState` 里，它用来生成开头那条 system 消息。
	 */
	readonly systemPrompt: string;
	/** 后续回合使用的活动模型。 */
	model: Model<any>;
	/** 后续回合请求的推理档位。 */
	thinkingLevel: ThinkingLevel;
	/**
	 * 可执行的工具。赋值新数组会拷贝顶层数组。
	 *
	 * 与 transcript 里声明的工具集的差异，会在下一次请求前用一条 system 消息告知模型。
	 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/**
	 * 对话 transcript。赋值新数组会拷贝顶层数组。
	 *
	 * transcript 里的 system 消息承载提示与工具声明。
	 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * agent 正在处理 prompt 或继续请求时为 true。
	 *
	 * 会一直保持 true，直到 `agent_end` 的 await 监听器 settle。
	 */
	readonly isStreaming: boolean;
	/** 当前流式回复的部分 assistant 消息（若有）。 */
	readonly streamingMessage?: AgentMessage;
	/** 正在执行的工具调用 id。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或中止的 assistant 回合的错误信息（若有）。 */
	readonly errorMessage?: string;
}

/** 工具产出的最终或部分结果。 */
export interface AgentToolResult<T = JsonValue | undefined> {
	/** 返回给模型的文本或图片内容。 */
	content: (TextContent | ImageContent)[];
	/** 任意结构化信息，供日志或 UI 渲染使用。 */
	details: T;
	/**
	 * 匹配工具 `outputSchema` 的机器可读结果，供程序调用方使用。不会发给模型；
	 * 模型看到的结果仍是 `content`。
	 */
	structuredContent?: JsonValue;
	/** 工具本次执行自身的用量（若有）。不参与主 LLM 上下文的计量。 */
	usage?: Usage;
	/**
	 * 不抛异常地报告失败。模型会把 `content` 当作错误结果（与抛异常等效），
	 * 而 `details` 与 `structuredContent` 仍保留给 UI 和程序调用方。
	 */
	isError?: boolean;
	/**
	 * 提示 agent 在本批工具执行完后停下。
	 * 只有当批次里每个定稿的工具结果都把它设成 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/** 工具调用跑完钩子之后的最终结果。 */
export interface AgentToolCallOutcome {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
	/** `execute()` 的耗时，毫秒，单调时钟测量；工具未真正运行时不存在。 */
	durationMs?: number;
}

/**
 * 工具用来流式上报部分执行进度的回调。
 *
 * 回调绑定在当前 `execute()` 调用上。工具 promise settle 之后的调用会被忽略。
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/**
 * 参数 schema 为 `TParameters` 的工具的入参类型：pi-schema 的 `Static<TParameters>`
 * （构建器类型；常见 TypeBox 类型则取 TypeBox 的），其余为 `unknown`；`AgentTool<any>` 时为 `any`。
 */
export type AgentToolParams<TParameters> = IsAny<TParameters> extends true ? any : Static<TParameters>;

// `0 extends 1 & T` 对一个约束为 `object` 的 `T` 来说会过早解析；这种写法能等到参数具体化。
type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false;

/**
 * agent 运行时使用的工具定义。`parameters` 是任意 JSON Schema 对象；
 * `execute` 拿到的参数类型见 {@link AgentToolParams}。
 */
export interface AgentTool<TParameters extends object = object, TDetails = any> extends Tool<TParameters> {
	/** 给 UI 显示用的可读名称。 */
	label: string;
	/**
	 * 可选：在 schema 校验前对原始工具参数做兼容处理。
	 * 必须返回符合 `TParameters` 的对象。
	 */
	prepareArguments?: (args: unknown) => AgentToolParams<TParameters>;
	/**
	 * 成功结果里 `structuredContent` 的 JSON Schema。声明了它就应该总是设置 `structuredContent`。
	 */
	outputSchema?: object;
	/**
	 * 执行工具调用。失败就抛异常，或返回 `isError: true` 的结果；
	 * 不要只在 `content` 里描述失败。
	 */
	execute: (
		toolCallId: string,
		params: AgentToolParams<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/** 作用已有持久意图、但结果未知时的恢复策略。 */
	replay?: "never" | "safe";
	/**
	 * 单个工具的执行方式覆盖。
	 * - "sequential"：本工具必须与其他调用串行执行。
	 * - "parallel"：本工具可以与其他调用并发执行。
	 *
	 * 省略时使用默认执行方式。
	 */
	executionMode?: ToolExecutionMode;
}

/** 传给底层 agent 循环的上下文快照。 */
export interface AgentContext {
	/** 模型看得到的 transcript。 */
	messages: AgentMessage[];
	/** 本次 run 可执行的工具。 */
	tools?: AgentTool<any>[];
}

/**
 * Agent 发出的事件（供 UI 更新）。
 *
 * `agent_end` 是一次 run 发出的最后一个事件，但 `Agent.subscribe()` 里 await 它的监听器
 * 仍属于 run 的收尾范围：这些监听器跑完，agent 才算空闲。
 */
export type AgentEvent =
	// agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// turn 生命周期 —— 一个 turn = 一次 assistant 回复 + 它触发的工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期 —— 对 system、user、assistant、toolResult 消息都会发出
	| { type: "message_start"; message: AgentMessage }
	// 仅对 assistant 消息在流式过程中发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: any;
			isError: boolean;
			/** `execute()` 的耗时，毫秒，单调时钟测量；工具未真正运行时不存在。 */
			durationMs?: number;
	  };
