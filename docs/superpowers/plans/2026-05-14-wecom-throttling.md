# WeCom Streaming Throttling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a throttling mechanism in `src/wecom-adapter.ts` to limit the frequency of WeCom WebSocket updates during streaming, preventing connection congestion while ensuring responsiveness.

**Architecture:** A time-based throttling approach using an `UPDATE_INTERVAL` (300ms). The first frame (initial card) and the final frame (completion) are sent immediately. Intermediate frames are only sent if at least 300ms have passed since the last update.

**Tech Stack:** TypeScript, Node.js, WeCom AI Bot SDK.

---

### Task 1: Implement Throttling Logic in `src/wecom-adapter.ts`

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Define constants and update loop logic**

In `src/wecom-adapter.ts`, inside the `bot.on("message", ...)` handler, add `UPDATE_INTERVAL` and `lastUpdateTime`. Update the streaming loop to use these for throttling.

```typescript
<<<<
      const streamId = generateReqId('stream');
      let firstFrame = true;
      let lastContent = "";

      const stream = await agent.stream({
        messages: [new HumanMessage({ content: parsedContent as any })],
      });

      for await (const chunk of stream) {
        // Handle LangChain agent stream chunks
        // Chunks from createAgent typically contain 'messages' or node updates
        const anyChunk = chunk as any;
        const messages = anyChunk.messages || 
                         (Object.values(anyChunk)[0] as any)?.messages;
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) continue;
        
        const msg = messages[messages.length - 1];
        if (!msg || !msg.content) continue;
        
        const fullContent = msg.content.toString();
        if (fullContent === lastContent) continue;
        lastContent = fullContent;

        if (firstFrame) {
          await bot.replyStreamWithCard(frame, streamId, "AI 正在思考中...", false, {
            templateCard: {
              card_type: 'text_notice',
              main_title: { title: '任务处理中', desc: 'AI 助手正在分析您的请求...' },
              task_id: `task_${Date.now()}`,
            }
          });
          firstFrame = false;
        } else {
          await bot.replyStream(frame, streamId, fullContent, false);
        }
      }

      // Final frame to close the stream
      await bot.replyStream(frame, streamId, lastContent || "处理完成", true);
====
      const streamId = generateReqId('stream');
      let firstFrame = true;
      let lastContent = "";
      let lastUpdateTime = Date.now();
      const UPDATE_INTERVAL = 300; // ms

      const stream = await agent.stream({
        messages: [new HumanMessage({ content: parsedContent as any })],
      });

      for await (const chunk of stream) {
        // Handle LangChain agent stream chunks
        // Chunks from createAgent typically contain 'messages' or node updates
        const anyChunk = chunk as any;
        const messages = anyChunk.messages || 
                         (Object.values(anyChunk)[0] as any)?.messages;
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) continue;
        
        const msg = messages[messages.length - 1];
        if (!msg || !msg.content) continue;
        
        const fullContent = msg.content.toString();
        if (fullContent === lastContent) continue;
        lastContent = fullContent;

        if (firstFrame) {
          await bot.replyStreamWithCard(frame, streamId, "AI 正在思考中...", false, {
            templateCard: {
              card_type: 'text_notice',
              main_title: { title: '任务处理中', desc: 'AI 助手正在分析您的请求...' },
              task_id: `task_${Date.now()}`,
            }
          });
          firstFrame = false;
          lastUpdateTime = Date.now();
        } else {
          const now = Date.now();
          if (now - lastUpdateTime > UPDATE_INTERVAL) {
            await bot.replyStream(frame, streamId, fullContent, false);
            lastUpdateTime = now;
          }
        }
      }

      // Final frame to close the stream - ALWAYS sent immediately
      await bot.replyStream(frame, streamId, lastContent || "处理完成", true);
>>>>
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc`
Expected: Success with no errors.

- [ ] **Step 3: Commit changes**

```bash
git add src/wecom-adapter.ts
git commit -m "perf: add throttling logic to WeCom streaming updates"
```
