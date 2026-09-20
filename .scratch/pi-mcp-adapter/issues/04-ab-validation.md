# 04: 脱敏真实轨迹 30+30 A/B 验收

**What to build:** 使用同一批脱敏真实请求轨迹比较摘要修复后的旧路径与 MCP SDK bridge + Pi 原生 AgentSession/compact 新路径，确认新路径是否带来可归因的性能收益并且没有正确性回归。

**Blocked by:** 03: 按业务 session 接入 Pi 主路径

**Status:** ready-for-agent

- [ ] A 组为摘要修复后的现有 Agent Core 路径，B 组为同样摘要修复加 MCP SDK bridge、AgentSession 和原生 compact
- [ ] 每组至少完成 30 条同类脱敏真实请求轨迹回放
- [ ] 两组保持模型、输入、MCP 服务、工具范围和请求 deadline 一致
- [ ] 记录工具目录/上下文 token、MCP 加载、实际 MCP 调用、Pi turn/compaction、总耗时和终态
- [ ] B 组 p95 或超过 300 秒请求比例至少改善 15%
- [ ] 代码证据完整性、工具范围、`agent_end(stop)`、取消、超时和业务记忆隔离均无回归
- [ ] 未达到门槛时不替换主路径
