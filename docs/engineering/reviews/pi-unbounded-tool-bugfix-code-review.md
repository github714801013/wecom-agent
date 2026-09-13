# Pi 生命周期代码审查记录

## 范围
相对 `HEAD` 的当前未提交改动；重点检查 Pi 生命周期完成语义和宿主工具调用限制。

## 已核验
- `src/pi-agent-runtime.ts` 中 `streamPiEvents()` 与兼容 `stream()` 的完成状态只由 Pi `agent_end` 事件设置；`prompt()` Promise 结算仅唤醒等待中的消费者。
- `src/wecom-adapter.ts` 忽略 `message_end` 的最终正文语义，只在 `agent_end` 提取最终文本，并以 `piAgentEnded` 阻止未收到 `agent_end` 的 Pi 路径继续进入最终交付。
- `src/wecom-adapter.ts` 与 `src/diagnostic-server.ts` 已不再通过 `agent-progress-guard` 中断 Pi 工具循环。
- `src/config.ts` 已移除 `maxAgentToolResultsPerTurn`。
- 静态检查与现有 Pi MCP 回归测试均通过。

## 限制
隔离审查 worktree 未同步主工作区未提交 Pi 文件，无法作为当前 diff 的逐行审查依据；本记录以主工作区直接核验结果为准。

## 结论
未发现会继续把 `message_end` 或宿主工具次数限制作为 Pi 完成信号的阻断性问题。仍应在 verify 阶段补充可控 Agent 生命周期测试，覆盖 `prompt()` 先结算、`agent_end` 延后到达的回归场景。
