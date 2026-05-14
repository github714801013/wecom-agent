# WeCom Agent Conversation Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conversation memory to the WeCom agent with a 20-message limit and 30-minute expiration, and support a `/new` reset command.

**Architecture:** Implement an in-memory `SessionManager` in `src/wecom-adapter.ts` that stores `BaseMessage` arrays per `chatId`. Before processing each message, prune the session history based on time and count. If the message is `/new`, clear the session history immediately.

**Tech Stack:** TypeScript, LangChain Core Messages.

---

### Task 1: Implement Session Management in `src/wecom-adapter.ts`

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Define the `Session` interface and storage at the module level**

```typescript
interface Session {
  messages: BaseMessage[];
  lastActivity: number;
}

const sessions = new Map<string, Session>();
const SESSION_EXPIRATION_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES_PER_SESSION = 20;
```

- [ ] **Step 2: Update `startBot` message listener to handle session logic and `/new` command**

Insert the session handling logic before calling `agent.stream`.

```typescript
    const parsedContent = parseWeComMessage(body);
    const chatId = body.chatid || body.from?.userid;

    if (!chatId) return;

    // --- Session Handling Start ---
    const now = Date.now();
    let session = sessions.get(chatId);

    // Handle /new command
    const isNewCommand = typeof parsedContent === 'string' && parsedContent.trim().toLowerCase() === '/new';
    
    if (isNewCommand) {
      sessions.delete(chatId);
      processedMsgs.add(body.msgid); // Mark this message as processed
      await bot.replyStreamWithCard(frame, body.msgid, "已为您清理所有会话记录，我们可以开始新的对话了。", true, {
        templateCard: {
          card_type: 'text_notice',
          main_title: { title: '会话已重置', desc: '历史记录已清理' },
        }
      });
      return;
    }

    if (session) {
      // Expiration check
      if (now - session.lastActivity > SESSION_EXPIRATION_MS) {
        session.messages = [];
      }
      // Count check (keep last 20)
      if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
        session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
      }
    } else {
      session = { messages: [], lastActivity: now };
      sessions.set(chatId, session);
    }
    
    session.lastActivity = now;
    // --- Session Handling End ---
```

- [ ] **Step 3: Update `agent.stream` to use session messages**

```typescript
        const stream = await agent.stream({
          messages: [...session.messages, new HumanMessage({ content: parsedContent as any })],
        }, {
          recursionLimit: config.LLM_RECURSION_LIMIT,
          streamMode: "messages",
        });
```

- [ ] **Step 4: Update session history with Human and AI messages**

Add the current Human message and the final AI response to the session history.

```typescript
      // Before stream loop
      const humanMsg = new HumanMessage({ content: parsedContent as any });

      // After stream loop, update session
      if (fullContent) {
        session.messages.push(humanMsg);
        session.messages.push(new AIMessage(fullContent));
        
        // Ensure we don't exceed limit after adding new ones
        if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
          session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
        }
      }
```

### Task 2: Verification

**Files:**
- Create: `src/tests/test-session-memory.ts`

- [ ] **Step 1: Create a test script to verify session persistence**

```typescript
import { parseWeComMessage } from "../wecom-adapter.js";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

// Note: Testing private module variables like `sessions` might require exporting them or 
// testing via the public bot interface. For a quick verification, I'll create a 
// dedicated test-session logic in a new file.

async function testSessionLogic() {
  const messages: any[] = [];
  const MAX = 4; // Use small number for test
  
  function add(m: any) {
    messages.push(m);
    if (messages.length > MAX) {
      return messages.slice(-MAX);
    }
    return messages;
  }

  let history = add(new HumanMessage("1"));
  history = add(new AIMessage("1-reply"));
  history = add(new HumanMessage("2"));
  history = add(new AIMessage("2-reply"));
  history = add(new HumanMessage("3"));
  
  console.log("History length:", history.length);
  if (history.length === 4) {
    console.log("SUCCESS: Pruning works.");
  } else {
    console.log("FAILED: Pruning failed.");
    process.exit(1);
  }
}

testSessionLogic();
```

- [ ] **Step 2: Run verification**

Run: `npx tsc; node dist/tests/test-session-memory.js`

- [ ] **Step 3: Commit changes**

```bash
git add src/wecom-adapter.ts
git commit -m "feat: add conversation memory and /new command support"
```
