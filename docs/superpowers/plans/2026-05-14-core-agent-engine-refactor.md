# Core Agent Engine Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the core agent engine to use the Claude Agent SDK instead of LangChain for better tool calling and skill integration.

**Architecture:** Replace LangChain's `createAgent` with `query` from `@anthropic-ai/claude-agent-sdk`. Keep helper functions for system prompt and context window calculation. Ensure session history and error recovery remain compatible.

**Tech Stack:** TypeScript, @anthropic-ai/claude-agent-sdk, MCP

---

### Task 1: Refactor src/graph.ts

**Files:**
- Modify: `src/graph.ts`

- [ ] **Step 1: Update imports and remove LangChain agent logic**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getClaudeTools } from "./mcp-client.js";
import { config } from "./config.js";
import { join } from "path";
import { readFile } from "fs/promises";
import { getModelContextSize } from "@langchain/core/language_models/base";
import { ChatOpenAI } from "@langchain/openai";

// Keep MODEL_CONTEXT_MAP, getModelContextWindow, getBaseModel, getSystemPrompt
```

- [ ] **Step 2: Implement runClaudeAgent**

```typescript
export async function* runClaudeAgent(prompt: string, sessionKey: string) {
  const tools = await getClaudeTools();
  const systemPrompt = await getSystemPrompt();

  const options = {
    model: config.LLM_MODEL_NAME,
    apiKey: config.LLM_API_KEY,
    baseURL: config.LLM_BASE_URL,
    systemPrompt: systemPrompt,
    tools: tools,
    permissionMode: "acceptEdits" as const,
    settingSources: [process.cwd()], // Auto loads .claude/skills/
  };

  yield* query({
    prompt,
    options
  });
}
```

- [ ] **Step 3: Remove initializeAgent and unused code**

Remove `clearHistoryTool`, `initializeAgent`, and unused LangChain imports (`createAgent`, `tool`, etc.).

- [ ] **Step 4: Commit**

```bash
git add src/graph.ts
git commit -m "refactor: replace LangChain engine with Claude Agent SDK query in graph.ts"
```

### Task 2: Update src/wecom-adapter.ts

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Update imports and remove LangChain dependencies**

```typescript
import { WSClient, MessageType } from "@wecom/aibot-node-sdk";
import { runClaudeAgent, getBaseModel, getSystemPrompt, getModelContextWindow } from "./graph.js";
import { config } from "./config.js";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { sessionManager } from "./session-manager.js";
import { fetchImageAsBase64, downloadMediaFile } from "./media-helper.js";
```

- [ ] **Step 2: Update startBot to use runClaudeAgent**

Refactor the bot's message handler to use `runClaudeAgent`. Handle streaming and session updates accordingly.

- [ ] **Step 3: Commit**

```bash
git add src/wecom-adapter.ts
git commit -m "refactor: update wecom-adapter to use runClaudeAgent"
```

### Task 3: Update and Run Tests

**Files:**
- Modify: `src/tests/test-simple.ts`
- Modify: `src/tests/test-query.ts`

- [ ] **Step 1: Update test-simple.ts**

```typescript
import { runClaudeAgent } from "../graph.js";

async function testSimple() {
  const query = "你是谁？";
  console.log(`Sending query: "${query}"`);
  
  try {
    let fullResponse = "";
    for await (const chunk of runClaudeAgent(query, "test-session")) {
      if (chunk.type === "text") {
        fullResponse += chunk.content;
        process.stdout.write(chunk.content);
      }
    }
    console.log("\n--- Done ---");
  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    process.exit(0);
  }
}
testSimple();
```

- [ ] **Step 2: Run test-simple.ts**

Run: `npx ts-node --esm src/tests/test-simple.ts`
Expected: Streamed response from the agent.

- [ ] **Step 3: Update test-query.ts**

Similar update as `test-simple.ts` to use `runClaudeAgent`.

- [ ] **Step 4: Run test-query.ts**

Run: `npx ts-node --esm src/tests/test-query.ts`
Expected: Successful execution of a query involving MCP tools.

- [ ] **Step 5: Commit**

```bash
git add src/tests/test-simple.ts src/tests/test-query.ts
git commit -m "test: update tests to use runClaudeAgent"
```
