# 02 — MCP Plugin 工具桥接

**What to build:** 让现有 MCP Skill 以 Pi AgentTool 形式工作，同时保持工具参数校验、白名单/黑名单、Header/Profile、Repo Scope、单工具超时、工具预算、重复调用限制和取消传播。

**Blocked by:** 01 — Pi 运行时与统一事件协议

**Status:** ready-for-agent

- [ ] SSE/Streamable HTTP MCP 工具描述和 JSON Schema 能被 Pi Agent 使用。
- [ ] 越权仓库、禁用工具、预算超限和重复调用不会触发远程调用。
- [ ] MCP 工具超时、取消、错误和结果摘要均有明确结果。
- [ ] MCP Session 失效时不会无限重建或重试。
