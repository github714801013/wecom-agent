# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check)：Node/TypeScript，证据为 package.json、tsconfig.json
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context)：不涉及租户或数据变更
- [x] 核心规范检索 (qmd Discovery)：已初始化 qmd，读取 general-specs.md、testing-specs.md
- [x] 涉及技能识别：dev-spec-gen；无独立 superpowers 工具，使用物理 PLAN/TODO 等价锚点

## Phase 2: Design (文档先行)
- [x] API-First: 不新增对外业务 API；如需诊断入口，仅用于服务级验证
- [x] DB-First: 不涉及数据库变更
- [x] 性能优化要点：避免无限审核循环；验证接口控制超时和输出长度
- [x] 编码规范要点：最小修复回复完整性和进度展示，不改业务检索逻辑
- [x] 测试要点：复现测试问题、覆盖阶段性回复不能作为最终答案、编译通过

## Phase 3: Implementation (开发)
- [x] 业务逻辑实现 (Surgical Change)：增加最终回答完整性硬拦截和处理中微动效
- [x] 规范合规注释注入 (Spec Compliance Comments)：本次逻辑函数命名表达约束，无额外注释

## Phase 4: Verification (验证)
- [x] Bug Reproduction (针对 Bug 修复)：使用“备用机 押金支付 支持哪些支付方式逻辑”本地完整 agent 超过 10 分钟未稳定返回；用同类不完整阶段性回复做硬拦截回归
- [x] 项目构建/编译通过 (Build/Compilation Passed)：npx tsc --noEmit --pretty false 通过
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test)：answer review、progress、diagnostic、prompt 测试通过
- [x] 接口一致性比对 (Response Schema Check)：最终回答完整性拦截保证阶段性进度不会被标记为 passed

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出 (Compliance Audit Report)：已核对测试、diff 和暂存清单
- [x] 完结审计拦截 (Final Phase Check)：提交部署后进行远程健康检查
