# 01: 用 MCP SDK 直连替换 LangChain MCP adapter

**What to build:** 使用现有 MCP SDK 完成 MCP 工具目录读取和工具调用，让当前 Pi 路径继续获得同一组 direct MCP tools，同时删除不再使用的 `@langchain/mcp-adapters`、`pi-smart-compact` 以及已放弃的第三方插件/进程隔离依赖。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] SSE 与 Streamable HTTP transport 均可读取工具目录并调用工具
- [ ] Bot/profile 请求头、项目范围校验、固定参数、GitNexus 项目发现包装和 allowed/excluded 过滤保持原行为
- [ ] 相同缓存 key 的 TTL/pending 复用与不同范围隔离保持原行为
- [ ] 工具取消、超时、远端错误、结果压缩和预算注记保持原行为
- [ ] 删除 `@langchain/mcp-adapters`、`pi-smart-compact` 及不再使用的 Worker/子进程实现
- [ ] MCP 加载/调用公共接缝回归测试通过
