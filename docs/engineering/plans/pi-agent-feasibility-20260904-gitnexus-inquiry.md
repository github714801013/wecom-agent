# Pi 智能体替换可行性调研

## 结论

将当前项目的 Agent 部分精简为调用 Pi **技术上可行**，但不适合直接替换整个流程。Pi 应作为可插拔的底层 Agent 循环和流式模型执行内核；企业微信适配、MCP 管理、检索规划、证据治理、安全护栏、自动验证、会话续接和业务重写应继续保留在宿主侧。

## 当前项目事实

- `src/graph.ts` 使用 LangChain `createAgent`，并在 `initializeAgent()` 中通过 `wrapToolsWithReactLoopControl()` 注入查询预算和重复调用控制。
- `src/wecom-adapter.ts` 负责敏感请求预检、Planner、预检索、MCP 工具装配、Agent 流消费、工具证据记录、自动验证、最终评审、业务重写与企业微信流式回复。
- `src/mcp-client.ts` 负责 MCP SSE/HTTP transport、连接超时、工具缓存、Header/Profile、Repo Scope 与白黑名单。
- `src/session-manager.ts` 保存消息、Memory Graph、Repo/MCP Header、Human Loop、回复模式和计划恢复状态。
- 当前仓库未被 GitNexus 索引，本次代码事实来自工作区只读检查。

## Pi 已确认能力

依据 Pi 官方 README：

- `@earendil-works/pi-agent-core` 有状态 Agent，支持 `prompt()`、`continue()`、`abort()`、`waitForIdle()` 与 Agent/Turn/Message/Tool 生命周期事件。
- 工具通过 `AgentTool.execute(..., signal, onUpdate)` 执行，可通过 `beforeToolCall` / `afterToolCall` 阻断或改写结果；支持并行或串行工具执行。
- `pi-ai` 支持多 Provider 流式模型调用、文本/思考/工具调用事件及 `AbortSignal`。
- Pi 核心不内置 MCP，也没有独立的内置超时策略；工具连接、超时、安全与权限需要宿主实现。
- CLI/RPC 可作为跨进程集成边界，但默认继承启动进程权限，不能当作安全沙箱。

## 可替换与必须保留的边界

| 组件 | 是否适合改由 Pi 承担 | 说明 |
| --- | --- | --- |
| LangGraph `createAgent` 工具循环 | 是 | 可由 Pi Agent 与事件流替代。 |
| 模型 Provider 流式调用 | 是 | 可由 `pi-ai` 统一。 |
| 取消与 Agent 级截止时间 | 是，且应优先引入 | 使用 Pi `abort()` 与宿主 `AbortController`。 |
| MCP Transport / Header / Repo Scope | 否 | Pi 不内置 MCP，需继续使用现有 MCP 客户端或编写适配器。 |
| Planner / Agentic RAG / 查询改写 | 否 | 保留为 Pi 调用前的宿主流程。 |
| 工具预算、重复调用、证据过滤 | 否 | 继续保留并桥接到 Pi `AgentTool.execute()`。 |
| 敏感请求预检、SQL/证据审核、Human Loop | 否 | 属于业务和安全治理。 |
| 企微心跳、卡片、9 分钟流窗口、断点继续 | 否 | 必须留在 `wecom-adapter.ts` 宿主层。 |
| 会话 Memory Graph / 回复模式 | 否 | Pi 会话格式不能直接替代当前 SessionManager。 |

## 推荐最小迁移路线

1. 新建 `PiAgentAdapter`，只封装 Pi `Agent.prompt()`、事件订阅和 `abort()`；保留原 LangChain 后端作为 fallback。
2. 将现有 MCP `StructuredTool` 桥接为 Pi `AgentTool`，在 `execute()` 内继续使用已有 Header、Repo Scope、白黑名单、超时、`react-loop-control` 和 `agent-progress-guard`。
3. 将 Pi 的 `message_update`、工具开始/结束事件映射至现有工具记录、心跳和企业微信流式回复。
4. 宿主统一维护 9 分钟企微窗口、工具超时和自动验证的取消信号；不要依赖 Pi 提供不存在的 timeout 机制。
5. 通过 feature flag 只在简单问题或 `/dev` 模式灰度启用 Pi；保留当前 LangGraph Agent 作为默认与回退路径。

## 主要风险

- Pi 不内置 MCP：需要桥接和完整回归验证，不能直接删掉 `mcp-client.ts`。
- CLI/RPC 集成会丢失当前进程内工具、会话和取消语义；优先 SDK 内嵌，而非子进程调用。
- Pi 默认编码工具权限过宽：必须禁用内置工具或只显式注入白名单工具，并在容器/沙箱中运行。
- Pi 没有独立 timeout API：必须由宿主使用 `AbortController`、工具 deadline 与企业微信 TTL 驱动取消。
- 工具事件可能并行、乱序：现有工具调用映射、证据记录和最终回答保护需要保留。

## 建议

不建议“精简成直接调用 Pi CLI”。建议先做一个小范围 PoC：Pi SDK 内嵌 + 现有 MCP 工具桥接 + 简单问题灰度。只有验证取消、MCP Session 失效、工具预算、敏感拦截、Repo Scope、流过期恢复和业务回答保真后，再扩大替换范围。
