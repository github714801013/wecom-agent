# Dev-Spec-Gen 本地工程规范达成看板

## Phase 1: Research & Setup (初始化)
- [x] 涉及技能识别：增加 Planner 节点并重构提示词（LangChain 版）

## Phase 2: Design (文档先行)
- [x] 计划编写：拆分 planner 和 business 提示词
- [x] 节点流转设计：使用 LangChain 实现 Planner + Agent 工作流

## Phase 3: Implementation (开发)
- [x] 代码逻辑更新：在 graph.ts 中实现 runPlanner，维持 initializeAgent 的 LangChain 实现
- [x] 提示词拆分：创建 planner-prompt.md 和 business-prompt.md
- [x] 移除 Claude SDK：回滚所有 Claude Agent SDK 相关的代码及依赖

## Phase 4: Verification (验证)
- [x] 编译/类型核对：修复所有测试文件中的导入错误并验证通过
- [x] 清理：删除所有 Claude 相关测试及文档
- [x] 部署验证：镜像构建成功并完成部署
- [x] 故障恢复：实现递归超限后的自动总结恢复逻辑，并支持 ENV 配置限制次数

## Phase 5: Audit & Finish (审计与完结)
- [x] 完结审计拦截：确认系统提示词已分离，Planner 节点与容错机制正常工作
