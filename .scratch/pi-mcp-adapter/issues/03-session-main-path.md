# 03: 按业务 session 接入 Pi 主路径

**What to build:** 将 Pi 原生 AgentSession 接入 WeCom 主执行路径，按业务 sessionKey 隔离 Pi 状态，同时保留业务记忆、用户可见历史、请求替换、取消、超时和终态语义。

**Blocked by:**

- 01: 用 MCP SDK 直连替换 LangChain MCP adapter
- 02: 接入 Pi 原生 AgentSession 与 direct tools

**Status:** ready-for-agent

- [ ] user、assistant、tool result 业务历史可安全转换到 Pi session
- [ ] 不同 sessionKey 的 Pi 上下文、工具历史和 compaction 状态相互隔离
- [ ] Pi session 重置不删除业务 SessionManager 中的历史、记忆、repo hints 或 MCP profile
- [ ] 保留请求替换、取消、超时、模型错误、工具错误和实际耗时语义
- [ ] 主路径不再依赖旧 Agent Core facade、Worker 或子进程宿主
- [ ] 主执行公共接缝验证工具范围、session 隔离和生命周期终态
