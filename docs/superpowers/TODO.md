# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check)：Node/TypeScript，证据为 package.json、tsconfig.json
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context)：不涉及租户或数据变更
- [x] 核心规范检索 (qmd Discovery)：已读取 general-specs.md、testing-specs.md
- [x] 涉及技能识别：dev-spec-gen；无独立 superpowers 工具，使用物理 PLAN/TODO 等价锚点

## Phase 2: Design (文档先行)
- [x] API-First: 不新增 HTTP API；保持 agent.stream 契约
- [x] DB-First: 不涉及数据库变更
- [x] 性能优化要点：审核只执行一次，最多两轮业务节点，避免长链路断流
- [x] 编码规范要点：最小修改 graph.ts 与对应测试
- [x] 测试要点：覆盖审核通过、审核失败返工一次、最终不输出审核文本

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change)：审核只执行一次；通过直接返回首轮业务答案，不通过让业务节点返工一次后直接返回
- [x] 规范合规注释注入 (Spec Compliance Comments)：保留审核节点只做路由判断的代码注释

## Phase 4: Verification (验证)
- [x] Bug Reproduction (针对 Bug 修复)：测试覆盖审核文本不应出现在用户可见输出
- [x] 项目构建/编译通过 (Build/Compilation Passed)：npx tsc --noEmit --pretty false 通过
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test)：answer review、progress、diagnostic、prompt 测试通过
- [x] 接口一致性比对 (Response Schema Check)：stream 输出不暴露审核报告，最终来自业务节点

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出 (Compliance Audit Report)：已核对 diff 与测试输出
- [x] 完结审计拦截 (Final Phase Check)：未提交未部署，等待用户确认
