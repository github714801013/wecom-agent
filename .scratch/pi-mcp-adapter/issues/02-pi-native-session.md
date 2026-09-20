# 02: 接入 Pi 原生 AgentSession 与 direct tools

**What to build:** 使用官方 Pi Coding Agent 的同进程 AgentSession 承载 Pi 主执行，按业务 session 隔离上下文，只向模型暴露现有 MCP direct tools，并启用 Pi 原生 compaction。

**Blocked by:** 01: 用 MCP SDK 直连替换 LangChain MCP adapter

**Status:** ready-for-agent

- [ ] 每个业务 session 使用独立的内存 Pi SessionManager 和 SettingsManager
- [ ] 仅启用现有 MCP direct tools，不暴露 shell、read、edit、write 等默认工具
- [ ] 原生 compaction 以约 60% 上下文占用目标配置
- [ ] compaction、模型和工具执行共用请求 deadline
- [ ] compaction 失败、取消或超时回退到未压缩上下文
- [ ] 工具轮次后继续模型并产生非空 assistant `agent_end(stop)`
- [ ] Pi 主执行公共接缝测试通过
