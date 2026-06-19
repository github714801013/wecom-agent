# wecom-agent Thinking Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在业务分析节点等待大模型输出期间，如果连续一段时间没有真实进度，向企微流式消息发送动态心跳，提示任务仍在工作。

**Architecture:** 在 `progress-updates.ts` 中新增纯函数生成动态心跳内容，便于测试。`wecom-adapter.ts` 在 `agent.stream` 期间启动定时器，真实输出、工具状态或最终回复会刷新活动时间并停止心跳。

**Tech Stack:** Node.js、TypeScript ESM、企业微信 `replyStream`、现有脚本式测试。

---

### Task 1: Dynamic Heartbeat Content

**Files:**
- Modify: `src/progress-updates.ts`
- Modify: `src/tests/test-progress-overwrite.ts`

- [ ] **Step 1: Write failing tests**

覆盖动态心跳：
- 同一函数在不同时间生成不同文案或动效。
- 有最新进度时复用最新进度，不重复固定“AI 正在思考中”。
- 没有内容时给动态点点和处理动效。

- [ ] **Step 2: Run red test**

Run: `node --loader ts-node/esm src/tests/test-progress-overwrite.ts`

- [ ] **Step 3: Implement minimal helper**

新增 `buildThinkingHeartbeatContent(content, activeCalls, now)`，内部复用 `buildProgressStreamContent`、`getProcessingFrame` 和动态点点。

### Task 2: Stream Heartbeat Timer

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Wire timer around agent.stream**

在业务分析节点启动后创建 `setInterval`，默认 15 秒检查一次；如果距离上次真实输出超过 15 秒，则发送动态心跳。

- [ ] **Step 2: Stop timer safely**

`for await` 正常结束、异常、取消、流过期、最终回复前都清理定时器。

- [ ] **Step 3: Verify**

Run:
- `node --loader ts-node/esm src/tests/test-progress-overwrite.ts`
- `npx tsc --noEmit`

---

### Self-Review

- 覆盖用户要求：方案 A，业务分析节点期间心跳；动态点点，不是固定文案。
- 风险：真实企微端到端只能部署后观察；本地验证覆盖内容生成和编译。
