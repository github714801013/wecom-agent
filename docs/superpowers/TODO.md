# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check) - 当前分支 feature/search-iteration，最新提交 03de66d
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context) - 本次为 wecom-agent prompt/TodoList 规则收紧，不涉及租户数据
- [x] 技术栈识别与规范选择：基于项目文件确认 Java/Python/Node/前端/混合仓库，并选择对应 references；无法确认时阻塞询问 - Node/TypeScript，证据：package.json、tsconfig.json、Dockerfile
- [x] 阻塞步骤确认：记录工具缺失、服务未启动、MCP 不可用、模型切换、数据库/HTTP 不可达或用户确认缺失的处理选择 - 用户已确认计划，当前无阻塞
- [x] 核心规范回查 (Local References Review) - 已读取 dev-spec-gen/SKILL.md、workflow-guardrails.md、general-specs.md
- [x] 涉及技能识别：列出本次需求触达的技能及引用规范 - dev-spec-gen；涉及业务 prompt、运行时 TodoList、测试验证

## Phase 2: Design (文档先行)
- [x] API-First: 接口文档定义 (API Spec) - 不适用，本次不改 HTTP API
- [x] DB-First: 数据库变更脚本编写 (SQL/Schema Migration) - 不适用，本次不涉及 DB/SQL
- [x] SQL 生成与 MCP 执行验证：涉及 SQL 拼接、加字段、Mapper/XML 或 Flyway 时，先逻辑推导最终生成 SQL，再通过数据库 MCP 执行或验证；无法执行时必须阻塞确认 - 不适用
- [x] 现有能力复用核对：优先复用现有流程、工具方法、公共组件、代码逻辑、Mapper SQL 和已有关联表；未证明不可复用前禁止重复造轮子或新增旁路逻辑 - 复用现有 owner_contact_audited 与 business-prompt 测试
- [x] 性能优化要点：批量/IN/循环查库/缓存/SQL/前端性能覆盖或不适用说明 - 不适用，本次为提示词/审核门禁规则
- [x] 编码规范要点：Java/SQL/DTO/Mapper/热部署/引用规范覆盖或不适用说明 - Node/TypeScript，最小文本规则调整
- [x] README 文档同步：项目必要说明、安装方式、使用方式必须落到 README.md；涉及 README 相关调整时同步修改 README.md - 不涉及 README
- [x] 测试要点：RED-GREEN、编译、单入口、业务断言、异常和回归范围 - 覆盖最终结论引用证据、相关性优先、最新修改次之
- [x] 测试点生成：测试前先根据本次修改代码梳理测试点，再按测试点生成测试用例 - 更新 business-prompt 与 runtime-todolist 测试断言
- [x] Java 非接口测试设计：区分正式 `src/test` 自动化用例与临时 `AiAutoTestController` 热部署验证；Service/工具类/领域对象/Mapper 辅助逻辑等非接口逻辑必须优先生成正式测试文件并纳入 Git 托管 - 不适用 Java

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change) - 收紧 git_author_trace 规则：只基于最终结论实际引用证据追溯联系人，并按相关性优先、最新修改次之选择
- [x] 规范合规注释注入 (Spec Compliance Comments) - 本次为 prompt/TodoList 文案规则，未新增代码注释

## Phase 4: Verification (验证)
- [x] Bug Reproduction (针对 Bug 修复) - 非 Bug 修复，本次为联系人追溯规则增强
- [x] 项目构建/编译通过 (Build/Compilation Passed) - npx tsc 通过
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test) - test-business-prompt、test-runtime-todolist、test-help-command、test-progress-overwrite 通过
- [x] 接口一致性比对 (Response Schema Check) - 不涉及 HTTP API
- [x] Java 非接口测试文件核对：若本次 Java 修改不新增或调整接口，必须核对是否存在对应正式测试类；缺失时回到实现阶段补齐，不能只用本地 Controller、手工调用或截图替代 - 不适用 Java
- [x] README 同步核对：确认 README.md 覆盖项目说明、安装使用和本次 README 相关变更 - 不涉及 README
- [x] 计划-代码一致性核对：逐项确认 PLAN/TODO 中的交付项均有代码、测试、证据或明确不适用说明 - 计划项已由 prompt、runtime TodoList 与测试断言覆盖

## Phase 5: Audit & Finish (审计与完结)
- [x] 代码审核点梳理：写完代码后列出性能风险、边界场景、逻辑闭环和需求完整性检查点，并回查 dev-spec-gen/references 对应规范 - 性能不适用；边界覆盖最终未引用候选文件不得用于联系人、相关性相同时按最新修改；逻辑闭环为 prompt 指引 + runtime gate + tests
- [x] 现有能力复用审计：检查是否存在可复用现有工具/组件/流程/JOIN 却新增等价实现、子查询、EXISTS、IN、重复 Mapper 或旁路逻辑 - 复用现有 owner_contact_audited、runtime_todolist_update 和测试文件
- [x] Open Code Review 审查：检查 `ocr` 命令和 `ocr llm test`，执行 `ocr review --audience agent --background "<业务背景>"` 审查本次 Git diff；默认不设置超时时间，若调用工具必须显式设置则设为 1 天；不可用时必须阻塞确认 - 已执行 OCR，采纳 wecom-adapter 注入指令补充“不得使用最终未引用的候选文件”；其余反馈命中既有未跟踪 test-mcp-tool-cache.ts，未混入
- [x] Git 正式交付文件清单：列出本次新增/修改的代码、脚本、规范、模板、正式测试文件、测试数据构造器、测试工具类、计划和文档，确认正式交付物均进入 Git 托管 - 本次文件：docs/superpowers/TODO.md、src/prompts/business-prompt.md、src/runtime-todolist.ts、src/tests/test-business-prompt.ts、src/tests/test-runtime-todolist.ts、src/wecom-adapter.ts
- [x] Git 临时产物隔离：确认日志、二维码、导出物、依赖目录、压缩包、缓存和一次性调试产物未误入托管；必要时更新 .gitignore 或说明不纳入理由 - 未新增临时产物；既有未跟踪 src/tests/test-mcp-tool-cache.ts 不纳入本次暂存
- [x] Git 精确暂存：仅执行 `git add <本次新增或修改文件>`，禁止 `git add .`，禁止暂存非本次任务文件 - 准备精确暂存本次 6 个文件
- [x] Git 暂存区核对：执行 `git diff --cached --name-only` 并确认暂存区只包含本次任务文件；异常时停止并等待用户确认 - 暂存区仅包含本次 6 个文件
- [x] 本地工程合规审计表输出 (Compliance Audit Report) - 已回查 dev-spec-gen workflow/general；本次不涉及 API/DB/Java/README
- [x] 完结审计拦截 (Final Phase Check) - 编译、目标测试、OCR 已完成
