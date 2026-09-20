# pi-mcp-adapter GitNexus/本地调研记录

## 调研范围

- 任务：`pi-mcp-adapter`
- 工作区：`D:\workplace\typescript\wecom-agent`
- 分支：`feat/pi-agent-migration`
- 目标：删除 `pi-smart-compact` 依赖，评估 `pi-mcp-adapter` 是否能在不破坏现有 MCP 工具、请求预算、取消和终态语义的前提下减少 MCP 查询上下文与加载开销。
- 调研范围：当前工作区。

## GitNexus 结果

按节点要求先调用 GitNexus `query`，查询目标为当前工作区的 MCP 加载、缓存、Pi 工具注册和查询执行链路。GitNexus 返回：`Repository is not available through this MCP server.`

因此按节点允许的 fallback 规则改用当前工作区只读检索。以下证据均标记为：

- `source=local_search`
- `authority=non_gitnexus`

本记录不能证明完整调用图、完整消费者集合或跨项目影响范围。

## 当前实现证据

1. `src/mcp-client.ts:232-356`
   - 当前使用 `@langchain/mcp-adapters` 的 `loadMcpTools`。
   - 每个 MCP server 建立 transport/client，连接后加载完整工具集合。
   - `createMcpToolsCache` 提供进程内 TTL 缓存，并复用同一 key 的 pending Promise，避免并发重复加载。
   - 缓存 key 包含 Bot 标识、Bot MCP headers 和请求级 header overrides。

2. `src/wecom-adapter.ts:2109-2134`
   - 当前请求在创建 Pi Agent 前调用 `loadMcpTools(botConfig, mcpHeaderOverrides)`。
   - 然后按项目范围过滤工具，并额外加入原始问题、会话记忆图和文件结果读取工具。
   - 因此现有路径是“先加载 MCP 工具目录，再把筛选后的工具定义直接交给 Pi”。

3. `src/pi-agent-runtime.ts:156-203,229-246`
   - 当前 facade 将每个具有 `invoke` 的 MCP 工具转换为 Pi 原生工具。
   - 工具执行保留当前 `invoke` 契约、请求 AbortSignal、工具超时、工具结果压缩和实时预算注记。
   - 当前 Agent Core 路径直接把转换后的工具集合放入模型上下文；没有 MCP 代理工具、按需搜索或按需激活机制。

## pi-mcp-adapter 公开资料核对

核对对象：`pi-mcp-adapter@2.34.0`。

- npm 元数据：公开入口为 `index.ts`，公开工厂为 `createMcpAdapter`；peer dependencies 包含 `@earendil-works/pi-ai`、`@earendil-works/pi-tui`、`typebox` 和 `zod`。
- GitHub README：<https://github.com/nicobailon/pi-mcp-adapter>
- npm 包：<https://www.npmjs.com/package/pi-mcp-adapter>
- 仓库地址：<https://github.com/nicobailon/pi-mcp-adapter.git>

README 声明的效率机制：

- 默认向 Pi 暴露一个统一的 `mcp` 代理工具，而不是把所有 MCP 工具定义一次性放进上下文。
- 通过 `search`、`describe`、`call` 按需发现和调用工具。
- MCP server 默认延迟连接；工具元数据可缓存；支持 `directTools`、`includeTools`、`excludeTools` 控制暴露面。
- 支持 `createMcpAdapter({ config })` 程序化、隔离的配置快照。
- 包的默认导出和工厂面向 Pi Coding Agent ExtensionAPI；当前公开资料没有证明它能直接作为现有 `@earendil-works/pi-agent-core` `Agent` 的 drop-in adapter。

## 适配性判断

### 可能收益

- 当前路径在每次 Pi 调用前向模型暴露多个 MCP 工具定义；当工具定义较大或服务器较多时，代理工具模式可能降低首轮上下文占用。
- lazy connection 和元数据缓存可能减少未使用 MCP server 的连接与完整工具目录加载。
- `search/describe/call` 可把大型工具目录查询从模型初始上下文移到按需检索。

### 未确认或有回归风险的边界

- 当前项目依赖请求头覆盖、项目范围过滤、GitNexus 项目发现包装、`invoke` 参数校验和 `MCP_CONFIG_SCOPE_VIOLATION` 错误语义；尚未证明 `pi-mcp-adapter` 的代理调用能完整保留这些行为。
- 当前代码使用 `@modelcontextprotocol/sdk` 的 SSE/Streamable HTTP transport 和 `@langchain/mcp-adapters` 的工具对象；适配器使用自己的 MCP client/server manager，不能直接假设已有连接和缓存可复用。
- 适配器默认代理工具会改变模型的工具选择方式和参数契约，可能增加“搜索→描述→调用”的模型轮次；它不等于每个查询都更快。
- 当前主路径仍是 `@earendil-works/pi-agent-core` facade；若接入 `createMcpAdapter`，需要先确认是否迁移到 Pi Coding Agent `AgentSession`，否则不存在已确认的宿主扩展接缝。
- 包包含较大的扩展能力面（OAuth、资源、脚本 worker、UI/审批等）；本项目只需要 MCP 查询，不能默认启用未验证的副作用或额外工具。

## 当前结论

`pi-mcp-adapter` 有明确的“代理工具 + lazy connection + 元数据缓存”性能方向，值得在隔离 harness 中评估；但当前证据不足以直接替换线上 MCP 加载路径。下一 grill 节点必须先确认：

1. 是否接受从当前 Pi Agent Core facade 迁移到 Pi Coding Agent `AgentSession`，以获得官方 ExtensionAPI 接缝；
2. 是否采用默认单一 `mcp` 代理工具，还是仅启用受限 `directTools`；
3. 是否保留当前项目/请求头范围约束、工具结果压缩、预算和 AbortSignal 作为不可变契约；
4. 是否把 `pi-mcp-adapter` 仅用于受控 A/B 评估，还是直接替换主路径；
5. MCP 查询效率的验收指标是首轮上下文 token、MCP server 加载耗时、完整请求 p95，还是三者同时达标。

在这些决策确认前，不安装或接入 `pi-mcp-adapter`，不继续 `pi-smart-compact` 方案，也不提交、推送或部署。
