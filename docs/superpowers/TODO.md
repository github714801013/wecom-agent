# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check)
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context)
- [x] 核心规范检索 (qmd Discovery)
- [x] 涉及技能识别：列出本次需求触达的技能及引用规范

## Phase 2: Design (文档先行)
- [x] API-First: 接口文档定义 (API Spec) - 不适用：本次未新增/修改 HTTP API
- [x] DB-First: 数据库变更脚本编写 (SQL/Schema Migration) - 不适用：本次未修改数据库
- [x] 性能优化要点：批量/IN/循环查库/缓存/SQL/前端性能覆盖或不适用说明
- [x] 编码规范要点：Java/SQL/DTO/Mapper/热部署/引用规范覆盖或不适用说明
- [x] 测试要点：RED-GREEN、编译、单入口、业务断言、异常和回归范围

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change)
- [x] 规范合规注释注入 (Spec Compliance Comments) - 不适用：未改 Java/SQL 关键逻辑

## Phase 4: Verification (验证)
- [x] Bug Reproduction (针对 Bug 修复)
- [x] 项目构建/编译通过 (Build/Compilation Passed)
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test)
- [x] 接口一致性比对 (Response Schema Check) - 不适用：企微 WebSocket 消息通道，无返回 VO 变更

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出 (Compliance Audit Report)
- [x] 完结审计拦截 (Final Phase Check)
