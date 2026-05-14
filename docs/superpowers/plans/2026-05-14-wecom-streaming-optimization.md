# Refactor WeCom Streaming Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify `src/wecom-adapter.ts` to filter out intermediate AI messages that contain tool calls during the streaming process, ensuring only the final result is sent to the user.

**Architecture:** Update the `agent.stream` loop in `startBot` function to detect intermediate `AIMessage` objects with `tool_calls`. When detected, skip the message, reset the accumulated content, and log the event.

**Tech Stack:** TypeScript, LangChain (BaseMessage)

---

### Task 1: Modify `src/wecom-adapter.ts`

**Files:**
- Modify: `src/wecom-adapter.ts:167-185`

- [ ] **Step 1: Update the streaming loop logic**

Locate the `for await (const [message, metadata] of stream)` loop and insert the filtering logic.

```typescript
        for await (const [message, metadata] of stream) {
          const msg = message as any; // Cast to any to access tool_calls and _getType
          lastMessages.push(msg);

          // 核心优化：如果 AI 消息包含工具调用，说明是中间思考过程，不发给用户
          if (msg._getType() === "ai" && msg.tool_calls && msg.tool_calls.length > 0) {
            console.log(`[Stream] Detected intermediate tool call for ${body.msgid}, skipping preamble.`);
            fullContent = ""; // 清空缓冲区，移除之前的思考文本（如 "我来为您查询..."）
            continue;
          }

          if (msg._getType() === "ai" && msg.content) {
            const delta = msg.content.toString();
            fullContent += delta;
            
            // 只有当有实质性内容更新且超过间隔时间时才发送更新
            if (delta.length > 0 && Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
              await bot.replyStream(frame, streamId, fullContent, false);
              lastUpdateTime = Date.now();
            }
          }
        }
```

- [ ] **Step 2: Verify compilation**

Run: `npm run build` or `npx tsc`
Expected: No errors.

- [ ] **Step 3: Commit changes**

```bash
git add src/wecom-adapter.ts
git commit -m "feat: filter intermediate tool calls in streaming loop"
```
