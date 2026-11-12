# pi agent 核心学习指南（后端，无前端）

目标：把 agent 核心读到能自己改、能对照移植到 Python/LangGraph 的程度。
范围：`packages/ai`（模型层）→ `packages/agent`（循环层）→ `packages/coding-agent`（应用层）→ `modes`（传输层）。

---

## 0. 先认清四层，不然会看串

```
ai            模型抽象：Model / Message 类型 / 流式事件 / provider adapter   （30k 行）
agent         循环：把 messages 喂给模型，执行工具，再喂回去                 （2.5k 行）  ← 核心中的核心
coding-agent  应用：会话文件、压缩、技能、扩展、CLI                          （48k 行）
modes         传输：http（POST /prompt、GET /events）、rpc（JSONL）          （1.4k 行）
```

学习顺序必须**从内到外**：先 `agent`，再回去看 `ai`（只看用到的部分），最后 `coding-agent`。
反过来读会在 4000 行的 `agent-session.ts` 里淹死。

---

## 1. 四阶段学习路线

### 阶段 A：跑起来（1–2 小时）

```powershell
cd D:/Desktop/pi
npm install --ignore-scripts
npm run build          # examples 从 dist/ 导入，必须先构建

cd packages/coding-agent
$env:ANTHROPIC_API_KEY="..."     # 或任何一家
node --experimental-strip-types examples/sdk/01-minimal.ts
```

| 例子 | 学到什么 |
|---|---|
| `examples/sdk/01-minimal.ts` | 全部走默认：自动发现技能/工具/设置，`session.prompt()` + `subscribe()` |
| `02-custom-model.ts` | `ModelRuntime` 选模型 + `thinkingLevel` |
| `05-tools.ts` | 工具白名单、`SessionManager.inMemory()` |
| `12-full-control.ts` | 全手工装配：model + settings + ResourceLoader，这是"看得见每个零件"的入口 |

**验收**：说清 `session.prompt("...")` 到 `text_delta` 事件出现之间，代码走了哪几个文件。

### 阶段 B：循环（半天，`packages/agent/src/agent-loop.ts`）

只读这一个文件的 `runLoop` / `streamAssistantResponse` / `executeToolCalls*`。
**验收**：
1. 为什么是双层 `while`？哪一行决定"再问模型一次"，哪一行决定"整个 run 结束"？
2. 工具并行执行时，为什么工具结果消息仍严格按 assistant 消息里的顺序排列？
3. `stopReason === "length"` 时为什么一个工具都不执行？

### 阶段 C：状态与契约（1 天，`agent.ts` + `types.ts`）

`Agent` 类只是把 `runLoop` 包了一层：持有 transcript、发事件、管队列、管 abort。
两个必须背下来的契约：
- `StreamFn`：模型层的唯一入口（可替换 = 可 mock = 可接任何 provider）
- `convertToLlm`：AgentMessage[] → Message[] 的唯一转换点

**验收**：能说清"用户在 agent 干活时又发一条消息"会发生什么（steer 队列、轮询点、为什么只在特定位置轮询）。

### 阶段 D：应用层（2–3 天）

按这个顺序，别按目录顺序：

1. `core/agent-session.ts` — 只看 `prompt()`、`subscribe()`、压缩/重试触发点（4000 行里只读约 300 行）
2. `core/compaction/compaction.ts` — 触发条件、切点、摘要、增量更新
3. `core/session-manager.ts` — entry 类型 → projection（这里解释"C/R （checkpoint）和会话树"的差别）
4. `core/tools/*` — 工具怎么写（`read.ts` 最好读，338 行）
5. `core/messages.ts` — `convertToLlm` 真实实现：自定义消息如何降级成 user 消息

---

## 2. 三个必背概念

### 2.1 两次消息转换

```
AgentMessage[]  ──transformContext──▶  AgentMessage[]  ──convertToLlm──▶  Message[]  ──▶ provider
   (应用层可以有            (裁剪/压缩/注入，           (LLM 只认 4 种角色：
    自定义角色)              不改存储)                   system/user/assistant/toolResult)
```

- `AgentMessage` 是"应用态"，可以有 `bashExecution`、`custom`、`compactionSummary`、`branchSummary` 等角色（见 `coding-agent/src/core/messages.ts`）。
- LLM 只认 4 种角色，所以每次请求前必须收敛。
- 为什么值得学：**你自己在 Python 侧加"工具执行卡片""系统通知"这类消息时，同样需要这一层**，否则只能塞进 content 字符串，最后被 trim 截断。

### 2.2 turn 的定义

一个 **turn** = 一次 assistant 回复 + 它触发的全部工具结果。`turn_end` 之后才检查：
队列里有没有插话（steering）、有没有追加任务（followUp）、压缩要不要做。

`runLoop` 的双层结构：

```
外层 while(true)          ← followUp：agent 本该停下，但有新任务就再来一轮
  内层 while(有工具调用 或 有待注入消息)
      prepareNextTurn → 注入消息 → prepareRequest → 流式回复
      → 执行工具 → finishTurn(finishTurn 可判停/判继续)
  内层退出 = 没有工具调用且没有插话
  查 followUp → 有则 continue，无则 break
```

### 2.3 EventStream 是"推"不是"拉"

`ai/src/utils/event-stream.ts` 的 `EventStream`：生产者 `push(event)`，消费者 `for await`，
最终值走 `result()`。`agent_end` 事件既充当"流结束标记"又携带最终消息数组。

这解释了一件容易困惑的事：**abort 不是抛异常**，而是产出一个 `stopReason: "aborted"` 的 assistant 消息，
然后正常走完 `turn_end` / `agent_end`。下游永远看到一致的事件序列。

---

## 3. 逐段代码讲解

### 3.1 `runLoop` —— 全部逻辑的骨架

```ts
let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

while (true) {                       // 外层：followUp 存在时再跑一轮
    let hasMoreToolCalls = true;     // 初值 true：保证至少请求一次模型

    while (hasMoreToolCalls || pendingMessages.length > 0) {
        // ① 上一轮结束后的收尾准备（压缩、换模型都在这里做）
        if (lastCompletedTurn) {
            const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
            ...
            if (pendingMessages.length === 0) {          // 只在队列空时再轮询插话
                pendingMessages = (await config.getSteeringMessages?.()) || [];
            }
            await emit({ type: "turn_start" });
        }

        // ② 工具集变化声明 + 注入待处理消息
        for (const message of declareToolChanges(currentContext, [...preparedMessages, ...pendingMessages])) {
            await emit({ type: "message_start", message });
            await emit({ type: "message_end", message });
            currentContext.messages.push(message);
            newMessages.push(message);
        }
        pendingMessages = [];

        // ③ 每次请求前的最后修改机会（含第一次）
        const requestUpdate = await config.prepareRequest?.({ context: currentContext, model: config.model, thinkingLevel: config.reasoning ?? "off" }, signal);

        // ④ 真正请求模型
        const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
        newMessages.push(message);

        // ⑤ hard exit：错误/中断不再轮询队列，直接结束
        if (message.stopReason === "error" || message.stopReason === "aborted") { ... return; }

        // ⑥ 执行工具
        if (toolCalls.length > 0) {
            const executedToolBatch = message.stopReason === "length"
                ? await failToolCallsFromTruncatedMessage(toolCalls, emit)   // 参数可能被截断，一律失败
                : await executeToolCalls(currentContext, message, config, signal, emit);
            hasMoreToolCalls = !executedToolBatch.terminate;                 // 全部工具都说"该停"才停
        }

        // ⑦ 回合收尾，决策是否继续
        const decision = await config.finishTurn?.(lastCompletedTurn, signal);
        await emit({ type: "turn_end", message, toolResults });

        explicitContinuation = decision?.action === "continue";
        pendingMessages = (await config.getSteeringMessages?.()) || [];
        if (hasMoreToolCalls || pendingMessages.length > 0) explicitContinuation = false;  // 有活干就不用"强行再来一次"
    }

    // ⑧ 内层退出：查 followUp，无则结束
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) { explicitContinuation = false; pendingMessages = followUpMessages; continue; }
    if (explicitContinuation) { explicitContinuation = false; continue; }
    break;
}
await emit({ type: "agent_end", messages: newMessages });
```

三个容易看漏的点：

- **`hasMoreToolCalls` 初值 true**：不这样写，"第一次请求"就没有驱动源。
- **轮询点只有两处**（循环顶部 prepareNextTurn 之后、每轮 tool 之后）：插话不是"随时能塞进上下文"，
  必须在 turn 边界注入，否则 transcript 会出现 assistant/tool 消息交错破坏配对。
- **`newMessages` vs `currentContext.messages`**：前者是本次 run 的增量（返回值），后者是完整快照。
  外部 UI 追加、上下文裁剪都只作用于 `currentContext`，不影响"这次运行产生了什么"。

### 3.2 `streamAssistantResponse` —— partial 消息就地替换

```ts
const response = await streamFunction(config.model, llmContext, { ...config, apiKey, signal });

for await (const event of response) {
    switch (event.type) {
        case "start":
            partialMessage = event.partial;
            context.messages.push(partialMessage);     // 半成品一开始就进 transcript
            addedPartial = true;
            break;
        case "text_delta": case "thinking_delta": case "toolcall_delta": ...
            partialMessage = event.partial;
            context.messages[context.messages.length - 1] = partialMessage;   // 同一个位置不断替换
            await emit({ type: "message_update", assistantMessageEvent: event, ... });
            break;
        case "done": case "error": {
            const finalMessage = await result();
            context.messages[context.messages.length - 1] = finalMessage;     // 用最终消息收尾
            await emit({ type: "message_end", message: finalMessage });
            return finalMessage;
        }
    }
}
```

为什么这么写：流式期间 UI 需要一条"还没写完的消息"，但 transcript 里不能出现重复。
用**固定位置替换**而不是 append，保证任何时刻 transcript 只有一条该 assistant 消息。

对照组：你在 Python 侧用 `agent.astream_events()` 是事件流出来自己拼，LangGraph 的 state 里始终没有半成品消息，
所以"刷新页面能恢复流到一半的内容"这类功能需要自己补。

### 3.3 并行执行工具，结果仍按顺序

```ts
async function executeToolCallsParallel(...) {
    for (const toolCall of toolCalls) {          // 第一段：串行 prepare
        await emit({ type: "tool_execution_start", ... });
        const preparation = await prepareToolCall(...);   // 含 beforeToolCall（权限校验就在这里）
        if (preparation.kind === "immediate") { ...continue; }   // 未知工具/参数非法：立即产出错误结果
        finalizedCalls.push(async () => {                 // 第二段：给每个工具一个闭包
            const executed = await executePreparedToolCall(...);
            const finalized = await finalizeExecutedToolCall(...);   // 含 afterToolCall
            await emitToolExecutionEnd(finalized, emit);
            return finalized;
        });
    }
    const orderedFinalizedCalls = await Promise.all(finalizedCalls.map(f => f()));   // 并发执行
    for (const finalized of orderedFinalizedCalls) {                                 // 按源顺序发 toolResult
        await emitToolResultMessage(createToolResultMessage(finalized), emit);
    }
}
```

**为什么必须两段式**：LLM API 要求 `tool_result` 严格跟随对应的 `tool_calls`，且顺序敏感。
所以"执行可以并发，落消息必须按源顺序"。`tool_execution_end` 走完成顺序（实时反馈），
`tool_result` 消息走源顺序（协议正确），两者故意不同步。

### 3.4 `prepareToolCall` —— 三条 error 路径

```ts
const tool = tools.find(t => t.name === toolCall.name);
if (!tool) return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };

try {
    const validatedArgs = validateToolArguments(tool, prepareToolCallArguments(tool, toolCall));
    const beforeResult = await config.beforeToolCall?.({ assistantMessage, toolCall, args: validatedArgs, context }, signal);
    if (beforeResult?.block) return { kind: "immediate", result: createErrorToolResult(beforeResult.reason ?? "blocked"), isError: true };
    return { kind: "prepared", toolCall, tool, args: validatedArgs };
} catch (error) {
    return { kind: "immediate", result: createErrorToolResult(String(error)), isError: true };
}
```

关键设计：**工具层永远不抛异常**。未知工具、参数不合法、被权限 hook 拦截、执行抛错——
四种情况统一变成 `isError: true` 的工具结果，模型能看到错误并自己修正。
这比"抛给上层""上层再决定怎么告诉模型"简单得多，也解释了为什么 `AgentToolResult.isError` 是可选字段而不是异常。

### 3.5 `finalizeExecutedToolCall` —— 字段级覆盖

```ts
if (afterResult) {
    const structuredContent = afterResult.structuredContent ?? (afterResult.content ? undefined : result.structuredContent);
    result = {
        ...result,
        content: afterResult.content ?? result.content,
        details: afterResult.details ?? result.details,
        usage: afterResult.usage ?? result.usage,
        terminate: afterResult.terminate ?? result.terminate,
    };
    if (structuredContent === undefined) delete result.structuredContent;
    else result.structuredContent = structuredContent;
}
```

一个细节能看出设计水平：**改写了 `content` 却没说 `structuredContent` 时，结构化内容被丢弃**。
理由写在注释里：两者可能已经不一致。这是"宁可丢信息也不留脏数据"的取舍。

### 3.6 `Agent.runWithLifecycle` —— 失败也必须走完整事件序列

```ts
private async runWithLifecycle(executor) {
    if (this.activeRun) throw new Error("Agent is already processing.");
    const abortController = new AbortController();
    this.activeRun = { promise, resolve, abortController };
    this._state.isStreaming = true;
    try { await executor(abortController.signal); }
    catch (error) { await this.handleRunFailure(error, abortController.signal.aborted); }   // 合成一条 error assistant 消息
    finally { this.finishRun(); }
}
```

`handleRunFailure` 会伪造一条 `stopReason: "error"/"aborted"` 的 assistant 消息，然后照常发
`message_start → message_end → turn_end → agent_end`。
**推论**：下游（HTTP/SSE/UI）不需要 try/catch，只要处理事件序列。这是对"事件流消费方简单"的取舍。

### 3.7 `EventStream`（`ai/src/utils/event-stream.ts`）

```ts
push(event) {
    if (this.isComplete(event)) { this.done = true; this.resolveFinalResult(this.extractResult(event)); }
    const waiter = this.waiting.dequeue();
    if (waiter) waiter({ value: event, done: false });   // 有消费者在等 → 直接给它（无排队）
    else this.queue.enqueue(event);
}

async *[Symbol.asyncIterator]() {
    while (true) {
        if (this.queue.length) yield this.queue.dequeue()!;
        else if (this.done) return;
        else { const result = await new Promise(resolve => this.waiting.enqueue(resolve)); if (result.done) return; yield result.value; }
    }
}
```

一个 117 行的类解决三件事：生产者与消费者解耦、最终结果可通过 `result()` 单独 await、
结束后不丢已入队事件。**自己用 async generator 手写这个非常容易写出丢事件或死锁。**

### 3.8 压缩如何触发（`coding-agent/src/core/compaction/compaction.ts`）

```ts
export function shouldCompact(contextTokens, contextWindow, settings) {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;   // 默认 reserve 16k
}
```

上下文 token 来源不是估算，而是**上一次 assistant 消息的真实 usage**：

```ts
export function estimateContextTokens(messages) {
    const usageInfo = getLastAssistantUsageInfo(messages);      // 找最后一条有 usage 的 assistant
    if (!usageInfo) { /* 全量 chars/4 估算 */ }
    let trailingTokens = 0;
    for (let i = usageInfo.index + 1; i < messages.length; i++) trailingTokens += estimateTokens(messages[i]);
    return { tokens: calculateContextTokens(usageInfo.usage) + trailingTokens, ... };   // 真实值 + 尾部估算
}
```

切点必须落在"回合可切的位置"（`findValidCutPoints`：user / assistant / bashExecution / custom / summary，
**绝不在 toolResult 上切**），并保留约 `keepRecentTokens`（20k）。

摘要用结构化模板（Goal / Constraints / Progress / Key Decisions / Next Steps / Critical Context），
已有摘要时走**增量更新**（`UPDATE_SUMMARIZATION_PROMPT`：保留旧信息、移动 In Progress → Done），
而不是每次重头总结。`stopReason === "length"` 的摘要被判定失败、不入库（不完整的摘要比没有更糟）。

---

## 4. 对照你的 Python/LangGraph 项目

| pi 概念 | 位置 | LangGraph 对应物 | 你的现状 |
|---|---|---|---|
| `StreamFn` 契约 | `agent/src/types.ts` | `ChatOpenAI` + `.astream()` | `config/llm_config.py`，已实现但不可替换 |
| `runLoop` 双循环 | `agent-loop.ts` | `create_agent` 内部的 graph 循环 | 框架内，不暴露 |
| `beforeToolCall` / `afterToolCall` | `agent-loop.ts` | `wrap_tool_call` 中间件 | 未使用（只在 `trim.py` 用了 `wrap_model_call`） |
| `transformContext` | `agent-loop.ts` | `wrap_model_call` 改 request.messages | `middleware/trim.py` |
| `convertToLlm` | `coding-agent/src/core/messages.ts` | 无对应（LangChain 消息类型直接进 state） | 无 |
| `tool_execution_update` | `agent-loop.ts` | 工具内回调 | 无 |
| steer / followUp 队列 | `agent/src/agent.ts` | 无内建 | 无 |
| `abort()` + AbortSignal | `agent.ts` / `agent-loop.ts` | 取消 task | 无 |
| 压缩 `shouldCompact` | `compaction.ts` | `SummarizationMiddleware` | 自研 `trim.py`（只丢不压） |
| 会话 entry + projection | `session-manager.ts` | checkpointer | thread 线性历史 |
| `declareToolChanges` | `agent-loop.ts` | 无 | 无（工具集固定） |

最值得抄的三件事：
1. **"工具永不抛异常"约定**（3.4）——你的 `judge_tool_status` 已经在做一半，可以统一。
2. **两次消息转换**（2.1）——解决自定义消息被 trim 吃掉的问题。
3. **压缩用真实 usage 触发**（3.8）——你现在用字符估算，中文场景误差一倍。

---

## 5. 调试技巧

- 想看完整事件序列：在 `packages/agent/src/agent.ts` 的 `processEvents` 打一行 `console.log(event.type)`。
- 想换假模型跑离线测试：`ai/src/providers/faux.ts`（672 行）就是官方 faux provider，测试全用它。
- 想知道某次 run 用了多少 token：`agent_end` 的 messages 里每条 assistant 都有 `usage`
  （`input/output/cacheRead/cacheWrite/totalTokens/cost`）。
- 想看真实的工具调用参数校验：`validateToolArguments`（`ai` 包），它决定"LLM 给了错参数"变成工具错误而不是崩溃。

## 6. 常见误解

- **"`agent-loop.ts` 里 streamFn 会重试"**：不会。重试在 `ai/src/utils/retry.ts`，由 session 层调用（`retryAssistantCall`）。
- **"`context.messages` 就是发给模型的消息"**：不是。发之前必经 `transformContext` + `convertToLlm`。
- **"工具并行 = 结果也乱序"**：不是，见 3.3。
- **"压缩会删历史"**：不会。压缩产生一条 `compactionSummary` entry，原消息仍在会话文件里，projection 才决定模型看到什么。
- **"`tools` 是常量"**：不是。`AgentState.tools` 可在运行时改，差异通过 `declareToolChanges` 以 system 消息告知模型。
