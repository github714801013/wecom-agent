# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [ ] 运行环境与版本确认 (Runtime/Environment Check)
- [ ] 租户隔离/路径前缀确认 (Tenant/Path Context)
- [ ] 核心规范回查 (Local References Review)
- [ ] 涉及技能识别：列出本次需求触达的技能及引用规范

## Phase 2: Design (文档先行)
- [ ] API-First: 接口文档定义 (API Spec)
- [ ] DB-First: 数据库变更脚本编写 (SQL/Schema Migration)
- [ ] SQL 生成与 MCP 执行验证：涉及 SQL 拼接、加字段、Mapper/XML 或 Flyway 时，先逻辑推导最终生成 SQL，再通过数据库 MCP 执行或验证；无法执行时必须阻塞确认
- [ ] 性能优化要点：批量/IN/循环查库/缓存/SQL/前端性能覆盖或不适用说明
- [ ] 编码规范要点：Java/SQL/DTO/Mapper/热部署/引用规范覆盖或不适用说明
- [ ] README 文档同步：项目必要说明、安装方式、使用方式必须落到 README.md；涉及 README 相关调整时同步修改 README.md
- [ ] 测试要点：RED-GREEN、编译、单入口、业务断言、异常和回归范围
- [ ] 测试点生成：测试前先根据本次修改代码梳理测试点，再按测试点生成测试用例

## Phase 3: Implementation (开发)
- [ ] 业务逻辑实现 (Surgical Change)
- [ ] 规范合规注释注入 (Spec Compliance Comments)

## Phase 4: Verification (验证)
- [ ] Bug Reproduction (针对 Bug 修复)
- [ ] 项目构建/编译通过 (Build/Compilation Passed)
- [ ] 单入口/集成测试验证 (Single-Entry/Integration Test)
- [ ] 接口一致性比对 (Response Schema Check)
- [ ] README 同步核对：确认 README.md 覆盖项目说明、安装使用和本次 README 相关变更

## Phase 5: Audit & Finish (审计与完结)
- [ ] 代码审核点梳理：写完代码后列出性能风险、边界场景、逻辑闭环和需求完整性检查点，并回查 dev-spec-gen/references 对应规范
- [ ] Open Code Review 审查：检查 `ocr` 命令和 `ocr llm test`，执行 `ocr review --audience agent --background "<业务背景>"` 审查本次 Git diff，并记录结果；不可用时必须阻塞确认
- [ ] 本地工程合规审计表输出 (Compliance Audit Report)
- [ ] 完结审计拦截 (Final Phase Check)
