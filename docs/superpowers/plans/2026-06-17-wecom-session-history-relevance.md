# wecom-agent 历史会话独立问题自动清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在收到明显独立的新问题时，代码层自动清空当前会话历史，避免旧上下文污染工具选择和回答。

**Architecture:** 在 `interaction-control.ts` 中新增纯函数判断当前问题与最近历史是否相关；在 `wecom-adapter.ts` 拼接历史前调用该函数，判定为独立时调用 `sessionManager.clearSession(sessionKey)` 并重新获取空 session。测试覆盖纯判断规则与 `SessionManager.clearSession` 的状态清理效果。

**Tech Stack:** Node.js、TypeScript ESM、LangChain message classes、现有 `ts-node/esm` 脚本式测试。

---

## File Structure

- Modify: `src/interaction-control.ts`
  - 新增 `HistoryRelevanceDecision` 类型。
  - 新增 `classifyHistoryRelevance(history, currentQuestion)` 纯函数。
  - 新增强锚点提取、短追问和显式新话题判断辅助函数。
- Modify: `src/wecom-adapter.ts`
  - 在历史拼接前调用 `classifyHistoryRelevance`。
  - 判定为 `independent` 时清空 session 并重新获取空 session。
- Create: `src/tests/test-history-relevance.ts`
  - 覆盖显式继续、显式新话题、不同 Jira、不同路径、短追问、不确定场景。
- Modify: `src/tests/test-session-memory.ts`
  - 补充 `clearSession` 会清理历史、repo hint、pending human-loop 的断言。

## Test Points

- 显式继续类输入必须保留历史。
- 显式新话题类输入必须判定独立。
- 当前问题包含不同 Jira 编号时必须判定独立。
- 当前问题包含不同路径或仓库锚点时必须判定独立。
- 短追问必须保留历史。
- 不确定长问题必须保守保留历史。
- 自动清理调用的底层 `clearSession` 必须清掉消息、repo hint 和 pending human-loop。

### Task 1: Add History Relevance Classifier

**Files:**
- Modify: `src/interaction-control.ts`
- Create: `src/tests/test-history-relevance.ts`

- [ ] **Step 1: Write failing classifier tests**

Create `src/tests/test-history-relevance.ts`:

```ts
import assert from "node:assert/strict";
import {
  classifyHistoryRelevance,
  type ConversationContextItem,
} from "../interaction-control.js";

const baseHistory: ConversationContextItem[] = [
  { role: "user", content: "请帮我排查 XSWL-26474 为什么没有回调" },
  { role: "assistant", content: "当前排查到 XSWL-26474 需要继续看回调日志。" },
];

function assertDecision(
  currentQuestion: string,
  expected: "related" | "independent" | "uncertain",
  history: ConversationContextItem[] = baseHistory,
) {
  const actual = classifyHistoryRelevance(history, currentQuestion);
  assert.equal(
    actual.decision,
    expected,
    `${currentQuestion} expected ${expected}, got ${actual.decision}: ${actual.reason}`,
  );
}

assertDecision("继续查", "related");
assertDecision("另外一个问题，帮我看 XSWL-26488 的状态", "independent");
assertDecision("请排查 XSWL-26488 为什么没有回调", "independent");
assertDecision(
  "优化 D:\\workplace\\typescript\\GitNexus 的检索历史",
  "independent",
  [
    { role: "user", content: "优化 D:\\workplace\\typescript\\wecom-agent 的历史会话管理" },
    { role: "assistant", content: "当前在看 wecom-agent 的 session-manager.ts。" },
  ],
);
assertDecision("怎么验证", "related");
assertDecision("帮我整理一下今天的问题", "uncertain");

console.log("history relevance 判断规则验证通过");
```

- [ ] **Step 2: Run classifier test to verify it fails**

Run:

```powershell
node --loader ts-node/esm src/tests/test-history-relevance.ts
```

Expected:

```text
Cannot find module
```

or:

```text
Module '"../interaction-control.js"' has no exported member 'classifyHistoryRelevance'
```

- [ ] **Step 3: Implement minimal classifier**

In `src/interaction-control.ts`, add the following exports after `ConversationContextItem`:

```ts
export type HistoryRelevanceDecision = "related" | "independent" | "uncertain";

export interface HistoryRelevanceResult {
  decision: HistoryRelevanceDecision;
  reason: string;
}
```

Add these constants near the existing pattern constants:

```ts
const NEW_TOPIC_PATTERNS = [
  /^(新问题|另一个问题|另外一个问题|换个问题|重新开始|不要参考上文|不用参考上文)/i,
  /^(new topic|another question|reset context)/i,
];

const SHORT_FOLLOWUP_PATTERNS = [
  /^(怎么验证|如何验证|为什么|那怎么改|怎么改|下一步|继续下一步|怎么处理)$/i,
  /^(why|how|next|what next)$/i,
];

const JIRA_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\s，。！？!?,;；：:]+/g;
const POSIX_OR_CODE_PATH_PATTERN = /\b(?:src|docs|config|test|tests)\/[^\s，。！？!?,;；：:]+/g;
const API_PATH_PATTERN = /\/[A-Za-z0-9][A-Za-z0-9/_{}.-]*/g;

const REPO_ANCHORS = [
  "wecom-agent",
  "GitNexus",
  "oa-order",
  "oa-stock",
  "oa-after",
  "logistics",
  "autoTransfer",
];
```

Add these helper functions before `buildQuestionWithHistory`:

```ts
function collectPatternMatches(text: string, pattern: RegExp) {
  return Array.from(text.matchAll(pattern)).map(match => match[0]);
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractStrongAnchors(text: string) {
  const anchors = [
    ...collectPatternMatches(text, JIRA_KEY_PATTERN),
    ...collectPatternMatches(text, WINDOWS_PATH_PATTERN),
    ...collectPatternMatches(text, POSIX_OR_CODE_PATH_PATTERN),
    ...collectPatternMatches(text, API_PATH_PATTERN),
    ...REPO_ANCHORS.filter(anchor => text.includes(anchor)),
  ];
  return uniqueValues(anchors.map(anchor => anchor.trim()));
}

function hasDifferentStrongAnchor(history: ConversationContextItem[], currentQuestion: string) {
  const currentAnchors = extractStrongAnchors(currentQuestion);
  if (currentAnchors.length === 0) return false;

  const historyAnchors = uniqueValues(
    history.flatMap(item => extractStrongAnchors(item.content)),
  );
  if (historyAnchors.length === 0) return false;

  return currentAnchors.some(anchor => !historyAnchors.includes(anchor));
}

export function classifyHistoryRelevance(
  history: ConversationContextItem[],
  currentQuestion: string,
): HistoryRelevanceResult {
  const normalized = normalizeActiveMessage(currentQuestion);
  if (!normalized || history.length === 0) {
    return { decision: "uncertain", reason: "empty-current-or-history" };
  }

  if (CONTINUE_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { decision: "related", reason: "explicit-continue" };
  }

  if (NEW_TOPIC_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { decision: "independent", reason: "explicit-new-topic" };
  }

  if (hasDifferentStrongAnchor(history, normalized)) {
    return { decision: "independent", reason: "different-strong-anchor" };
  }

  if (SHORT_FOLLOWUP_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { decision: "related", reason: "short-followup" };
  }

  return { decision: "uncertain", reason: "no-reliable-signal" };
}
```

- [ ] **Step 4: Run classifier test to verify it passes**

Run:

```powershell
node --loader ts-node/esm src/tests/test-history-relevance.ts
```

Expected:

```text
history relevance 判断规则验证通过
```

### Task 2: Wire Classifier Into WeCom Session Flow

**Files:**
- Modify: `src/wecom-adapter.ts`
- Modify: `src/tests/test-session-memory.ts`

- [ ] **Step 1: Extend session cleanup test**

In `src/tests/test-session-memory.ts`, add this block before the final closing brace of `testSessionLogic()`:

```ts
  const cleanupKey = "cleanup-session";
  await sm.addMessages(cleanupKey, [
    new HumanMessage("old cleanup question"),
    new AIMessage("old cleanup answer"),
  ]);
  sm.resolveRepoHints(cleanupKey, ["wecom-agent"]);
  sm.setPendingHumanLoop(cleanupKey, {
    reason: "clarification_required",
    question: "请补充需求编号",
    resumeInstruction: "继续处理",
    contextSnapshot: {
      userQuestion: "历史问题",
      knownFacts: [],
      missingFacts: ["需求编号"],
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    originalMessageId: "msg-cleanup",
    resumeCount: 0,
  });

  sm.clearSession(cleanupKey);
  const cleanedSession = sm.getOrCreateSession(cleanupKey);
  if (cleanedSession.messages.length !== 0) {
    console.log("FAILED: clearSession should remove messages.");
    process.exit(1);
  }
  if (sm.resolveRepoHints(cleanupKey, []).length !== 0) {
    console.log("FAILED: clearSession should remove repo hints.");
    process.exit(1);
  }
  if (sm.getPendingHumanLoop(cleanupKey)) {
    console.log("FAILED: clearSession should remove pending human-loop.");
    process.exit(1);
  }
  console.log("SUCCESS: clearSession removes history state.");
```

- [ ] **Step 2: Run session cleanup test**

Run:

```powershell
node --loader ts-node/esm src/tests/test-session-memory.ts
```

Expected:

```text
SUCCESS: clearSession removes history state.
```

- [ ] **Step 3: Import classifier in adapter**

Update the import from `src/interaction-control.ts` in `src/wecom-adapter.ts` to include `classifyHistoryRelevance`:

```ts
import {
  buildFollowupQuestion,
  buildQuestionWithHistory,
  detectActiveMessageIntent,
  classifyHistoryRelevance,
  type ConversationContextItem,
} from "./interaction-control.js";
```

- [ ] **Step 4: Allow session reassignment**

Change the session declaration in `src/wecom-adapter.ts` from:

```ts
const session = sessionManager.getOrCreateSession(sessionKey, true);
```

to:

```ts
let session = sessionManager.getOrCreateSession(sessionKey, true);
```

- [ ] **Step 5: Add automatic cleanup before history merge**

Replace the existing branch:

```ts
    } else if (session.messages.length > 0 && pendingText) {
      const historyItems: ConversationContextItem[] = session.messages
        .slice(-6)
        .map(message => {
          if (message instanceof HumanMessage) {
            return { role: "user", content: extractTextContent(message.content as any) };
          }
          if (message instanceof AIMessage) {
            return { role: "assistant", content: message.content.toString() };
          }
          return { role: "system", content: message.content.toString() };
        });
      effectiveParsedContent = buildQuestionWithHistory(historyItems, pendingText);
    }
```

with:

```ts
    } else if (session.messages.length > 0 && pendingText) {
      const historyItems: ConversationContextItem[] = session.messages
        .slice(-6)
        .map(message => {
          if (message instanceof HumanMessage) {
            return { role: "user", content: extractTextContent(message.content as any) };
          }
          if (message instanceof AIMessage) {
            return { role: "assistant", content: message.content.toString() };
          }
          return { role: "system", content: message.content.toString() };
        });
      const relevance = classifyHistoryRelevance(historyItems, pendingText);
      if (relevance.decision === "independent") {
        console.log(`[Session] Auto clearing unrelated history for ${sessionKey}: ${relevance.reason}`);
        sessionManager.clearSession(sessionKey);
        session = sessionManager.getOrCreateSession(sessionKey);
      } else {
        effectiveParsedContent = buildQuestionWithHistory(historyItems, pendingText);
      }
    }
```

- [ ] **Step 6: Run targeted tests**

Run:

```powershell
node --loader ts-node/esm src/tests/test-history-relevance.ts
node --loader ts-node/esm src/tests/test-session-memory.ts
node --loader ts-node/esm src/tests/test-session-repo-hint.ts
```

Expected:

```text
history relevance 判断规则验证通过
SUCCESS: clearSession removes history state.
[SUCCESS] session repo inheritance verified
```

### Task 3: Typecheck And Audit

**Files:**
- Verify only.

- [ ] **Step 1: Run TypeScript compile check**

Run:

```powershell
npx tsc --noEmit
```

Expected:

```text
No output and exit code 0
```

- [ ] **Step 2: Review Git diff**

Run:

```powershell
git diff -- src/interaction-control.ts src/wecom-adapter.ts src/tests/test-history-relevance.ts src/tests/test-session-memory.ts docs/superpowers/specs/2026-06-17-wecom-session-history-relevance-design.md docs/superpowers/plans/2026-06-17-wecom-session-history-relevance.md
```

Expected:

```text
Diff only contains the classifier, adapter wiring, tests, and approved docs.
```

- [ ] **Step 3: Check worktree for unrelated files**

Run:

```powershell
git status --short
```

Expected:

```text
Existing unrelated TODO files may remain untracked. Do not stage them.
```

### Task 4: Final Review Notes

**Files:**
- Verify only.

- [ ] **Step 1: Summarize core call chain**

Document this call chain in the final response:

```text
WeCom message -> parseWeComMessage -> sessionManager.getOrCreateSession
-> classifyHistoryRelevance -> sessionManager.clearSession when independent
-> buildMessagesForCurrentTurn -> agent.stream -> sessionManager.addMessages
```

- [ ] **Step 2: Include Mermaid sequence**

Use the sequence from the design document, kept Mermaid v8 compatible.

- [ ] **Step 3: Report verification**

Report:

```text
已执行:
- node --loader ts-node/esm src/tests/test-history-relevance.ts
- node --loader ts-node/esm src/tests/test-session-memory.ts
- node --loader ts-node/esm src/tests/test-session-repo-hint.ts
- npx tsc --noEmit
```

If any command fails, fix the implementation or ask for user confirmation before recording it as an unresolved risk.
