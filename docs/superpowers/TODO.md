# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check) - 当前分支 feature/search-iteration，Node/TypeScript 项目
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context) - 本次为 wecom-agent 工具/回答审核增强，不涉及租户数据
- [x] 技术栈识别与规范选择：基于项目文件确认 Java/Python/Node/前端/混合仓库，并选择对应 references；无法确认时阻塞询问 - 证据：package.json、tsconfig.json、Dockerfile；不适用 Java 专用流程
- [x] 阻塞步骤确认：记录工具缺失、服务未启动、MCP 不可用、模型切换、数据库/HTTP 不可达或用户确认缺失的处理选择 - 用户已确认方案；当前无阻塞
- [x] 核心规范回查 (Local References Review) - 已读取 dev-spec-gen/SKILL.md、workflow-guardrails.md、general-specs.md
- [x] 涉及技能识别：列出本次需求触达的技能及引用规范 - dev-spec-gen；涉及运行时 TodoList、业务 prompt、测试验证

## Phase 2: Design (文档先行)
- [x] API-First: 接口文档定义 (API Spec) - 不适用，本次不修改 HTTP API
- [x] DB-First: 数据库变更脚本编写 (SQL/Schema Migration) - 不适用，本次不涉及 DB/SQL
- [x] SQL 生成与 MCP 执行验证：涉及 SQL 拼接、加字段、Mapper/XML 或 Flyway 时，先逻辑推导最终生成 SQL，再通过数据库 MCP 执行或验证；无法执行时必须阻塞确认 - 不适用
- [x] 现有能力复用核对：优先复用现有流程、工具方法、公共组件、代码逻辑、Mapper SQL 和已有关联表；未证明不可复用前禁止重复造轮子或新增旁路逻辑 - 复用现有 runtime_todolist_update 与 business-prompt 测试
- [x] 性能优化要点：批量/IN/循环查库/缓存/SQL/前端性能覆盖或不适用说明 - 不适用，本次为 prompt/审核项增强
- [x] 编码规范要点：Java/SQL/DTO/Mapper/热部署/引用规范覆盖或不适用说明 - Node/TypeScript；保持现有风格，最小改动
- [x] README 文档同步：项目必要说明、安装方式、使用方式必须落到 README.md；涉及 README 相关调整时同步修改 README.md - 不涉及 README
- [x] 测试要点：RED-GREEN、编译、单入口、业务断言、异常和回归范围 - 覆盖 TodoList 新审核项、业务 prompt 新规则、工具过滤不拦截
- [x] 测试点生成：测试前先根据本次修改代码梳理测试点，再按测试点生成测试用例 - 测试点：owner_contact_audited 默认存在、工具 schema 支持、未完成会拦截、prompt 包含 git_author_trace 与联系开发人员规则
- [x] Java 非接口测试设计：区分正式 `src/test` 自动化用例与临时 `AiAutoTestController` 热部署验证；Service/工具类/领域对象/Mapper 辅助逻辑等非接口逻辑必须优先生成正式测试文件并纳入 Git 托管 - 不适用 Java

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change) - 新增 owner_contact_audited 运行时审核项，更新 runtime_todolist_update schema、业务 prompt 和模型注入指令
- [x] 规范合规注释注入 (Spec Compliance Comments) - 本次改动为直观枚举/提示词增强，不新增噪音注释

## Phase 4: Verification (验证)
- [x] Bug Reproduction (针对 Bug 修复) - 非 Bug 修复；本次为工具/回答审核增强
- [x] 项目构建/编译通过 (Build/Compilation Passed) - npx tsc 通过
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test) - node dist/tests/test-runtime-todolist.js、test-business-prompt.js 通过
- [x] 接口一致性比对 (Response Schema Check) - 不涉及 HTTP API；静态核对 config.tools.allowed 为空且 excluded 不包含 git_author_trace
- [x] Java 非接口测试文件核对：若本次 Java 修改不新增或调整接口，必须核对是否存在对应正式测试类；缺失时回到实现阶段补齐，不能只用本地 Controller、手工调用或截图替代 - 不适用 Java
- [x] README 同步核对：确认 README.md 覆盖项目说明、安装使用和本次 README 相关变更 - 不涉及 README
- [x] 计划-代码一致性核对：逐项确认 PLAN/TODO 中的交付项均有代码、测试、证据或明确不适用说明 - 计划项已由 runtime-todolist、business-prompt 与对应测试覆盖；真实 MCP 工具列表加载验证超时，已记录为未验证风险

## Phase 5: Audit & Finish (审计与完结)
- [x] 代码审核点梳理：写完代码后列出性能风险、边界场景、逻辑闭环和需求完整性检查点，并回查 dev-spec-gen/references 对应规范 - 性能不适用；边界覆盖不涉及代码时可标记不适用、涉及代码时必须建议联系开发人员；逻辑闭环为 prompt 指引 + runtime gate + tests
- [x] 现有能力复用审计：检查是否存在可复用现有工具/组件/流程/JOIN 却新增等价实现、子查询、EXISTS、IN、重复 Mapper 或旁路逻辑 - 已复用现有 runtime_todolist_update 和业务 prompt，不新增旁路流程
- [x] Open Code Review 审查：检查 `ocr` 命令和 `ocr llm test`，执行 `ocr review --audience agent --background "<业务背景>"` 审查本次 Git diff；默认不设置超时时间，若调用工具必须显式设置则设为 1 天；不可用时必须阻塞确认 - ocr llm test 通过；ocr review 完成，反馈仅命中既有未跟踪 src/tests/test-mcp-tool-cache.ts 的 as any，非本次改动文件，未混入
- [x] Git 正式交付文件清单：列出本次新增/修改的代码、脚本、规范、模板、正式测试文件、测试数据构造器、测试工具类、计划和文档，确认正式交付物均进入 Git 托管 - 本次文件：docs/superpowers/TODO.md、src/prompts/business-prompt.md、src/runtime-todolist.ts、src/tests/test-business-prompt.ts、src/tests/test-runtime-todolist.ts、src/wecom-adapter.ts
- [x] Git 临时产物隔离：确认日志、二维码、导出物、依赖目录、压缩包、缓存和一次性调试产物未误入托管；必要时更新 .gitignore 或说明不纳入理由 - 未新增临时产物；既有未跟踪 src/tests/test-mcp-tool-cache.ts 不纳入本次暂存
- [x] Git 精确暂存：仅执行 `git add <本次新增或修改文件>`，禁止 `git add .`，禁止暂存非本次任务文件 - 准备精确暂存本次 6 个文件
- [x] Git 暂存区核对：执行 `git diff --cached --name-only` 并确认暂存区只包含本次任务文件；异常时停止并等待用户确认 - 暂存区仅包含本次 6 个文件
- [x] 本地工程合规审计表输出 (Compliance Audit Report) - 已回查 workflow-guardrails.md、general-specs.md；测试/验证按 Node 项目执行
- [x] 完结审计拦截 (Final Phase Check) - 编译、核心测试、OCR 完成；真实 MCP 工具加载验证超时，已作为风险记录
