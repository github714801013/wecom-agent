# Human Loop State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为企微 Agent 增加可恢复的 human-in-loop 状态机，覆盖问题澄清和生产 SQL 结果回填。

**Architecture:** 新增独立 `human-loop` 模块定义暂停协议、输出解析、恢复提示词和展示文案；`SessionManager` 持久化 pending 状态；企微入口在普通执行前优先恢复 pending，并在最终输出后识别结构化暂停请求。Prompt 只约束模型何时输出暂停 JSON，真正的暂停和恢复由代码层负责。

**Tech Stack:** TypeScript、LangChain messages、现有内存 SessionManager、现有脚本式 ts-node 测试。

---

### Task 1: Human Loop 协议与解析

**Files:**
- Create: `src/human-loop.ts`
- Test: `src/tests/test-human-loop.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import {
  buildHumanLoopReply,
  buildHumanLoopResumeContent,
  detectHumanLoopRequest,
  isAmbiguousNewTopicWhilePending,
} from "../human-loop.js";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const clarification = detectHumanLoopRequest(`前置说明
\`\`\`json
{
  "human_loop": {
    "reason": "clarification_required",
    "question": "请补充订单号和环境。",
    "resume_instruction": "用户补充后继续排查订单状态。",
    "context_snapshot": {
      "user_question": "订单状态不对",
      "known_facts": ["用户反馈订单状态异常"],
      "missing_facts": ["订单号", "环境"]
    }
  }
}
\`\`\``);

assertEqual(clarification?.reason, "clarification_required", "should parse clarification reason");
assertEqual(clarification?.question, "请补充订单号和环境。", "should parse question");

const prodSql = detectHumanLoopRequest(JSON.stringify({
  human_loop: {
    reason: "prod_sql_required",
    sql: "SELECT id, status FROM order_info WHERE id = 123 LIMIT 20;",
    expected_result_format: "请返回 id、status 两列。",
    resume_instruction: "根据生产查询结果继续判断状态异常原因。",
    context_snapshot: {
      user_question: "生产订单 123 状态不对",
      known_facts: ["用户指明生产订单"],
      missing_facts: ["生产订单当前状态"]
    }
  }
}));

assertEqual(prodSql?.reason, "prod_sql_required", "should parse prod sql reason");
assertEqual(buildHumanLoopReply(prodSql!).includes("我无法直接查询生产库"), true, "prod sql reply should explain boundary");
assertEqual(buildHumanLoopReply(prodSql!).includes("SELECT id, status FROM order_info"), true, "prod sql reply should include SQL");

const unsafeSql = detectHumanLoopRequest(JSON.stringify({
  human_loop: {
    reason: "prod_sql_required",
    sql: "UPDATE order_info SET status = 1 WHERE id = 123;",
    resume_instruction: "继续处理",
    context_snapshot: {
      user_question: "修复生产订单",
      known_facts: [],
      missing_facts: []
    }
  }
}));

assertEqual(unsafeSql, null, "unsafe SQL should be rejected");

const resume = buildHumanLoopResumeContent(prodSql!, "id,status\n123,已支付");
assertEqual(resume.includes("【Human Loop 恢复】"), true, "resume should include marker");
assertEqual(resume.includes("id,status"), true, "resume should include user result");

assertEqual(isAmbiguousNewTopicWhilePending("帮我查会员短信哪里发的"), true, "new task while pending should be ambiguous");
assertEqual(isAmbiguousNewTopicWhilePending("id,status\n123,已支付"), false, "table-like result should be treated as resume input");

console.log("human-loop 协议解析验证通过");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node --esm src/tests/test-human-loop.ts`
Expected: FAIL because `src/human-loop.ts` does not exist.

- [ ] **Step 3: Implement minimal protocol**

Create `src/human-loop.ts` with:
- `HumanLoopReason`
- `HumanLoopRequest`
- `detectHumanLoopRequest(text)`
- `buildHumanLoopReply(request)`
- `buildHumanLoopResumeContent(request, resumeInput)`
- `isAmbiguousNewTopicWhilePending(text)`

安全规则：`prod_sql_required` 只接受以 `SELECT`、`SHOW`、`EXPLAIN` 开头的 SQL，拒绝包含 `UPDATE`、`DELETE`、`INSERT`、`TRUNCATE`、`DROP`、`ALTER`、`CREATE`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node --esm src/tests/test-human-loop.ts`
Expected: PASS and print `human-loop 协议解析验证通过`.

### Task 2: Session 持久化 pending 状态

**Files:**
- Modify: `src/session-manager.ts`
- Modify: `src/tests/test-session-memory.ts`

- [ ] **Step 1: Write failing session test**

Add assertions:

```typescript
sm.setPendingHumanLoop(key, {
  reason: "clarification_required",
  question: "请补充订单号",
  resumeInstruction: "继续排查订单状态",
  contextSnapshot: {
    userQuestion: "订单状态不对",
    knownFacts: [],
    missingFacts: ["订单号"]
  },
  createdAt: Date.now(),
  expiresAt: Date.now() + 30 * 60 * 1000,
  originalMessageId: "msg-1",
  resumeCount: 0,
});

if (!sm.getPendingHumanLoop(key)) {
  console.log("FAILED: Pending human-loop should be stored.");
  process.exit(1);
}

sm.clearPendingHumanLoop(key);
if (sm.getPendingHumanLoop(key)) {
  console.log("FAILED: Pending human-loop should be cleared.");
  process.exit(1);
}
console.log("SUCCESS: Pending human-loop lifecycle works.");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ts-node --esm src/tests/test-session-memory.ts`
Expected: FAIL because pending methods do not exist.

- [ ] **Step 3: Implement session methods**

Extend `Session` with `pendingHumanLoop?: StoredHumanLoopRequest`.
Add:
- `setPendingHumanLoop(sessionKey, request)`
- `getPendingHumanLoop(sessionKey)`
- `clearPendingHumanLoop(sessionKey)`
- `incrementPendingHumanLoopResume(sessionKey)`

When session expires or `clearSession` runs, pending state must be removed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ts-node --esm src/tests/test-session-memory.ts`
Expected: existing session checks and pending lifecycle checks pass.

### Task 3: 企微入口接入暂停与恢复

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Add final-output detection**

After agent execution finishes and before saving final AI message:
- call `detectHumanLoopRequest(fullContent)`
- if present, save it via `sessionManager.setPendingHumanLoop`
- replace `fullContent` with `buildHumanLoopReply(request)`
- save the displayed reply to history

- [ ] **Step 2: Add pending resume path**

After clear-session command handling and before planner logic:
- read `sessionManager.getPendingHumanLoop(sessionKey)`
- if pending exists and current text looks like a new task, reply asking user to choose whether to continue pending task or clear session
- otherwise build resume input with `buildHumanLoopResumeContent(pending, textToPlan)`
- clear pending only after the resumed execution produces a non-human-loop final answer; if it produces a new human-loop request, replace pending

- [ ] **Step 3: Preserve normal behavior**

Do not change media parsing, tool streaming, deduplication, repo hint resolution, or clear-session command behavior.

### Task 4: Prompt 约束

**Files:**
- Modify: `src/prompts/business-prompt.md`

- [ ] **Step 1: Add human-loop output contract**

Add a compact section:
- 信息不足时输出 `human_loop.reason=clarification_required`
- 生产数据必须输出 `human_loop.reason=prod_sql_required`
- SQL 必须只读、完整、可执行、带必要过滤和行数限制
- 不得声称已查询生产库
- 输出 human-loop 时只输出 JSON，不混杂业务结论

- [ ] **Step 2: Add resume handling rule**

When receiving `【Human Loop 恢复】`, use the supplied result to continue the original task and do not ask the same question again unless the returned data仍不足。

### Task 5: Verification

**Files:**
- No source changes unless tests reveal issues.

- [ ] **Step 1: Run focused tests**

Run:
- `npx ts-node --esm src/tests/test-human-loop.ts`
- `npx ts-node --esm src/tests/test-session-memory.ts`

Expected: both pass.

- [ ] **Step 2: Run compile verification**

Run: `npx tsc --noEmit`
Expected: no TypeScript errors introduced by human-loop changes.

- [ ] **Step 3: Manual scenario checklist**

Verify by code path review:
- unclear question produces pending clarification reply
- prod data request produces SQL handoff reply
- user result resumes original task
- new topic while pending asks user to choose
- clear-session command removes pending

