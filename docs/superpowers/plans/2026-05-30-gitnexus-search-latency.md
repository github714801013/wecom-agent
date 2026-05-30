# GitNexus Search Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 减少企微检索型问题在进入业务 Agent 前重复调用 GitNexus `query` 造成的固定等待。

**Architecture:** 保留 Planner 和最终业务 Agent 工具调用路径，只在 `runSearchLoopPrelude` 中识别 GitNexus `query` 工具并跳过自动预检索。普通 query/searchText/pattern 工具仍按原逻辑执行预检索。

**Tech Stack:** TypeScript, LangChain tools, MCP adapters, node:assert tests, ts-node/esm.

---

### Task 1: RED - 固化 GitNexus query 预检索跳过场景

**Files:**
- Modify: `src/tests/test-search-loop-prelude.ts`
- Modify: `src/graph.ts`

- [ ] 在 `src/tests/test-search-loop-prelude.ts` 增加测试：当搜索工具是带 `query`、`zoekt`、`repo`、`max_symbols` 入参的 GitNexus `query` 工具时，`runSearchLoopPrelude` 返回空字符串且不调用工具。
- [ ] 运行 `node --loader ts-node/esm src/tests/test-search-loop-prelude.ts`，预期失败，证明当前实现会调用 GitNexus `query` 做预检索。

### Task 2: GREEN - 跳过 GitNexus query 自动预检索

**Files:**
- Modify: `src/graph.ts`

- [ ] 增加 GitNexus `query` 工具识别函数。
- [ ] 在 `runSearchLoopPrelude` 通过工具意图判断后，如果命中 GitNexus `query` 工具，直接返回空字符串。
- [ ] 保持现有非 GitNexus query 工具测试通过。

### Task 3: 验证

**Commands:**
- `node --loader ts-node/esm src/tests/test-search-loop-prelude.ts`
- `npx tsc --noEmit --pretty false`

**Expected:** 测试通过，TypeScript 编译通过。

### Task 4: 10 分钟回归后的二次收敛

**Files:**
- Modify: `src/graph.ts`
- Modify: `src/wecom-adapter.ts`
- Modify: `src/prompts/business-prompt.md`
- Modify: `src/tests/test-answer-review.ts`
- Modify: `src/tests/test-business-prompt.ts`

- [ ] 增加审核时间闸：总耗时低于 5 分钟才进入回答审核；超过后直接发送当前业务节点回答。
- [ ] 在业务提示词和当前轮检索提示中要求 GitNexus `query` 合并查询，原则上不超过 2 次，命中候选后改用 `code_snippet`/`context` 或已有证据回答。
- [ ] 运行 `node --loader ts-node/esm src/tests/test-answer-review.ts`。
- [ ] 运行 `node --loader ts-node/esm src/tests/test-business-prompt.ts`。
- [ ] 运行 `node --loader ts-node/esm src/tests/test-search-loop-prelude.ts`。
- [ ] 运行 `npx tsc --noEmit --pretty false`。

### Task 5: 合并审核节点回业务节点

**Files:**
- Modify: `src/graph.ts`
- Modify: `src/prompts/business-prompt.md`
- Modify: `src/tests/test-answer-review.ts`
- Modify: `src/tests/test-business-prompt.ts`

- [ ] 修改测试：`createReviewedAgent` 不再调用独立 `reviewer`，业务回答直接作为最终输出。
- [ ] 修改业务提示词：把原“独立审核节点”职责改为业务节点输出前强制 TodoList，并用 `- [ ]` 待办项确保大模型逐项审核。
- [ ] 修改 `createReviewedAgent` 为兼容层透传，`initializeAgent` 不再触发额外审核 LLM。
- [ ] 运行 `node --loader ts-node/esm src/tests/test-answer-review.ts`。
- [ ] 运行 `node --loader ts-node/esm src/tests/test-business-prompt.ts`。
- [ ] 运行 `npx tsc --noEmit --pretty false`。
