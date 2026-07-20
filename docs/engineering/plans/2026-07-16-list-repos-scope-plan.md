# listrepos 查询范围参数实施计划

Last Updated: 2026-07-16

**Goal:** 为 GitNexus `list_repos` 增加 `scope` 参数，区分当前可查询项目与全部已索引项目。

**Raw Requirements:** `docs/engineering/specs/2026-07-16-list-repos-scope-raw-requirements.md`

**Tech Stack:** TypeScript 6、Node.js ESM、LangChain DynamicStructuredTool、Zod、MCP Adapter。

**规范来源:** `/dev-spec-gen`、`workflow-guardrails.md`、`general-specs.md`、`testing-specs.md`。

## 实施切片

- [x] RED：新增 `src/tests/test-list-repos-scope.ts`，验证默认 queryable、显式 all_indexed、去重和非目标工具旁路。
- [x] GREEN：在 `src/mcp-client.ts` 增加 projects header 解析纯函数。
- [x] GREEN：增加 GitNexus list_repos 工具包装函数，schema 新增 `scope`。
- [x] 接入：`loadFreshMcpTools` 在工具过滤前，按当前 server/bot/headerOverrides 包装目标工具。
- [x] 验证：新增测试、配置/缓存回归测试和 TypeScript 编译通过。
- [x] 评审：未覆盖当前工作区已有暂存改动，未修改 GitNexus 服务端或其他工具 schema。

## 设计约束

- `queryable` 只依赖最终生效请求头，不访问远端，结果稳定且与实际权限范围一致。
- `all_indexed` 只做原始工具透传，不在客户端猜测索引状态。
- 默认 `queryable`，模型必须显式选择 `all_indexed` 才能查看全部索引项目。
- 包装工具保持原工具名称，避免提示词、路由和已有测试失效。

## 验证记录

- `node --loader ts-node/esm src/tests/test-list-repos-scope.ts`：通过。
- `node --loader ts-node/esm src/tests/test-config.ts`：通过。
- `node --loader ts-node/esm src/tests/test-mcp-tool-cache.ts`：通过；同步修正了与 HEAD 缓存 key 行为不一致的旧断言，并验证会话 projects override 隔离。
- `npx tsc --noEmit --pretty false`：通过。
