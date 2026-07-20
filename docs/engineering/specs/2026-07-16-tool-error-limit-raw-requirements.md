# 工具查询错误上限原始需求

Last Updated: 2026-07-16

## 用户原始需求

> /dev-spec-gen 优化当前 wecom-agent 项目如果工具查询超过3次报错, 就跟用户反馈,不要一直查询

## 需求解释

- 作用范围：单次企微用户请求对应的一轮 Agent 执行。
- 统计对象：业务证据工具，不包含 `runtime_todolist_update`。
- 错误判定：优先使用 LangChain `ToolMessage.status === "error"`，避免凭普通结果文本误判。
- 阈值口径：本轮累计第 3 次工具错误时立即停止后续工具调用，并向企微用户反馈工具异常和当前无法继续查询的边界。
- 成功工具调用不清零累计错误次数，避免工具环境间歇性故障导致持续循环。
- 现有工具总数上限、重复调用上限继续保留。

## 验收标准

- [x] 前 2 次业务工具错误不会终止本轮执行。
- [x] 第 3 次业务工具错误触发专用停止错误，后续工具不再执行。
- [x] `runtime_todolist_update` 报错不计入业务工具错误上限。
- [x] 成功结果与无结果不会被统计为工具错误。
- [x] 企微最终回复明确说明工具累计失败已达上限，并包含最近失败工具及错误摘要。
- [x] 现有重复调用和总工具数守卫行为不回归。

## 测试 seam

- 单元测试：`src/tests/test-agent-progress-guard.ts` 直接验证错误计数、边界和专用错误码。
- 类型/构建验证：`npx tsc --noEmit --pretty false`。
- 适配层静态验证：确认 `src/wecom-adapter.ts` 将 `ToolMessage.status` 传入守卫，并对专用错误码直接生成用户反馈。

## 非目标

- 不修改 MCP 服务端重试策略。
- 不改变单个工具内部的超时或网络重试参数。
- 不提交或推送 Git 变更。

## 实现与验证证据

- 守卫实现：`src/agent-progress-guard.ts`。
- 工具状态传递与企微直达反馈：`src/tool-context-filter.ts`、`src/wecom-adapter.ts`。
- 自动化测试：`src/tests/test-agent-progress-guard.ts`。
- 已通过：目标守卫测试、最终回复交付测试、运行时 TodoList 测试、`npx tsc --noEmit --pretty false`。
