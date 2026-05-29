# WeCom Stream TTL Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Enterprise WeCom stream updates from continuing after the 10 minute update window expires.

**Architecture:** Add a small pure helper for stream TTL decisions and use it from the WeCom adapter before every stream update. When the safe window is exceeded, persist the current question in session history, send one final pause message inside the current stream, and cancel the active task so no later update uses the expired stream id.

**Tech Stack:** Node.js, TypeScript, ts-node ESM tests, WeCom AI bot SDK.

---

### Task 1: Add Stream TTL Helper

**Files:**
- Create: `src/stream-ttl.ts`
- Test: `src/tests/test-stream-ttl.ts`

- [ ] **Step 1: Write pure helper test**

Create assertions for active, boundary, and expired states:

```ts
assert.equal(isStreamExpired(0, STREAM_SAFE_TTL_MS - 1), false);
assert.equal(isStreamExpired(0, STREAM_SAFE_TTL_MS), true);
assert.equal(isStreamExpired(1000, 1000 + STREAM_SAFE_TTL_MS), true);
```

- [ ] **Step 2: Implement helper constants**

Export `STREAM_SAFE_TTL_MS`, `STREAM_EXPIRED_MESSAGE`, and `isStreamExpired(startedAt, now)`.

- [ ] **Step 3: Run helper test**

Run: `node --loader ts-node/esm src/tests/test-stream-ttl.ts`

Expected: PASS.

### Task 2: Guard WeCom Stream Updates

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Import TTL helper**

Import `STREAM_EXPIRED_MESSAGE` and `isStreamExpired`.

- [ ] **Step 2: Track stream start time**

Set `const streamStartedAt = Date.now();` immediately after generating `streamId`.

- [ ] **Step 3: Add safe reply wrapper**

Create a local `safeReplyStream(content, final)` function that:

```ts
if (shouldStopCurrentTask()) return false;
if (isStreamExpired(streamStartedAt)) {
  await saveExpiredStreamHistory();
  currentTask.cancelled = true;
  await bot.replyStream(frame, streamId, STREAM_EXPIRED_MESSAGE, true);
  return false;
}
await bot.replyStream(frame, streamId, content, final);
return true;
```

Use a local boolean to ensure the expired final message is sent only once.

- [ ] **Step 3.1: Persist resumable context**

Before cancelling due to TTL, write the original user message and pause message to session history once, so a later “继续” can be combined with the previous question.

- [ ] **Step 4: Replace direct replyStream calls**

Replace progress, tool-call status, periodic content, and final answer `bot.replyStream(...)` calls with `safeReplyStream(...)`.

### Task 3: Verify and Audit

**Files:**
- Modify: `docs/superpowers/TODO.md`

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node --loader ts-node/esm src/tests/test-stream-ttl.ts
node --loader ts-node/esm src/tests/test-progress-overwrite.ts
node --loader ts-node/esm src/tests/test-answer-review.ts
npx tsc --noEmit --pretty false
```

- [ ] **Step 2: Check diff and staged files**

Run:

```powershell
git diff -- src/stream-ttl.ts src/wecom-adapter.ts src/tests/test-stream-ttl.ts docs/superpowers/TODO.md docs/superpowers/plans/2026-05-29-wecom-stream-ttl-guard.md
git status --short
```

- [ ] **Step 3: Precisely stage changed files**

Run:

```powershell
git add src/stream-ttl.ts src/wecom-adapter.ts src/tests/test-stream-ttl.ts docs/superpowers/TODO.md docs/superpowers/plans/2026-05-29-wecom-stream-ttl-guard.md
git diff --cached --name-only
```
