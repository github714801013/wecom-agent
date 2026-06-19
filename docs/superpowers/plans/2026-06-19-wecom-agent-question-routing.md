# wecom-agent Question Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让企微问题先按 Planner 分类，再只加载对应问题类型的业务提示词片段，并强化排障类问题“按程序执行到取数点再暂停”的流程。

**Architecture:** 复用现有 `PlannerResult.intent` / `secondary_intents` 作为分类来源，在 `graph.ts` 中增加提示词路由函数。保留旧 `business-prompt.md` 作为无分类兜底；有分类时加载基础提示词和少量类别片段，减少每轮注入 token。

**Tech Stack:** Node.js、TypeScript ESM、LangChain、现有 `node --loader ts-node/esm` 脚本式测试。

---

### Task 1: Prompt Routing

**Files:**
- Modify: `src/graph.ts`
- Modify: `src/wecom-adapter.ts`
- Create: `src/prompts/business-base-prompt.md`
- Create: `src/prompts/categories/troubleshooting-prompt.md`
- Create: `src/prompts/categories/flow-prompt.md`
- Create: `src/prompts/categories/sql-prompt.md`
- Create: `src/prompts/categories/general-prompt.md`
- Create: `src/tests/test-prompt-routing.ts`

- [ ] **Step 1: Write the failing test**

`src/tests/test-prompt-routing.ts` 验证：
- BUG/API/CONFIG 等排障类 intent 加载基础提示词和 `troubleshooting-prompt.md`。
- SQL intent 加载 `sql-prompt.md`。
- FLOW intent 加载 `flow-prompt.md`。
- 有分类时不加载旧 `business-prompt.md` 整包内容。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --loader ts-node/esm src/tests/test-prompt-routing.ts`
Expected: FAIL，提示 `resolveBusinessPromptFiles` 或分类提示词不存在。

- [ ] **Step 3: Implement minimal routing**

在 `src/graph.ts` 新增 `resolveBusinessPromptFiles` 和带分类参数的 `getBusinessPrompt(plannerResult)`；`initializeAgent` 接收同一个分类参数。`src/wecom-adapter.ts` 在 Planner 完成后把 `plannerResult` 传给业务 Agent 和递归恢复总结。

- [ ] **Step 4: Add split prompt files**

新增基础提示词和类别提示词。排障类提示词明确要求：
- 先固定入口和代码顺序。
- 遇到生产数据、Redis、MQ 或日志依赖时，只输出下一跳必要取数语句。
- 等用户返回结果后继承已确认入口继续下一层，不重复宽搜。

- [ ] **Step 5: Run focused tests**

Run:
- `node --loader ts-node/esm src/tests/test-prompt-routing.ts`
- `node --loader ts-node/esm src/tests/test-business-prompt.ts`
- `node --loader ts-node/esm src/tests/test-human-loop.ts`

- [ ] **Step 6: Compile**

Run: `npx tsc --noEmit`

---

### Self-Review

- Spec coverage: 覆盖“先分类再走流程”“提示词按问题拆分”“排障按代码执行并等待取数结果”。
- Placeholder scan: 无待补占位。
- Type consistency: `PlannerResult.intent` 与 `secondary_intents` 直接复用现有类型。
