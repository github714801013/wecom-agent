# 04 — 依赖清理与全量回归

**What to build:** 完成 Pi 迁移后的依赖、配置和部署验收，使项目可构建、可启动、可回归，并确认旧 LangGraph Agent 依赖只在确无调用方后删除。

**Blocked by:** 03 — 企业微信 Pi 事件消费与流程收敛

**Status:** ready-for-agent

- [ ] 删除无调用方的 LangGraph/LangChain Agent 专属依赖和旧代码，不影响视觉或 MCP 仍在使用的依赖。
- [ ] 完成 TypeScript、Pi 文本/工具/流式 smoke、MCP smoke、WeCom contract 测试。
- [ ] Docker 使用满足 Pi 要求的 Node 版本构建并启动。
- [ ] 记录性能、工具调用次数、取消和最终回复成功率对比结果。
