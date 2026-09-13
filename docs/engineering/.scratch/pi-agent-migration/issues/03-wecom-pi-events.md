# 03 — 企业微信 Pi 事件消费与流程收敛

**What to build:** 企业微信适配器直接消费统一 Pi 事件，持续提供进度和最终答复，同时收敛 Planner、预检索、自动验证和 LangGraph 恢复循环。

**Blocked by:** 02 — MCP Plugin 工具桥接

**Status:** ready-for-agent

- [ ] 文本、工具状态、错误、取消、流过期和恢复均按企业微信契约输出。
- [ ] 敏感请求预检仍发生在 Pi Agent 和工具加载之前。
- [ ] 会话、业务/开发回复模式、Human Loop、去重和暂停恢复保持正确。
- [ ] 最终输出门保留事实值和业务语言规则，不再启动独立自动验证 Agent 循环。
