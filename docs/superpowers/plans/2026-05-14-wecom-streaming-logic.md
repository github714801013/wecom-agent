# WeCom Agent Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the message handling logic in `src/wecom-adapter.ts` to support streaming responses in WeCom using the WeCom SDK's streaming methods.

**Architecture:** Replace the current synchronous `agent.invoke` call with an asynchronous `agent.stream` loop. Use `bot.replyStreamWithCard` for the initial "processing" state and `bot.replyStream` for incremental updates. Ensure the stream is correctly closed with the `finish: true` flag.

**Tech Stack:** TypeScript, @wecom/aibot-node-sdk, LangChain.

---

### Task 1: Update Imports and Basic Streaming Setup

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Update SDK imports to include `generateReqId`**

```typescript
import { WSClient, MessageType, generateReqId } from "@wecom/aibot-node-sdk";
```

- [ ] **Step 2: Replace `agent.invoke` with `agent.stream` and implement the stream loop**

```typescript
    try {
      const streamId = generateReqId('stream');
      let firstFrame = true;
      let lastContent = "";

      const stream = await agent.stream({
        messages: [new HumanMessage({ content: parsedContent as any })],
      });

      for await (const chunk of stream) {
        // Handle LangChain agent stream chunks
        // Chunks from createAgent typically contain 'messages' or node updates
        // We look for the most recent message content
        const msg = chunk.messages?.[chunk.messages.length - 1];
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
    } catch (error) {
      console.error("Error processing message:", error);
    }
```

### Task 2: Verification and Compilation

**Files:**
- Run: `npx tsc`

- [ ] **Step 1: Run TypeScript compiler to verify type safety**

Run: `npx tsc`
Expected: No errors related to `src/wecom-adapter.ts`.

- [ ] **Step 2: Commit changes**

```bash
git add src/wecom-adapter.ts
git commit -m "feat: implement streaming response in WeCom adapter"
```
