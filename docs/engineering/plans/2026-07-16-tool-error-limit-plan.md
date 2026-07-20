# 工具查询错误上限实施计划

Last Updated: 2026-07-16

**Goal:** 单轮业务工具累计失败达到 3 次后停止 Agent 工具循环，并向企微用户反馈真实错误边界。

**Raw Requirements:** `docs/engineering/specs/2026-07-16-tool-error-limit-raw-requirements.md`

**Tech Stack:** TypeScript 6、Node.js ESM、LangChain/LangGraph、脚本式 TypeScript 单元测试。

**规范来源:** `/dev-spec-gen`、`workflow-guardrails.md`、`general-specs.md`、`debugging-evidence-specs.md`、`testing-specs.md`。

## 实施切片

- [x] RED：扩展 `src/tests/test-agent-progress-guard.ts`，覆盖第 3 次错误停止、成功结果不计数、Todo 工具错误不计数、错误码。
- [x] GREEN：扩展 `ToolContextRecord`，传递可选 `status`。
- [x] GREEN：扩展 `createAgentProgressGuard`，增加 `maxToolErrors`、失败记录和专用停止原因。
- [x] 接入：`src/wecom-adapter.ts` 从 `ToolMessage.status` 记录工具状态。
- [x] 接入：捕获专用错误码后直接生成用户可见反馈，不再进入恢复模型、答案修复或后续工具查询。
- [x] 验证：目标测试、最终回复回归、运行时 TodoList 回归和 TypeScript 编译通过。
- [x] 评审：现有暂存改动保留，本次仅修改对应守卫、工具上下文、企微适配与测试。

## 边界和兼容性

- 第 3 次错误即停止，最多允许 2 次错误后继续尝试。
- 错误计数按当前 Agent 实例/当前企微请求隔离。
- `status` 缺失时按成功/未知处理，不使用宽泛错误文本正则，避免正常业务结果被误判。
- 现有 `AGENT_TOOL_PROGRESS_LIMIT` 恢复总结路径保持不变；新增错误上限使用独立错误码并直接反馈。

## 避坑检查

- 修改现有公共守卫，不新增重复循环控制模块。
- 不依赖模型自行判断是否停止，阈值由程序硬控制。
- 用户反馈只暴露工具名和截断后的错误摘要，不回显完整敏感参数。

## 验证记录

- `node --loader ts-node/esm src/tests/test-agent-progress-guard.ts`：通过。
- `node --loader ts-node/esm src/tests/test-final-reply-delivery.ts`：通过。
- `node --loader ts-node/esm src/tests/test-runtime-todolist.ts`：通过；测试中的预期 LLM fallback 错误日志不影响通过结果。
- `npx tsc --noEmit --pretty false`：通过。
