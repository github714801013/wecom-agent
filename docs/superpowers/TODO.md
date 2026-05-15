# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 涉及技能识别：增加 Planner 节点并重构提示词（LangChain 版）
- [x] 核心规范检索：检索 WeCom 流式与工具调用规范

## Phase 2: Design (文档先行)
- [x] 节点流转设计：使用 LangChain 实现 Planner + Agent 工作流
- [x] 容错设计：实现递归超限后的自动总结恢复逻辑
- [x] 交互设计：设计工具调用在 WeCom 端的展示样式
- [x] 搜索优化设计：设计“一站式搜索”拼接逻辑，防止模型自行拆分

## Phase 3: Implementation (开发)
- [x] 核心功能实现：移除 Claude SDK，完成 Planner 与恢复逻辑
- [x] 体验优化实现：在 `wecom-adapter.ts` 中实现工具调用日志记录与企微推送
- [x] 搜索优化实现：重构 Planner 输出格式，强化 Business Prompt “单次查询”红线
- [ ] 体验增强实现：实现工具参数聚合日志记录，并向企微推送带参数的状态（如：正在搜索“售后”...）

## Phase 4: Verification (验证)
- [x] 编译/类型核对：通过 `npx tsc` 验证
- [x] 部署验证：镜像构建成功并完成部署
- [ ] 逻辑验证：通过日志观察参数是否完整显示，微信端展示是否友好

## Phase 5: Audit & Finish (审计与完结)
- [ ] 完结审计拦截：确认系统提示词已分离，搜索效率优化方案已上线
