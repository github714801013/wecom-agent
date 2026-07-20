# listrepos 查询范围参数原始需求

Last Updated: 2026-07-16

## 用户原始需求

> /dev-spec-gen listrepos 的时候增加一个参数，查询所有索引项目，还是查询可以查项目

## 需求解释

- 目标工具：GitNexus MCP 加载后的 `gitnexus_list_repos`（兼容名称以 `list_repos` / `listrepos` 结尾）。
- 新增参数：`scope`。
- `scope="queryable"`：返回当前机器人、默认命令或会话命令最终生效的 `projects` 请求头中的项目，即当前允许查询的项目。
- `scope="all_indexed"`：调用 GitNexus 原始 `list_repos`，返回服务端全部已索引项目。
- 默认值：`queryable`，防止模型在只需要确认可查询范围时暴露或使用无权限项目。
- 当前请求头优先级继续复用 `buildMcpHeaders`：服务端默认 < 默认 profile < bot header < 会话 header override。

## 验收标准

- [x] `gitnexus_list_repos` 的工具 schema 包含 `scope: "queryable" | "all_indexed"`。
- [x] 未传 `scope` 时按 `queryable` 执行。
- [x] `queryable` 返回最终生效 `projects` 请求头中的项目，去空格、去空值、去重并保持顺序。
- [x] `queryable` 不调用 GitNexus 原始 `list_repos`。
- [x] `all_indexed` 原样调用原始工具，并返回原始结果。
- [x] 非 GitNexus 或非 `list_repos` 工具不被包装。
- [x] 当前会话通过 `/oa`、`/neo` 等命令切换请求头后，工具缓存 key 变化，`queryable` 返回对应项目集合。

## 测试 seam

- 单元测试：对纯函数/假工具验证包装、默认 scope、请求头解析和透传行为。
- 回归测试：`src/tests/test-config.ts`、`src/tests/test-mcp-tool-cache.ts`。
- 类型验证：`npx tsc --noEmit --pretty false`。

## 非目标

- 不修改 GitNexus MCP 服务端实现。
- 不改变代码查询工具的 repo 强制注入逻辑。
- 不改变 `/oa`、`/neo` 等 header command 的配置格式。
- 不提交或推送 Git 变更。

## 实现与验证证据

- 工具包装与请求头解析：`src/mcp-client.ts`。
- 新增测试：`src/tests/test-list-repos-scope.ts`。
- 缓存隔离回归：`src/tests/test-mcp-tool-cache.ts`。
- 已通过：新增测试、配置测试、缓存测试、`npx tsc --noEmit --pretty false`。
