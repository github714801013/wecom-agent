# timeout-recovery GitNexus 调研记录

## 范围与取证方式

- 任务：`timeout-recovery`
- 范围：当前工作区 `D:\workplace\typescript\wecom-agent`
- GitNexus 主查询：`list_repos` 返回 35 个已索引仓库，其中不含本工作区；随后执行 `query(repo="wecom-agent")` 返回 `Repository is not available through this MCP server.`，判定为 **repository_unindexed**。
- 按 fallback 规则改用受限本地检索，证据标记 `source=local_search`、`authority=non_gitnexus`。
- 未发现文件名前缀等于 `timeout-recovery` 的既有规格文档。

## 缺陷现象（来自测试环境容器日志）

- 部署后 16 次请求：7 次以 `requestTimeoutMs` 上限被中止，`errorCategory=pi_agent_end_stop_text_missing`，`piModelRoundMs` 均约 480004ms。
- 失败请求 `turns` 为 30/33/35/36/42/43/52；391 个 `turn_end` 中 `stopReason` 为 `toolUse` 377 次、`stop` 仅 5 次，仅 10 轮产出过文本。
- 每轮耗时中位 10.0s、p90 22.0s，且不随轮次增长；成功请求也达 285s/467s。
- 16 次请求约 577 次工具调用，无并发排队（`agentQueueMs=0`）。

## 代码接缝定位（本地检索，非 GitNexus）

### 1. 截止与中止

- `src/config.ts:43`：`requestTimeoutMs` 默认 480000。
- `src/wecom-adapter.ts:2154`：以 `deadlineMs: config.llm.requestTimeoutMs` 传入 Pi 流。
- `src/pi-agent-runtime.ts:455-468`：`abort()` 置 `cancelRequested/ended=true` 后调用 `agent.abort()`；`487` 的循环在队列排空后退出；`498` finally 再次中止。
- 超时路径只中止、不产生终态类型：`for await` 直接结束且没有可用的 agent_end 时，`piAgentEnded` 保持 false，落在 `src/wecom-adapter.ts:2430-2440`，被归类为 `pi_agent_end_stop_text_missing`。只有 `2168-2172` 收到 `stopReason === "aborted"` 的 agent_end 时才走 `2363-2364` 的 `pi_agent_aborted`。

### 2. 终态判定

- `src/pi-agent-runtime.ts:373` 与 `src/wecom-adapter.ts:147`：均要求 `role === "assistant" && stopReason === "stop"`。
- `src/wecom-adapter.ts:151-161`：`extractPiAgentEndFailure` 只映射 `error`/`aborted`，`toolUse` 等其余 stopReason 返回 null，既不产出内容也不产出失败信号。

### 3. 轮次与工具循环

- `src/pi-agent-runtime.ts:210-228`：构造 Agent 时未设置任何步数或时间预算。
- `config.llm.recursionLimit`（`src/config.ts:41`，默认 25）只出现在未使用的 `stream()` 签名与诊断服务中，`streamPiEvents` 从不传入。
- 模型侧预算仅存在于提示词：`src/prompts/business-base-prompt.md:20`（调用次数与停止时机自行决定）、`:73`（约 4 分钟收敛、第 5 分钟输出结论）；`src/prompts/business-prompt.md:473/475`。
- 三档时间不一致：提示词 4-5 分钟、代码 480 秒、企微流安全 TTL 9 分钟（`src/stream-ttl.ts:1`）。

### 4. 工具结果规模

- `src/pi-tool-result-compressor.ts:5`：分工具阈值 8000 字符，仅证据类工具（`query`/`code_snippet`）超阈值转摘要。
- 其余工具在不超过 20000 字符（`src/tool-result-store.ts:10`）时原样透传，超过才落盘占位。
- `src/pi-agent-runtime.ts:176-178`：按需读取工具绕过压缩。
- 落盘上限：单文件 100 万字符、64 个文件、总容量 32MB。

## 未确认项

- Pi SDK 在被 abort 后是否仍会发出 agent_end 及其 stopReason 取值，无法从本地代码断定。
- 运行时实际未压缩的工具名清单依赖生产 MCP 工具注册结果。
- 调用图、跨项目影响与完整消费者集合需要 GitNexus 索引，本地检索不能证明。
- 线上遥测中的请求次数、轮次与调用次数无法在代码内复核。
- 未在代码中发现第二个 480 秒看门狗直接中止 `requestAbortController`，但不能排除进程级外部看门狗。
