# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check): Node/TypeScript，证据 `package.json`、`tsconfig.json`
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context): 本次为企微 Agent 检索链路优化，无租户/DB 变更
- [x] 核心规范检索 (qmd Discovery): 已初始化 qmd，并读取 `general-specs.md`、`testing-specs.md`、`performance-optimization.md`
- [x] 涉及技能识别：dev-spec-gen、superpowers:systematic-debugging、superpowers:test-driven-development、superpowers:writing-plans、superpowers:verification-before-completion

## Phase 2: Design (文档先行)
- [x] API-First: 不新增 HTTP API，仅调整企微内部检索前置链路
- [x] DB-First: 不涉及数据库变更
- [x] 性能优化要点：直连服务证明 GitNexus `query` 的 vector 阶段单次约 12.5 秒；10 分钟回归显示最终 Agent 循环 query 和审核补齐会超时，二次优化为合并 query + 业务节点 TodoList 审核
- [x] 编码规范要点：Node/TypeScript，最小化修改，不初始化 Java 专用 Controller
- [x] 测试要点：先补 RED 测试，再实现跳过 GitNexus query 预检索、query 合并提示、独立审核节点合并为业务节点 TodoList，最后跑编译

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change): 跳过 GitNexus query 自动预检索；移除独立审核 LLM 调用；提示业务 Agent 用 TodoList 完成内部审核并合并 query 减少循环
- [x] 规范合规注释注入 (Spec Compliance Comments): 命名函数表达 GitNexus query 识别，无额外冗余注释

## Phase 4: Verification (验证)
- [x] Bug Reproduction (针对 Bug 修复): 直连 MCP 服务复现单次 GitNexus query 约 12.7 秒，其中 vector 约 12.5 秒；10 分钟回归在 629007ms 超时
- [x] 项目构建/编译通过 (Build/Compilation Passed): `npx tsc --noEmit --pretty false`
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test): `test-search-loop-prelude`、`test-answer-review`、`test-business-prompt` 均通过；直连预检索入口耗时 1ms 且未触发 query
- [x] 接口一致性比对 (Response Schema Check): 不涉及 HTTP 响应结构

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出 (Compliance Audit Report): 已核对计划、TODO、diff、直连服务测试、单测和 TypeScript 编译
- [x] 完结审计拦截 (Final Phase Check): 本次不提交不推送，按规范执行精确暂存供审核
