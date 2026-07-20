# MCP 环境切换原始需求

Last Updated: 2026-07-17

## 用户原始需求

> /dev-spec-gen 优化wecom项目，指令中带的配置信息，不允许 AI 自定义参数进行覆盖。
>
> /dev-spec-gen 优化wecom项目，现在切换/neo 环境变量没有变，依然是查了oa的项目
>
> 非默认环境变量要给环境指令回复，方便用户知晓当前环境
>
> 不是切换的时候，是后续回复，首次回复和最终回复带上neo环境查询
>
> 截图反馈：切换 `/neo` 后询问“现在你能查哪些项目”，机器人没有直接返回项目列表，反而进入通用核实流程并输出与问题无关的“Java 实体字段类型和 Mapper 查询映射”等机械兜底内容。

## 原计划基线

- `mcpServers[].headerProfiles["/指令"]` 表示一组可切换 MCP headers。
- `bots[].defaultMcpHeaderCommand` 只应在当前会话没有显式切换指令时生效。
- 会话发送 `/neo` 后，后续 MCP 请求应使用 `/neo` profile，并持续到再次切换、清理或会话过期。
- MCP server 静态 headers 与 bot 静态 headers 可继续保留；不同 profile 之间不得互相继承环境专属 header。

## 已确认症状与根因

- 当前默认指令为 `/oa`，其 GitNexus profile 含 `projects=<OA 项目集合>` 与 `env=pro,iteng`。
- `/neo` profile 只含 `projects=<NEO 项目集合>`。
- `buildMcpHeaders` 当前先合并默认 `/oa` profile，再浅合并 `/neo` 会话 override。
- `/neo` 未声明 `env`，导致默认 `/oa` 的 `env=pro,iteng` 残留，GitNexus 仍可能按 OA 环境过滤或查询。

## 图片可见事实

- 用户先发送 `/neo`，机器人确认后续查询范围为 `small-oa, jiuyun-oa, neo-oa, jiuyun-moa`。
- 用户随后明确提问“现在你能查哪些项目”。
- 机器人最终回复只标识“当前按 /neo 环境查询”，正文却输出“仍未获得足够完整的直接证据”“Java 实体字段类型和 Mapper 查询映射”等与项目列表无关内容。
- 该问题的答案已存在于当前会话生效的 `projects` header 中，不需要代码检索、数据库查询、Planner 或最终证据闸门。

## 需求解释

- 当前生效指令 profile 是工具调用的权威配置边界；模型生成的同名工具参数必须在本地移除，实际配置值仅通过 MCP 请求头传递，避免覆盖和敏感值复制。
- profile 的 `projects` 表示当前允许访问的仓库集合；模型传入的 `repo` 只能从该集合中选择，超出范围时必须在本地阻断，不能向 MCP 服务端发起请求。
- 仓库候选、显式仓库识别和会话 repoHints 只能基于当前生效 profile，不能混入其它指令 profile 的项目。
- profile 未配置某参数时，模型仍可按工具 schema 正常提供该参数；锁定逻辑不得擅自补齐或猜测配置值。
- 显式会话 profile 应整体替换默认 profile，而非与默认 profile 做字段级叠加。
- 基础 server headers 与 bot 静态 headers 继续保留，并允许当前 profile 覆盖同名静态 header。
- 环境切换指令回复只负责确认切换成功，不承担完整环境提示。
- 后续每个业务问题在非默认 profile 下执行时，首次进度回复和最终回复必须明确显示 `当前按 /neo 环境查询`（其它非默认指令按实际指令显示）。
- 默认 profile `/oa` 下不额外增加环境提示，减少正常回复噪音。
- 自动清理无关历史对话时必须保留当前显式环境 profile，确保后续问题仍按 `/neo` 查询；用户明确“清理会话”或会话过期时才回落默认环境。
- 环境提示只回显指令名，不展示 header 具体值，避免泄露 token、secret、authorization、cookie、api-key 等敏感信息。
- 当用户明确询问“现在/当前能查哪些项目、可查询哪些仓库、查询范围是什么”时，直接从当前生效 profile 的 `projects` header 返回列表。
- 上述项目范围问题必须走本地确定性快路径，不加载 MCP 工具、不进入 Planner、不触发运行时 TodoList、Human Loop 或最终回复证据闸门。
- 回答正文只说明当前环境和项目列表；不得生成“证据不足”“继续核实”“Java 实体/Mapper”等无关模板。

## 验收标准

- [x] 当前 profile 已配置的同名工具参数会从工具请求体移除，模型传值不生效，profile 值仍只通过请求头传递。
- [x] 当前 profile 的 `projects` 作为 `repo` 白名单；白名单内仓库可调用，白名单外仓库在本地阻断且底层 MCP 工具不执行。
- [x] `/neo` 下仓库候选仅来自 `/neo` 的 `projects`，不会因其它 profile 存在 `oa-*` 项目而切换到 OA 仓库。
- [x] profile 未配置的工具参数保持原有模型传参行为。
- [x] 默认状态无会话 override 时，继续使用 `defaultMcpHeaderCommand` 对应 profile。
- [x] `/neo` 会话 override 生效时，GitNexus 最终 headers 不再包含 `/oa` profile 独有的 `env=pro,iteng`。
- [x] `/neo` 最终 `projects` 只包含 NEO 项目集合。
- [x] `/oa-dev` 等显式 profile 可使用自身 `env`，不会继承 `/oa` 的 `env`。
- [x] server 静态 headers 与 bot 静态 headers 在切换后仍保留。
- [x] `/neo` 下后续问题的首次进度回复包含 `当前按 /neo 环境查询`。
- [x] `/neo` 下后续问题的最终回复包含 `当前按 /neo 环境查询`，且不会重复添加同一提示。
- [x] 默认 `/oa` 环境的首次和最终回复不增加环境提示。
- [x] 自动清理无关历史后，显式 `/neo` 环境仍保留并继续用于工具加载与回复提示。
- [x] 用户明确清理会话或会话过期后，显式环境被清除并回落默认 `/oa`。
- [x] 环境提示只包含指令名，不暴露任何 header 值。
- [x] 用户询问“现在你能查哪些项目”时，直接返回当前 `/neo` profile 的四个项目。
- [x] 项目范围快路径在运行时 TodoList 和通用进度卡片之前执行，不调用 Planner、MCP、Agent 或最终回复闸门。
- [x] 项目范围快路径不输出任何证据不足、继续核实、Java/Mapper 等无关内容。
- [x] MCP 工具缓存继续按会话 override 隔离，切换后不复用 `/oa` 工具实例。

## 测试 seam

- MCP 工具配置锁纯函数/包装器：同名参数移除、大小写匹配、敏感 header 不复制到工具参数、未配置参数透传、`projects` 到 `repo` 白名单约束、越界调用不触达底层工具。
- 当前 profile 仓库候选：只使用最终生效 `projects`，不扫描其它 profile。
- `buildMcpHeaders` 纯函数：默认 profile、显式 profile 替换、静态 headers 保留、profile 同名覆盖。
- 环境提示纯函数：默认环境不提示、非默认环境生成提示、内容前置且去重。
- 项目范围意图纯函数：识别“现在你能查哪些项目”等明确问法，拒绝误判普通项目业务问题。
- 项目范围回复纯函数：根据当前生效 `projects` header 生成直接列表。
- 会话状态：显式环境指令持久化、自动清理历史保留环境、明确清理与过期清除环境。
- 会话与缓存回归：`test-project-switch-command.ts`、`test-mcp-tool-cache.ts`。
- 类型验证：`npx tsc --noEmit --pretty false`。

## 非目标

- 不修改 GitNexus MCP 服务端。
- 不允许 AI 为 profile 中缺失的 `env`、`projects` 或其它配置自行猜值。
- 不把 profile 的敏感 header 值写入日志或用户回复。
- 不改变现有 `/oa`、`/neo`、`/oa-dev` 配置结构。
- 不自动为 `/neo` 猜测或新增未提供的 `env` 值。
- 不提交或推送 Git 变更。

## 实现与验证证据

- profile 替换与当前生效 profile 解析：`src/mcp-client.ts`。
- MCP 工具参数锁与 `projects`/`repo` 范围阻断：`src/mcp-client.ts`。
- 当前 profile 仓库候选收窄：`src/wecom-adapter.ts`。
- 后续回复环境提示、项目范围意图识别与确定性回复：`src/mcp-header-commands.ts`、`src/wecom-adapter.ts`。
- 会话环境状态与自动历史清理：`src/session-manager.ts`、`src/wecom-adapter.ts`。
- 回归测试：`src/tests/test-mcp-config-lock.ts`、`src/tests/test-config.ts`、`src/tests/test-project-switch-command.ts`、`src/tests/test-mcp-tool-cache.ts`、`src/tests/test-list-repos-scope.ts`、`src/tests/test-search-loop-prelude.ts`。
- 文档：`README.md`。
- 已通过上述测试、`npx tsc --noEmit --pretty false` 与 `git diff --check`；测试同时校验同名参数移除、敏感 header 不复制、越界 repo 不触达底层 MCP、未配置参数透传、当前 profile 仓库候选隔离，以及项目范围快路径位于运行时 TodoList 初始化之前。
