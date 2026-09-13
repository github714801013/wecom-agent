# 速度优化调研记录：GitNexus 与当前工作区证据

## 调研范围

目标是判断最近请求是否普遍变慢，并定位端到端耗时来源。范围覆盖企业微信入口、敏感请求预检、MCP 工具加载与缓存、Pi 模型/工具循环、生命周期终态、回复队列与最终发送，以及 Planner 和旧外围路径是否仍参与实际请求。

## GitNexus 主查询与降级

- `list_repos` 可用，但索引列表未包含 `D:\\workplace\\typescript\\wecom-agent`。
- 对 `repo=D:\\workplace\\typescript\\wecom-agent` 执行 GitNexus `query` 返回：`Error: Repository is not available through this MCP server.`
- 因仓库未索引/当前服务不可用，按节点 `evidence_policy` 降级为当前工作区受限只读检索。
- 以下源码证据均标记：`source=local_search`、`authority=non_gitnexus`。
- 本记录不能证明完整调用图、完整影响范围、跨项目关系或完整消费者集合。

## 近期运行日志样本结论

当前工作区未发现可用于统计的近期运行日志文件；Docker Compose 仅配置日志行为，没有提供历史样本。因此目前无法判断请求是否“普遍慢”，也无法计算样本量、p50、p95 或 p99。现有源码中的 `console` 日志只能说明埋点位置，不能代替真实运行样本。

## 已确认事实

### 实际请求路径

- `src/wecom-adapter.ts:779` 起处理企业微信 bot 消息。
- `src/wecom-adapter.ts:812-814` 每条请求先执行 `judgeSensitiveRequestByModel`，正常请求也承担一次模型判断。
- `src/wecom-adapter.ts:1137-1155` 创建任务并发送处理中状态。
- `src/wecom-adapter.ts:1382-1452` 旧 Planner 仅在 `ENABLE_LEGACY_PLANNER === "true"` 且输入非空时执行。
- `src/wecom-adapter.ts:1542-1545` 默认路径明确记录 Pi 直接处理并跳过旧 Planner。
- `src/wecom-adapter.ts:1561-1562` 当前 `useFastPath`/`useDirectMatch` 硬编码为 `false`。
- `src/wecom-adapter.ts:1578-1585` 加载并按仓库范围筛选 MCP 工具，目前仅记录工具加载阶段耗时。
- `src/wecom-adapter.ts:1606` 初始化 Pi Agent。
- `src/wecom-adapter.ts:1629-1637` 执行 `streamPiEvents`。
- `src/wecom-adapter.ts:1640-1647` 只有 `agent_end` 且存在 stop 文本时才更新 `fullContent`。
- `src/wecom-adapter.ts:1755` 注释确认中间 assistant 文本不能作为最终正文。
- `src/wecom-adapter.ts:1778-1781` 仅记录整个 agent round 时长。
- `src/wecom-adapter.ts:2037-2043` 先 drain 回复队列，再发送最终消息。

### Pi Runtime

- `src/pi-agent-runtime.ts:104-134` 将 MCP 工具包装为 Pi 工具，工具调用通过 `withAbort` 执行。
- `src/pi-agent-runtime.ts:142-176` 创建 OpenAI Completions Pi 模型，工具执行模式为 sequential。
- `src/pi-agent-runtime.ts:354-425` 的 `streamPiEvents` 通过事件队列等待 `agent_end`，随后等待 Agent idle。
- `src/pi-agent-runtime.ts:381-390` 的 `agent_end` 日志只记录轮数、消息数和最终文本长度。
- `src/pi-agent-runtime.ts:360-379` 的轮次日志记录工具结果数、stopReason、内容块摘要和错误信息，但没有模型请求耗时。
- 当前未记录单次模型请求、单工具调用、队列等待或最终发送耗时。
- Pi 实际路径未设置工具总次数限制，正常终态仍只接受 `agent_end` 且 `stopReason === "stop"`。

### Planner、MCP 与缓存

- `src/graph.ts:64-77` 提供旧 Base Model。
- `src/graph.ts:124-175` 包含旧提示路由。
- `src/graph.ts:306-331` 的 `runPlanner` 会额外执行一次模型调用，但默认入口不执行旧 Planner。
- `src/graph.ts:1138` 起存在旧 search prelude；当前入口仅在旧 Planner 分支构造相关提示，未确认实际默认调用。
- `src/graph.ts:1526-1538` 读取业务提示并创建 Pi facade。
- `src/mcp-client.ts:32` 的 MCP Server 加载超时为 20000ms。
- `src/mcp-client.ts:271-307` 按 server 顺序连接并加载工具，首次加载为串行。
- `src/mcp-client.ts:333-335` 存在按 bot/header key 的 TTL cache 与 pending 合并，缓存命中可避免重复加载。

### 现有阶段打点缺口

当前已知打点主要位于：

- `src/wecom-adapter.ts:1189-1191`：通用阶段耗时。
- `src/wecom-adapter.ts:1578-1580`：MCP 工具加载耗时。
- `src/wecom-adapter.ts:1778-1781`：agent round 总耗时。
- `src/wecom-adapter.ts:2041`：总耗时附近的最终发送流程。

缺少统一 request id 关联的结构化记录，且未覆盖：

- 敏感请求预检耗时。
- 媒体解析耗时。
- MCP 单 server 连接/加载耗时与缓存命中率。
- 每轮模型响应耗时。
- 每个工具调用耗时。
- 回复队列排队和 drain 等待耗时。
- WeCom ack/网络发送耗时。
- 成功、超时、取消、错误的分类统计。

## 未确认项

- 当前部署中 `ENABLE_LEGACY_PLANNER` 的实际值。
- MCP cache 命中率、server 数量和各 server 连接耗时。
- Pi 每轮模型响应时长和工具耗时分布。
- 敏感请求预检是否占据显著比例。
- WeCom ack 与网络发送是否成为尾部延迟来源。
- 最近日志是否位于容器 stdout 或外部平台采集系统而非本地文件。
- `promptPromise` reject 且没有 `agent_end` 时事件队列是否会永久等待。
- generator 提前退出、已取消 signal、`agent.waitForIdle()` 与 deadline 之间的竞态。

## 优化优先级（方案，不实施）

1. **P0：先补真实可归因指标。** 增加脱敏的 request-scoped 结构化阶段采样，至少覆盖总耗时、敏感预检、媒体处理、MCP 加载、模型轮次、单工具、回复队列、最终发送、模型名、工具名、轮数和错误分类。不得记录问题正文、个人数据或凭据。采集真实样本后按正常/工具调用/多轮/超时/取消分层计算 n、p50、p95、p99。
2. **P1：针对确定性等待优化。** 根据 MCP 加载数据验证是否值得并行化 server load，或扩大预热/缓存；保持工具语义和 Pi 自主循环不变。
3. **P1：按模型和工具分布优化。** 只有数据证明某个工具或模型占主要尾部延迟时，才针对该调用优化。
4. **P2：再评估提示和上下文大小、重复工具调用或请求配置。** 不应恢复宿主审核重写、固定工具总次数限制或正则完成判定。

## 验证标准

- 至少获得建议 30 个正常请求，并按简单、工具调用、多轮请求分层。
- 输出成功、超时、取消、错误分组的 n、p50、p95、p99。
- 端到端总时长覆盖各阶段，阶段时长无负值且不重复计时。
- 能按模型、工具和轮次归因尾部延迟。
- 优化前后比较同类请求的 p95 和错误率。
- 确认 Pi 仍只在真实 `agent_end(stop)` 时发送正常终态，不设置工具总次数上限；敏感请求、取消和 TTL 行为无回归。

## 结论

当前证据不能证明系统普遍变慢，也不能指定模型、MCP 工具或回复发送为瓶颈。最小且可验证的下一步是补齐脱敏结构化阶段指标并采集真实样本；在数据出现前，不应通过恢复旧外围审核、增加宿主循环限制或凭经验调整 Pi 工具循环来“优化”。
