# WeCom Agent Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable real-time streaming of LLM responses in Enterprise WeChat with a "processing" card feedback.

**Architecture:** Use LangChain's `.stream()` API to capture tokens and the WeCom SDK's `replyStream` API to update the message in-place.

**Tech Stack:** TypeScript, LangChain JS, @wecom/aibot-node-sdk.

---

### Task 1: Update `graph.ts` to support streaming

**Files:**
- Modify: `src/graph.ts`

- [ ] **Step 1: Modify `initializeAgent` to return the agent object directly**
The current `createAgent` returns an object that supports `.stream()`.

- [ ] **Step 2: Verify `initializeAgent` logic**
No changes needed to the initialization itself, but ensure it's exported correctly.

### Task 2: Implement Streaming Logic in `wecom-adapter.ts`

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Import `generateReqId` from SDK**
```typescript
import { WSClient, MessageType, generateReqId } from "@wecom/aibot-node-sdk";
```

- [ ] **Step 2: Refactor message handler to use streaming**
Replace `agent.invoke` with `agent.stream`.
Use `bot.replyStreamWithCard` for the first frame.
Use `bot.replyStream` for subsequent chunks.

```typescript
    try {
      const streamId = generateReqId('stream');
      let firstFrame = true;
      let fullContent = "";

      const stream = await agent.stream({
        messages: [new HumanMessage({ content: parsedContent as any })],
      });

      for await (const chunk of stream) {
        // Handle LangChain agent stream chunks
        // Depending on createAgent, chunks might be messages or tool calls
        const msg = chunk.messages?.[chunk.messages.length - 1];
        if (!msg || !msg.content) continue;
        
        fullContent = msg.content.toString();

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

      // Final frame
      await bot.replyStream(frame, streamId, fullContent, true);
    } catch (error) {
      console.error("Error processing message:", error);
    }
```

- [ ] **Step 3: Add basic throttling (Optional but recommended)**
To avoid hitting WeCom rate limits if the LLM is too fast.

### Task 3: Verification

**Files:**
- Test: `src/test-simple.ts`

- [ ] **Step 1: Update `test-simple.ts` to verify streaming locally**
```typescript
    const stream = await agent.stream({
      messages: [new HumanMessage(query)],
    });
    
    console.log("\n--- Agent Streaming Response ---");
    for await (const chunk of stream) {
      process.stdout.write("."); // Print dots for chunks
    }
    console.log("\nStream finished.");
```

- [ ] **Step 2: Run local build and verification**
Run: `npx tsc; node dist/test-simple.js`

- [ ] **Step 3: Final Deployment**
Run: `bash deploy.sh`
