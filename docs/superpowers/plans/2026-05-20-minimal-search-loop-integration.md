# Minimal Search Loop Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `createMinimalSearchLoop` 正式接入企微主流程，先做 typed query 预检索和证据压缩，再把可信证据交给最终 agent，避免 missing_info 抽象描述污染后续查询。

**Architecture:** 主流程在 agent streaming 前加载 MCP tools，并执行一个最多 2 轮的 search loop prelude。loop 的 searcher 只调用具备 query/searchText/pattern 参数的 MCP 检索工具，compressor 只压缩真实工具返回；补查只允许使用 planner 原始未执行 query，不再拼接 compressor.missing_info。

**Tech Stack:** TypeScript, LangChain tools, MCP adapters, node:assert tests, ts-node/esm.

---

### Task 1: RED - 补查约束测试

**Files:**
- Modify: `src/tests/test-minimal-search-loop.ts`
- Modify: `src/graph.ts`

- [ ] 新增测试：当 planner 原始 queries 已用完时，`runDefaultNextQueryPlanner` 即使收到 `missing_info` 也返回 `null`。
- [ ] 运行 `node --loader ts-node/esm src/tests/test-minimal-search-loop.ts`，预期失败，证明当前实现会拼接 missing_info。

### Task 2: GREEN - 移除 missing_info 拼接补查

**Files:**
- Modify: `src/graph.ts`

- [ ] 修改 `runDefaultNextQueryPlanner`：只返回 planner 原始未执行 query；没有则返回 `null`。
- [ ] 运行 `node --loader ts-node/esm src/tests/test-minimal-search-loop.ts`，预期通过。

### Task 3: RED - MCP tool searcher 与 prelude 接入测试

**Files:**
- Modify: `src/graph.ts`
- Create/Modify: `src/tests/test-search-loop-prelude.ts`

- [ ] 新增 `createToolSearchLoopSearcher` 和 `runSearchLoopPrelude` 的期望测试：fake query tool 被调用，返回内容被转成 SearchResult，loop 输出可注入 prompt 的证据文本。
- [ ] 运行该测试，预期因函数未实现失败。

### Task 4: GREEN - 实现 search loop prelude

**Files:**
- Modify: `src/graph.ts`

- [ ] 实现 `createToolSearchLoopSearcher(tools)`：选择带 query/searchText/pattern 入参的工具，调用优先级最高的 query，序列化结果为 SearchResult。
- [ ] 实现 `formatSearchLoopPrelude(loopResult)`：只输出 executed query、key_evidence、compressed_sections、missing_info 和 warnings。
- [ ] 实现 `runSearchLoopPrelude(userQuestion, plannerResult, tools)`：复用已有 plannerResult，最多 2 轮，失败时返回空字符串并记录日志。

### Task 5: 主流程接入

**Files:**
- Modify: `src/graph.ts`
- Modify: `src/wecom-adapter.ts`

- [ ] 修改 `initializeAgent(tools?)`，允许复用已加载 MCP tools。
- [ ] 在 `wecom-adapter.ts` 中 agent streaming 前加载 tools，执行 `runSearchLoopPrelude`，将结果追加到 `searchPlanHint` 后。
- [ ] 保留 agent 后续工具调用能力。

### Task 6: 修复历史压缩运行时问题

**Files:**
- Modify: `src/session-manager.ts`

- [ ] 将 `lastHumanMsg/userQuestion` 计算移动到 searchResults 构造前。
- [ ] 历史 AIMessage 的 SearchResult 增加 `metadata` 或 content 前缀标识为历史模型输出，避免误当原始工具证据。

### Task 7: 验证

**Commands:**
- `node --loader ts-node/esm src/tests/test-minimal-search-loop.ts`
- `node --loader ts-node/esm src/tests/test-search-loop-prelude.ts`
- `npx tsc --noEmit`

**Expected:** 全部通过。
