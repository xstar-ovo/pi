/**
 * 文件功能：agent 循环骨架 —— 全程用 AgentMessage，只在调 LLM 的边界转成 Message[]。
 *
 * 这一层是整个 agent 核心（阶段 B 的主角）。双层循环的结构：
 *   外层 while(true)           followUp：agent 本该停下，但有新任务就再来一轮
 *     内层 while(有工具调用 or 有待注入消息)
 *         prepareNextTurn → 注入消息 → prepareRequest → 流式回复
 *               → 执行工具 → finishTurn（可判停/判续）
 *     内层退出 = 没有工具调用且没有插话
 *     查 followUp → 有则 continue，无则 break
 *
 * 三个容易看漏的点：hasMoreToolCalls 初值为 true、轮询插话只有两处、
 * newMessages（本次增量）与 currentContext.messages（完整快照）不是同一东西。
 */

import {
	type AssistantMessage,
	type ClientIdentity,
	EventStream,
	getCurrentTools,
	getToolStateChanges,
	mergeClientIdentity,
	normalizeContext,
	PI_ATTRIBUTION,
	type SystemMessage,
	type ToolResultMessage,
	type ToolStateChanges,
	toToolDeclaration,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	PrepareNextTurnContext,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * agent 循环请求身份：在 pi-ai 默认值上把 provider attribution 设成 pi。
 * `AgentLoopConfig.identity` 会逐字段覆盖它。
 */
export const DEFAULT_AGENT_IDENTITY: ClientIdentity = { attribution: PI_ATTRIBUTION };

/**
 * 给一条新 prompt 启动 agent 循环。
 * prompt 会被加进上下文，并为它发出事件。
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * 从当前上下文接着跑循环，不新增消息。
 * 用于重试——上下文里已经是 user 消息或工具结果。
 *
 * **重要：**上下文最后一条消息经 `convertToLlm` 后必须是 `user` 或 `toolResult`，
 * 否则 LLM provider 会拒绝请求。这里无法校验，因为 `convertToLlm` 每轮只调一次。
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const initialMessages = declareToolChanges(context, prompts);
	const newMessages: AgentMessage[] = [...initialMessages];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...initialMessages],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const message of initialMessages) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * agentLoop 与 agentLoopContinue 共用的主循环逻辑。
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let explicitContinuation = false;
	// 进入前先查插话消息（用户可能在等待期间已经输入）
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// 外层循环：agent 本该停下，但队列里来了 followUp 消息时再来一轮
	while (true) {
		let hasMoreToolCalls = true;

		// 内层循环：处理工具调用与插话消息
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			let preparedMessages: AgentMessage[] = [];
			if (lastCompletedTurn) {
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					preparedMessages = nextTurnSnapshot.messages ?? [];
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				// 准备阶段可能很耗时（例如压缩）。把期间排入的插话取出来。
				// 仅在上一次轮询什么都没拿到时才再轮询一次；否则“一次只投一条”模式
				// 会在这个 turn 里投递两条消息。
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				await emit({ type: "turn_start" });
			}

			// 在下一次 assistant 回复前，处理准备好的与排队的消息。
			for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				currentContext.messages.push(message);
				newMessages.push(message);
			}
			pendingMessages = [];

			const requestUpdate = await config.prepareRequest?.(
				{
					context: currentContext,
					model: config.model,
					thinkingLevel: config.reasoning ?? "off",
				},
				signal,
			);
			if (requestUpdate) {
				currentContext = requestUpdate.context ?? currentContext;
				config = {
					...config,
					model: requestUpdate.model ?? config.model,
					reasoning:
						requestUpdate.thinkingLevel === undefined
							? config.reasoning
							: requestUpdate.thinkingLevel === "off"
								? undefined
								: requestUpdate.thinkingLevel,
				};
			}

			// 流式获取 assistant 回复
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				lastCompletedTurn = {
					message,
					toolResults: [],
					context: currentContext,
					newMessages,
				};
				await config.finishTurn?.(lastCompletedTurn, signal);
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 检查工具调用
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// "length" 停止意味着输出被 token 上限截断，消息里每个工具调用的参数
				// 都可能不完整。整批失败，而不是去执行可能坏掉的调用。
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const decision = await config.finishTurn?.(lastCompletedTurn, signal);
			await emit({ type: "turn_end", message, toolResults });

			if (decision?.action === "end") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			explicitContinuation = decision?.action === "continue";
			pendingMessages = (await config.getSteeringMessages?.()) || [];
			if (hasMoreToolCalls || pendingMessages.length > 0) {
				explicitContinuation = false;
			}
		}

		// agent 本该停在这里。检查 followUp 消息。
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// 当作待处理消息，让内层循环去处理
			explicitContinuation = false;
			pendingMessages = followUpMessages;
			continue;
		}

		// 没有自然请求被选中，用一次只跑上下文的 turn 来兑现继续决定。
		if (explicitContinuation) {
			explicitContinuation = false;
			continue;
		}

		// 没有更多消息，退出
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 向模型声明工具集的变化。
 *
 * `context.tools` 是运行时实际能执行的工具集；transcript 里的 system 消息声明的是模型可以调什么。
 * 每次请求前，两者的差异会变成 system 消息上的 `toolsAdded` 与 `toolsRemoved`。
 * 若已有待处理的 system 消息，它的工具字段被视为“意图”，会被替换成
 * “已提交 transcript 与可执行集”之间的差异，使回放结果始终恰好等于 `context.tools`。
 * 否则就在第一个非 system 的待处理消息前插入一条新的 system 消息。
 */
function declareToolChanges(context: AgentContext, pendingMessages: AgentMessage[]): AgentMessage[] {
	let systemIndex = -1;
	for (let i = pendingMessages.length - 1; i >= 0; i--) {
		if (pendingMessages[i].role === "system") {
			systemIndex = i;
			break;
		}
	}
	const pending = pendingMessages[systemIndex] as SystemMessage | undefined;
	const baseline = pending
		? pendingMessages.map((message, index) =>
				index === systemIndex ? withToolChanges(pending, NO_CHANGES) : message,
			)
		: pendingMessages;
	const changes = getToolStateChanges(
		getCurrentTools([...context.messages, ...baseline]),
		(context.tools ?? []).map(toToolDeclaration),
	);
	const unchanged = changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;

	if (pending) {
		// 调用方的消息本就没声明工具变化时，直接复用它的对象。
		if (unchanged && !pending.toolsAdded?.length && !pending.toolsRemoved?.length) return pendingMessages;
		return baseline.map((message, index) => (index === systemIndex ? withToolChanges(pending, changes) : message));
	}
	if (unchanged) return pendingMessages;
	const update = withToolChanges({ role: "system", content: "", timestamp: Date.now() }, changes);
	const insertIndex = pendingMessages.findIndex((message) => message.role !== "system");
	const index = insertIndex === -1 ? pendingMessages.length : insertIndex;
	return [...pendingMessages.slice(0, index), update, ...pendingMessages.slice(index)];
}

const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };

/** 复制一条 system 消息并把工具字段换成 `changes`；列表为空时省略该字段。 */
function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved }: ToolStateChanges): SystemMessage {
	const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
	return {
		...rest,
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
	};
}

/**
 * 从 LLM 流式获取一条 assistant 回复。
 * AgentMessage[] 就在这里被转成 LLM 需要的 Message[]。
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// 按配置应用上下文变换（AgentMessage[] → AgentMessage[]）
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// 转成 LLM 可用的消息（AgentMessage[] → Message[]）
	const llmMessages = await config.convertToLlm(messages);

	const llmContext = normalizeContext({ messages: llmMessages });

	// 解析 API key（对会过期的 token 很重要）
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		identity: mergeClientIdentity(DEFAULT_AGENT_IDENTITY, config.identity),
		signal,
	});
	// 无论最终是哪个 stream 函数作答，都把本次请求的档位记下来。
	const result = async () => Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * 把被输出 token 上限截断的 assistant 消息里的工具调用全部判为失败。
 * 流式下发的工具参数是用“尽力而为的 JSON 打捞解析”最终化出来的，所以被截断的消息
 * 可能产出参数能解析、能过校验、但其实不完整的调用。它们没有一个可以安全执行；
 * 逐个报成错误，让模型重新发起。
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * 执行一条 assistant 消息里的工具调用。
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			if (signal?.aborted) {
				const finalized = {
					toolCall,
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				} satisfies FinalizedToolCallOutcome;
				await emitToolExecutionEnd(finalized, emit);
				return finalized;
			}
			const executed = await executePreparedToolCall(preparation, signal, emitToolExecutionUpdate(toolCall, emit));
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	durationMs: number;
};

type FinalizedToolCallOutcome = AgentToolCallOutcome;

/** `AgentLoopConfig` 里的 `beforeToolCall` / `afterToolCall` 两个钩子。 */
export type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall">;

type ToolUpdateSink = (partialResult: AgentToolResult<any>) => Promise<void> | void;

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

function emitToolExecutionUpdate(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
	return (partialResult) =>
		emit({
			type: "tool_execution_update",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
			partialResult,
		});
}

/** {@link runToolCall} 的选项。 */
export interface RunToolCallOptions extends ToolCallHooks {
	/** 调用要解析到的工具集合。 */
	tools: readonly AgentTool<any>[];
	/** 作为“发起该调用的消息”传给钩子。 */
	assistantMessage: AssistantMessage;
	/** 作为“当前 agent 上下文”传给钩子。 */
	context: AgentContext;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateSink;
}

/**
 * 让一个工具调用走完与“模型发起”完全相同的步骤：参数预处理、schema 校验、
 * `beforeToolCall`、执行、`afterToolCall`。不发出事件，也不添加消息。
 * 工具里再调工具时用它，这样钩子（例如权限校验）对那些调用同样生效。
 *
 * 工具失败时永不 reject：未知工具、校验错误、被拦截、抛异常都返回 `isError: true`。
 */
export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, options.tools);
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	const executed = await executePreparedToolCall(preparation, signal, options.onUpdate ?? (() => {}));
	return finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;
	const startedAt = performance.now();
	const elapsed = () => Math.round(performance.now() - startedAt);

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(Promise.resolve(onUpdate(partialResult)));
			},
		);
		const durationMs = elapsed();
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: result.isError === true, durationMs };
	} catch (error) {
		const durationMs = elapsed();
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
			durationMs,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				// 结构化内容没跟着 content 一起换，就可能已经不匹配了。
				const structuredContent =
					afterResult.structuredContent ?? (afterResult.content ? undefined : result.structuredContent);
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				if (structuredContent === undefined) delete result.structuredContent;
				else result.structuredContent = structuredContent;
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
		durationMs: executed.durationMs,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
		...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// 无类型的工具（JS 扩展）可能返回没有 content 的结果；这里统一归一化，
		// 让 null 永远不会进入会话历史或 provider 请求。
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		isError: finalized.isError,
		...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
