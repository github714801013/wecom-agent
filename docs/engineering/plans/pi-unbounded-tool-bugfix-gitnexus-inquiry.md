# GitNexus 调研记录

## 问题
Pi 工具调用完成后未稳定继续生成最终 assistant 结论，过程文本可能被当作最终回复。

## 日志证据
本节点跳过 Loki 查询，未补充新的日志证据。

## 代码证据
- GitNexus 未收录 `wecom-agent`，主 query 返回仓库不可用；以下为允许的本地降级核验，来源为 `local_search`，权威性为 `non_gitnexus`。
- `src/pi-agent-runtime.ts:323-339`：`turn_end` 在无正文或过程文本且存在工具结果时调用 `agent.followUp`；事件处理同时会在 `agent_end` 时将 `ended` 置为 `true`。
- `src/pi-agent-runtime.ts:349-369`：`agent.prompt(...).finally` 无条件结束流，随后先取消订阅再等待 idle，存在 follow-up 后续事件未被消费的生命周期竞态风险。
- `src/wecom-adapter.ts:1611-1647`：适配器主要从 `message_end` 与 `agent_end` 提取 assistant 文本，工具事件本身不形成最终正文。
- `src/wecom-adapter.ts:2010-2014`：正文为空时只能发送固定兜底文本。
- `src/wecom-adapter.ts:2132-2139`：外层异常仅记录日志，未保证发送确定性最终错误回复。

## 未确认项
因 GitNexus 不可用且未扩大节点读取范围，尚未确认 `pi-agent-core` 对 `followUp`、`agent_end` 与 `waitForIdle` 的精确时序；上述结论应视为高可信生命周期风险，而非已证明必现。

## 下一步
在诊断阶段核验 Pi 依赖的实际事件时序，并以保持同一 Agent 会话、等待 follow-up 后续 assistant 轮次完成为最小修复方向；避免继续依赖过程文本关键词判断。
