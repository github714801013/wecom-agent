# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 涉及技能识别：增加 Planner 节点并重构提示词（LangChain 版）
- [x] 核心规范检索：检索 WeCom 流式与工具调用规范

## Phase 2: Design (文档先行)
- [x] 节点流转设计：使用 LangChain 实现 Planner + Agent 工作流
- [x] 容错设计：实现递归超限后的自动总结恢复逻辑
- [x] 交互设计：设计工具调用在 WeCom 端的展示样式（使用引用块或特定前缀）

## Phase 3: Implementation (开发)
- [x] 核心功能实现：移除 Claude SDK，完成 Planner 与恢复逻辑
- [x] 体验优化实现：在 `wecom-adapter.ts` 中实现工具调用日志记录与企微推送

## Phase 4: Verification (验证)
- [x] 编译/类型核对：修复所有测试文件中的导入错误并验证通过
- [x] 部署验证：镜像构建成功并完成部署
- [x] 体验验证：在企业微信端观察工具调用反馈是否实时且清晰

## Phase 5: Audit & Finish (审计与完结)
- [x] 完结审计拦截：确认系统提示词已分离，所有增强功能正常工作
- [x] 本地工程合规审计表输出：已通过 GitNexus 与物理验证确认逻辑正确性
