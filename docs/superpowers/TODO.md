# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check)：Node/TypeScript，证据为 package.json、tsconfig.json
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context)：不涉及租户数据或路径权限变更
- [x] 核心规范检索 (qmd Discovery)：已读取 general-specs.md、superpowers-integration-specs.md、testing-specs.md；qmd 已初始化
- [x] 涉及技能识别：dev-spec-gen；当前环境无独立 superpowers 工具，采用物理 TODO/PLAN 等价锚点

## Phase 2: Design (文档先行)
- [x] API-First: 不新增 HTTP API；保持 agent.stream 调用契约
- [x] DB-First: 不涉及数据库变更脚本
- [x] 性能优化要点：审核循环默认最多 2 轮且可配置，避免无限循环和额外工具扩散
- [x] 编码规范要点：最小修改 graph.ts，新增独立 review prompt 与测试
- [x] 测试要点：覆盖审核通过、审核失败纠正、JSON 解析异常；执行 tsc

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change)：新增独立审核 prompt、reviewed agent 包装器、审核失败循环纠正
- [x] 规范合规注释注入 (Spec Compliance Comments)：已在审核循环包装处标注有限循环约束

## Phase 4: Verification (验证)
- [x] Bug Reproduction (针对 Bug 修复)：本次为功能增强，不适用；用红黑测试覆盖审核通过/失败/上限
- [x] 项目构建/编译通过 (Build/Compilation Passed)：npx tsc --noEmit --pretty false 通过
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test)：新增测试、既有 prompt 测试、进度覆盖测试通过
- [x] 接口一致性比对 (Response Schema Check)：initializeAgent().stream 入参与 streamMode messages 消费方式保持兼容

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出 (Compliance Audit Report)：已核对 diff、测试、暂存清单
- [x] 完结审计拦截 (Final Phase Check)：已精确暂存本次交付文件，未执行 commit/push
