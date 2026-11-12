# packages/ 目录说明

这个仓库是一个 TypeScript monorepo，`packages/` 下有 **7 个包**，按"基础设施 → 能力 → 内核 → 应用"四层组织。依赖方向严格单向，没有循环。

---

## 1. 总览

| 目录 | npm 包名 | 行数 | 文件 | 测试文件 | 依赖的内部包 | 一句话 |
|---|---|---:|---:|---:|---|---|
| `coding-agent` | `@earendil-works/pi-coding-agent` | 45,931 | 148 | 223 | agent, ai, codemode, mcp | 完整编码 agent 后端：CLI、会话、工具、压缩、扩展、HTTP/RPC |
| `ai` | `@earendil-works/pi-ai` | 29,081 | 208 | 187 | schema, telemetry | 统一 LLM API：模型目录 + 15 个协议适配器（带 .lazy 壳） |
| `schema` | `@earendil-works/pi-schema` | 4,895 | 43 | 8 | — | 无 eval 的 JSON Schema 校验（draft 2020-12 + draft 7） |
| `mcp` | `@earendil-works/pi-mcp` | 4,774 | 28 | 14 | — | 独立 MCP 客户端（5 种传输 + 完整 OAuth） |
| `codemode` | `@earendil-works/pi-codemode` | 3,046 | 16 | 6 | — | QuickJS-WASI 沙箱里跑 JS，唯一能力是调工具 |
| `agent` | `@earendil-works/pi-agent-core` | 2,574 | 6 | 5 | ai, schema | agent 循环内核：状态、事件、队列、工具执行 |
| `telemetry` | `@earendil-works/pi-telemetry` | 1,638 | 8 | 6 | — | 与厂商无关的遥测契约 + metrics + 空/内存实现 |

行数与文件数只统计 `src/**/*.ts`（不含 `dist`、`node_modules`、`.d.ts`、测试）。

---

## 2. 依赖关系

箭头指向被依赖方。**注意 `coding-agent` 是唯一依赖超过一个内部包的目录**，其余都是叶子或多层单向链。

```
                        coding-agent
                    ┌───────┬───────┬───────┐
                    ▼       ▼       ▼       ▼
                  agent    mcp   codemode    ai
                    │                       │
                    └───────────┬───────────┘
                                ▼
                        ┌───────────────┐
                        ▼               ▼
                     schema        telemetry
```

实际依赖声明（来自各 `package.json`）：

```
coding-agent  →  pi-agent-core, pi-ai, pi-codemode, pi-mcp
agent         →  pi-ai, pi-schema
ai            →  pi-schema, pi-telemetry
schema        →  （无内部依赖）
mcp           →  （无内部依赖）
codemode      →  （无内部依赖）
telemetry     →  （无内部依赖）
```

`schema` / `telemetry` / `mcp` / `codemode` 四个包不依赖任何内部包，可以被别的项目单独引入。

---

## 3. 分层与构建顺序

| 层 | 包 | 换掉它意味着 |
|---|---|---|
| 基础设施 | `schema` `telemetry` | 换校验器 / 换遥测后端 |
| 协议与能力 | `ai` `mcp` `codemode` | 换 provider 生态 / 换工具协议 / 换代码沙箱 |
| 内核 | `agent` | 换 agent 循环（全仓库最"可移植"的 2.5k 行） |
| 应用 | `coding-agent` | 换产品形态（CLI / HTTP 服务 / RPC 宿主） |

根 `package.json` 的 `build` 脚本按依赖顺序串行构建，必须先底层后上层：

```
telemetry → schema → codemode → mcp → ai → agent → coding-agent
```

`src/` 之间通过 `tsconfig.json` 的路径别名直连，所以 tsc 类型检查不依赖构建产物；但**运行时**（测试、example、bundle）从 `dist/` 加载，改完 `src` 要重新构建。

---

## 4. 各包详解

### 4.1 `schema` — JSON Schema 校验（4,895 行）

职责：把 JSON Schema 编译成校验函数，**不使用 `eval` / `new Function`**，因此能在 workerd、CSP 严格的环境里运行。

| 文件 | 作用 |
|---|---|
| `compiler.ts` | 把 schema 编译成可复用的校验器 |
| `validator.ts` | 校验入口，返回结构化错误 |
| `resolver.ts` | `$ref` / `$defs` 解析 |
| `builders.ts` | 类型构建器 DSL |
| `typebox-static.ts` | `Static<T>` 类型推导 |
| `annotations.ts` / `checks.ts` | 注释关键字与断言关键字 |
| `coerce.ts` | 类型强制转换（如 `"1"` → `1`） |
| `explain.ts` | 校验失败的人类可读解释 |
| `formats/` | 约 40 个 `format` 断言：email、uuid、ipv4/ipv6、uri、duration、date-time、json-pointer、idn-hostname（含 punycode 实现）… |

公开出口：`@earendil-works/pi-schema`、`@earendil-works/pi-schema/formats`。

被谁用：`ai`（模型能力与工具参数 schema）、`agent`（`validateToolArguments` 的实际实现）。

### 4.2 `telemetry` — 遥测契约（1,638 行）

职责：只定义契约，不绑定后端。任何实现（OTel、自建、测试用内存版）都能接。

| 文件 | 作用 |
|---|---|
| `index.ts` | span / attribute 的事件契约 |
| `metrics.ts` | 计数器、直方图接口 |
| `memory.ts` | 内存实现（测试用） |
| `noop.ts` | 空实现（默认） |
| `render.ts` | 把 span 树渲染成可读文本 |
| `testing/` | 一致性测试套件：任何实现都要通过这些断言 |

公开出口：`@earendil-works/pi-telemetry`、`/render`、`/testing`。

被谁用：`ai`（记录每次请求的耗时与用量）。

### 4.3 `ai` — 模型层（29,081 行）

职责：**说哪种协议、发哪个 HTTP 请求**。它不管"什么时候问、问几次、失败了要不要重试"——那些在 `agent` 和 `coding-agent`。

| 目录/文件 | 作用 |
|---|---|
| `src/api/*.ts` | 43 个文件：28 个实现 + 15 个 `.lazy.ts` 懒加载壳 |
| `src/providers/*.ts` | 97 个文件，其中 43 个 `*.models.ts` 是各 provider 的模型清单 |
| `src/providers/faux.ts` | 官方假 provider，测试全用它 |
| `src/catalog/` | 44 个 provider 的定义源（`catalog/providers/*.ts`） |
| `src/auth/` | OAuth 与凭据解析 |
| `src/utils/event-stream.ts` | `EventStream` / `AssistantMessageEventStream`（agent 循环的事件传输） |
| `src/utils/retry.ts` | 重试策略（由上层调用，不在循环里） |
| `src/models.generated.ts` | **生成文件，不要手改** |
| `src/env-api-keys.ts` | provider → 环境变量名映射（如 `opencode-go` → `OPENCODE_API_KEY`） |
| `src/compat.ts` | 兼容出口：`streamSimple`、`getModel`、`clampThinkingLevel` |

支持的 API 协议（`src/api/` 里可见）：Anthropic Messages、OpenAI Completions / Responses、Azure OpenAI Responses、Google Generative AI / Vertex、AWS Bedrock Converse、Mistral Conversations、Cloudflare Workers AI、llama.cpp、OpenRouter Images、pi-messages 等。

公开出口很多，按需加载：`@earendil-works/pi-ai`、`/models`、`/compat`、`/providers/*`、`/api/*`、`/utils/*`、`/oauth` 等。

**两条硬规则**：

1. `src/models.generated.ts` 由 `catalog/` 生成，改模型数据要改 `catalog/providers/*.ts` 再跑生成脚本。
2. `src/providers/data/` 是 gitignore 的本地快照，不要提交。

### 4.4 `mcp` — MCP 客户端（4,774 行）

职责：Model Context Protocol 的完整客户端实现，与 pi 的其他部分解耦。

| 目录/文件 | 作用 |
|---|---|
| `client.ts` | 客户端主体：初始化、列工具、调工具 |
| `protocol/jsonrpc.ts` `protocol/types.ts` | JSON-RPC 与 MCP 类型 |
| `transports/` | `stdio` / `pipe` / `lines` / `in-memory` / `streamable-http`，与 `transport` 基类定义 |
| `oauth/` | 11 个文件：discovery、loopback、PKCE、provider、刷新、错误处理 |
| `input-schema.ts` | MCP 工具的 JSON Schema 转换 |
| `output-limit.ts` | 输出截断（防止一次读回几十 MB） |
| `naming.ts` | 工具名规范化（`mcp__<server>__<tool>`） |
| `testing/` | 假的 MCP server，供测试使用 |

公开出口：`@earendil-works/pi-mcp`、`/oauth`、`/testing`。唯一外部依赖是 `cross-spawn`。

被谁用：`coding-agent` 的 `src/extensions/mcp/`（把 MCP server 的工具挂进 agent）。

### 4.5 `codemode` — 沙箱代码模式（3,046 行）

职责：让模型**写一段 JS**，在 QuickJS-WASI 沙箱里执行，代码里唯一能做的事是调用已注册的工具。这比"一次一次调工具"省 token，也让模型能用循环/条件编排工具。

| 文件 | 作用 |
|---|---|
| `runtime/vm.ts` | QuickJS 实例与生命周期 |
| `runtime/host.ts` | 宿主侧能力桥（工具调用） |
| `runtime/protocol.ts` | 宿主与沙箱的消息协议 |
| `runtime/worker.ts` | workerd / Web Worker 变体 |
| `runtime/remote.ts` | 远程执行变体 |
| `runtime/prelude-source.ts` | 注入沙箱的前置脚本 |
| `declarations.ts` | 生成 TS 类型声明，让模型看到可调工具 |
| `wasm.ts` | WASM 模块加载 |

七个导出入口对应不同宿主：`. / declarations / source / portable / cloudflare / worker`。唯一依赖：`quickjs-wasi`。

被谁用：`coding-agent` 的 `src/extensions/codemode/`。

### 4.6 `agent` — 内核（2,574 行）

职责：**循环**。什么时候再问模型、什么时候执行工具、什么时候结束。这是整个仓库最值得读、也最容易移植的部分。

| 文件 | 行数 | 作用 |
|---|---:|---|
| `agent-loop.ts` | ~970 | 双层循环、流式回复、工具两段式执行、`length` 截断处理 |
| `agent.ts` | ~636 | `Agent` 类：状态、事件、steer/followUp 队列、`AbortController` |
| `types.ts` | ~550 | 全部契约：`StreamFn`、`AgentLoopConfig`、`AgentEvent`、`AgentTool` |
| `proxy.ts` | ~361 | 把 LLM 调用代理到服务端的 `StreamFn`（密钥不出服务端） |
| `stream-fn.ts` | 20 | 默认 `streamFn` 的注入槽位 |
| `index.ts` | 5 | 出口 |

三个必须记住的契约：

1. **`StreamFn`**：模型层唯一入口。可替换 = 可 mock = 可接任何 provider。失败**不得抛异常**，必须用 `stopReason: "error"/"aborted"` 的最终消息编码进流。
2. **`convertToLlm`**：`AgentMessage[] → Message[]` 的唯一转换点。不得抛异常。
3. **工具永不抛异常**：未知工具、参数非法、被权限钩子拦截、执行抛错，四种情况统一变成 `isError: true` 的工具结果。

`agent` 只依赖 `ai` 的**类型**与消息构造工具，不含任何 provider 代码——`stream-fn.ts` 的注释写明了这一点。

### 4.7 `coding-agent` — 应用层（45,931 行）

职责：把内核变成可用的产品。CLI、会话持久化、上下文压缩、工具、扩展、传输层全在这里。

| 目录 | 行数 | 文件 | 作用 |
|---|---:|---:|---|
| `src/core/` | 32,739 | 80 | 主体（见下表） |
| `src/extensions/` | 5,763 | 20 | 内置扩展实现：`codemode` / `mcp` / `tool-search` / `llama` |
| `src/utils/` | 2,714 | 27 | 路径、图片、shell、frontmatter 等杂项 |
| `src/modes/` | 2,004 | 7 | 传输层：`http`（`POST /prompt`、`GET /events`）、`rpc`（JSONL） |
| `src/cli/` | 501 | 4 | 参数解析 |
| `src/bun/` | 61 | 5 | Bun 专用（自带二进制运行时） |
| `src/experimental/` | 86 | 1 | `source-resolver.ts` |

`src/core/` 内的关键文件：

| 文件 | 行数 | 作用 |
|---|---:|---|
| `agent-session.ts` | ~4,540 | 应用编排：prompt 生命周期、压缩触发、重试、扩展绑定、树导航 |
| `session-manager.ts` | ~2,040 | 会话存储：追加式 entry 流 + projection 还原成 transcript |
| `settings-manager.ts` | ~1,470 | 全局 + 项目两级 `settings.json` 深度合并 |
| `resource-loader.ts` | ~1,120 | 发现 skills / extensions / prompts / AGENTS.md |
| `model-runtime.ts` | ~1,090 | 模型注册表 + 凭据解析（auth.json / 环境变量 / OAuth） |
| `compaction/compaction.ts` | ~1,104 | 压缩：切点选择、结构化摘要、增量更新 |
| `tools/` | 3,838 | 8 个内置工具：`read` `bash` `powershell` `edit` `write` `grep` `find` `ls` |
| `extensions/` | 4,551 | 扩展运行时（注册工具、命令、钩子） |
| `system-prompt.ts` | ~230 | 分节系统提示（`sections`，`content` 为空） |

公开出口：`@earendil-works/pi-coding-agent`（SDK）与 `/rpc-entry`；bin：`pi`。

---

## 5. 一次运行时的调用链

以 `session.prompt("...")` 为例，穿过全部四层：

```
coding-agent          examples/sdk/01-minimal.ts
  src/core/sdk.ts          createAgentSession()：装配 7 件事
  src/core/agent-session.ts prompt() → _preparePrompt() → _startRun()
        │
        ▼
agent                 Agent.prompt() → runWithLifecycle() → agent-loop.ts 的 runLoop()
        │                 ├─ prepareNextTurn / getSteeringMessages
        │                 ├─ prepareRequest
        │                 └─ streamAssistantResponse()
        ▼
ai                    streamFn 闭包（sdk.ts 注入）→ modelRuntime.streamSimple()
        │                 → src/api/<provider>.ts → 发 HTTP、解析 SSE
        │                 → utils/event-stream.ts 里 push 出 text_delta
        ▼
coding-agent          agent 事件 → AgentSession._handleAgentEvent → session 事件
                      → 你的 subscribe 回调
```

工具执行走另一条支线：`runLoop` → `executeToolCallsParallel` → `prepareToolCall`（`schema` 校验参数）→ `tool.execute()` → `afterToolCall` → `toolResult` 消息回填。

---

## 6. 已知的设计取舍与坑

**`agent-session.ts` 是一个 4,500 行的类。** 168 个成员、119 个私有字段。原因是四种运行模式（interactive / print / rpc / http）共用它，且这些能力共享同一份可变状态与不变量。阅读时只挑需要的位置（`constructor`、`agent.subscribe`、`beforeToolCall`/`afterToolCall`、`prepareRequest`、`finishTurn`、`transformContext`），不要通读。写同类系统时应该按关注点分文件，而不是照抄。

**生成文件不要手改。** `ai/src/models.generated.ts` 来自 `ai/catalog/providers/*.ts`；`ai/src/providers/data/` 是 gitignore 的本地快照。

**`.lazy.ts` 是懒加载壳。** `ai/src/api/*.lazy.ts` 让未被使用的 provider 不进 bundle。

**运行时依赖 `dist/`。** 路径别名让 tsc 能直连 `src`，但测试、example、bundle 都从 `dist/` 加载。改完源码要重新构建：

```powershell
npm run build:offline   # 跳过联网抓模型列表，构建全部包
```

`npm run build`（在线）会调用 `ai` 的 `generate-models`，需要访问 Vercel AI Gateway；网络不通时用 `build:offline`。

---

## 7. 常用命令

```powershell
# 全仓类型检查 + lint + 各类约束（不跑测试）
npm run check

# 构建全部包（离线；产物在 packages/*/dist）
npm run build:offline

# 只跑某个包的测试（在包目录下）
cd packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/agent-loop.test.ts

# 脚本自身的测试
npm run test:scripts
```

`npm run check` 包含：biome 格式与 lint、固定版本检查、运行时依赖声明检查、ts 相对导入检查、入口图体积预算、install-lock 校验、tsc。它**不跑测试**。

---

## 8. 建议的学习顺序

从内核往外，不要从 `coding-agent` 往里：

| 阶段 | 目标 | 入口 |
|---|---|---|
| A | 跑起来，看清装配 | `coding-agent/examples/sdk/01-minimal.ts` → `core/sdk.ts` |
| B | 读懂循环 | `agent/src/agent-loop.ts` 的 `runLoop` |
| C | 读懂状态与契约 | `agent/src/agent.ts` + `agent/src/types.ts` |
| D | 应用层 | `coding-agent/src/core/agent-session.ts`（只读装配段）→ `compaction/` → `session-manager.ts` |

`packages/` 之外的 `AGENT-CORE-学习指南.md` 有每个阶段的详细说明与验收题。
