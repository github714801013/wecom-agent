# MCP 环境切换修复实施计划

Last Updated: 2026-07-17

**Goal:** 修复显式 `/neo` profile 仍继承默认 `/oa` 环境 header 的问题，在后续业务问题的首次进度回复和最终回复中标识当前非默认查询环境，让“现在你能查哪些项目”直接返回当前 profile 项目列表，并确保当前指令配置对 AI 工具参数具有不可覆盖的最高优先级。

**Raw Requirements:** `docs/engineering/specs/2026-07-16-mcp-environment-switch-raw-requirements.md`

**Tech Stack:** TypeScript 6、Node.js ESM、WeCom Bot SDK、LangChain MCP Adapter。

**规范来源:** `/dev-spec-gen`、`workflow-guardrails.md`、`general-specs.md`、`environment-configuration-specs.md`、`debugging-evidence-specs.md`、`testing-specs.md`。

## 实施切片

- [x] RED：新增 MCP 工具参数锁测试，证明 AI 传入的同名参数不能覆盖当前 profile 配置。
- [x] RED：新增 `projects`/`repo` 边界测试，覆盖白名单内调用、白名单外本地阻断、底层工具不执行和未配置参数透传。
- [x] RED：新增当前 profile 仓库候选测试，证明 `/neo` 不会混入其它 profile 的 OA 仓库。
- [x] GREEN：在 MCP 工具加载层统一包装参数锁，确保 Agent、预检索和直接工具调用共享同一硬约束。
- [x] GREEN：WeCom 仓库识别只使用当前生效 profile 的 `projects`，不再扫描所有 profile。
- [x] 回归：运行 MCP 配置、项目切换、搜索预检索、工具缓存和类型检查。
- [x] 评审：确认不输出 header 值、不修改配置文件、不覆盖工作区现有无关改动。

- [x] RED：扩展 `src/tests/test-config.ts`，证明显式 `/neo` profile 不得继承默认 `/oa` 独有的 `env`。
- [x] RED：扩展 `src/tests/test-project-switch-command.ts`，验证 profile 切换与会话持久化基础行为。
- [x] GREEN：调整 `buildMcpHeaders`，显式 profile 生效时所有 MCP server 停止应用默认 profile。
- [x] RED：补充非默认环境提示测试，覆盖首次回复、最终回复、默认环境无提示和重复提示去重。
- [x] RED：补充会话环境状态测试，覆盖自动清理历史保留 `/neo`、明确清理和过期后回落默认。
- [x] GREEN：会话显式保存当前 profile 指令，并提供仅清理对话历史、保留环境状态的能力。
- [x] GREEN：首次进度回复和最终回复统一注入 `当前按 /neo 环境查询`，切换指令回复保持简洁。
- [x] RED：为“现在你能查哪些项目”等明确项目范围问法新增测试，要求直接返回当前 profile 项目列表。
- [x] GREEN：新增项目范围确定性快路径，并前移到运行时 TodoList、通用进度卡片、Planner、MCP、Agent 和最终回复闸门之前。
- [x] 回归：确认普通项目业务问题不会被误判为项目范围查询。
- [x] 文档：更新 README 中后续回复环境提示语义。
- [x] 验证：运行目标单测、缓存回归测试和 TypeScript 编译。
- [x] 评审：核对工作区已有未提交改动，确保本次只修改必要文件且不覆盖其他开发内容。

## 设计约束

- profile 是工具调用的权威配置快照；profile 已配置字段的优先级高于模型生成参数。
- 同名工具参数从请求体移除，profile 值仅保留在 MCP 请求头；`projects` 对 `repo` 采用白名单语义，允许模型在范围内选仓，越界时本地阻断。
- 配置锁位于 MCP 工具加载层，不能只依赖 prompt、Agent 自律或某一条调用链。
- 仓库候选只来源于当前最终生效 headers；其它 profile 仅用于切换指令解析，不参与当前会话选库。
- profile 是环境快照，不同 profile 之间不做字段级继承。
- server 静态 headers、bot 静态 headers 与当前 profile 的优先级为：当前 profile > bot 静态 headers > server 静态 headers。
- 会话没有显式 profile 时，当前 profile 为 bot 默认指令对应 profile。
- 非默认环境提示只展示当前指令名，不展示 header 内容。
- 首次进度回复和最终回复使用同一纯函数注入提示，避免文案漂移和重复添加。
- 自动判定为独立问题时只清理历史消息、图记忆与 Human Loop，不清除显式环境 profile。
- 用户明确“清理会话”或会话超时仍执行完整清理并回落默认 profile。
- 当前可查询项目是会话 profile 的确定性配置事实，不通过 LLM 推理或远端工具二次确认。
- 快路径只匹配明确的项目/仓库范围问法，不能拦截“某项目里查询什么逻辑”等普通业务问题。

## 验证记录

- 新增 RED 证据：`test-mcp-config-lock.ts` 在实现前因缺少 `wrapMcpToolWithConfiguredArgs` 失败；`test-project-switch-command.ts` 在收窄仓库候选前命中 `extractMcpProjectCandidates(config.mcpServers)` 并失败。
- `node --loader ts-node/esm src/tests/test-mcp-config-lock.ts`：通过，覆盖默认/显式 profile 解析、同名参数移除、大小写匹配、敏感 header 不复制、未配置参数透传、repo 白名单内 canonical 化、白名单外本地阻断且底层工具不执行。
- `node --loader ts-node/esm src/tests/test-project-switch-command.ts`：通过，并确认 WeCom 当前仓库候选只使用生效 profile 的 `projects`。
- `node --loader ts-node/esm src/tests/test-search-loop-prelude.ts`：通过，确认 repo scope 包装与预检索链路未回归。
- RED 证据：修改前 `test-config.ts` 报错 `expected undefined, got pro,iteng`，确认 `/neo` 继承 `/oa` 环境 header。
- `node --loader ts-node/esm src/tests/test-config.ts`：通过，覆盖 `/neo` 清除默认 env、`/oa-dev` 使用自身 env、跨 MCP 默认 profile 清除和静态 headers 保留。
- `node --loader ts-node/esm src/tests/test-project-switch-command.ts`：通过，覆盖非默认环境提示、默认环境无提示、提示去重、会话环境持久化、自动历史清理保留环境、完整清理与过期回落默认、项目范围问法识别、误判反例、直接项目列表回复，并校验快路径位于运行时 TodoList 初始化之前。
- `node --loader ts-node/esm src/tests/test-mcp-tool-cache.ts`：通过，确认会话 profile 缓存隔离未回归。
- `node --loader ts-node/esm src/tests/test-list-repos-scope.ts`：通过，确认当前可查询项目范围未回归。
- `node --loader ts-node/esm src/tests/test-image-vision-context.ts`：通过，确认图片/文件提前处理中链路未回归；测试内预期的 vision unavailable 日志属于失败降级用例。
- `npx tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过；仅有 Git 的 LF/CRLF 提示，无 whitespace error。
