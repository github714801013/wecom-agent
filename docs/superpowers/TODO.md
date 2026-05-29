# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 运行环境与版本确认 (Runtime/Environment Check): Node/TypeScript，证据 `package.json`、`tsconfig.json`
- [x] 租户隔离/路径前缀确认 (Tenant/Path Context): 本次为 WeCom 流式消息基础设施，无租户/DB 变更
- [x] 核心规范检索 (qmd Discovery): qmd init 按仓库 references 查找失败，已直接读取 dev-spec-gen references 作为等价证据
- [x] 涉及技能识别：dev-spec-gen、superpowers:writing-plans、superpowers:verification-before-completion

## Phase 2: Design (文档先行)
- [x] API-First: 不新增 HTTP API，仅修改 WeCom stream 发送路径
- [x] DB-First: 不涉及数据库变更
- [x] 性能优化要点：不涉及批量/IN/SQL；仅增加 O(1) 时间判断
- [x] 编码规范要点：Node/TypeScript，最小化修改，不初始化 Java 专用 Controller
- [x] 测试要点：新增 TTL 纯函数红黑测试，回归进度覆盖与审核路由测试

## Phase 3: Implementation (开发)
- [x] 新增 stream TTL helper 与测试
- [x] 统一 WeCom replyStream 安全发送封装
- [x] TTL 暂停时持久化当前问题，支持用户回复“继续”后基于历史整合
- [x] 规范合规注释注入 (Spec Compliance Comments): TTL 边界逻辑通过命名函数表达，无额外冗余注释

## Phase 4: Verification (验证)
- [x] Bug Reproduction: 用 TTL helper 单测复现超过安全窗口判定
- [x] 项目构建/编译通过 (Build/Compilation Passed): `npx tsc --noEmit --pretty false`
- [x] 单入口/集成测试验证 (Single-Entry/Integration Test): 运行 stream/progress/review 相关 ts-node 测试
- [x] 接口一致性比对 (Response Schema Check): 不涉及 HTTP 响应结构

## Phase 5: Audit & Finish (审计与完结)
- [x] 本地工程合规审计表输出 (Compliance Audit Report): 已核对计划、TODO、diff、测试和 TypeScript 编译
- [x] 完结审计拦截 (Final Phase Check): 本次不提交不部署，按规范执行精确暂存供审核
