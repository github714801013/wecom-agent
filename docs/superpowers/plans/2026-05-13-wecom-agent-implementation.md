# WeCom Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a WeCom intelligent robot that utilizes LangGraphJS to orchestrate tool calls (Remote GitNexus MCP) via the MiniMax-M2.5 model.

**Architecture:** Scheme A (React Agent) using `@langchain/langgraph/prebuilt`. It connects to WeCom via WebSocket (Bot mode) and to GitNexus via SSE.

**Tech Stack:** Node.js, TypeScript, LangGraphJS, MCP SDK, @wecom/wecom-openclaw-plugin, @langchain/openai.

---

### Task 1: Environment & Configuration

**Files:**
- Create: `.env`
- Create: `src/config.ts`

- [ ] **Step 1: Populate .env with placeholders**
```env
WECOM_BOT_ID=your_bot_id
WECOM_BOT_SECRET=your_bot_secret
WECOM_WS_URL=ws://your-gateway-url
MINIMAX_API_KEY=your_api_key
MINIMAX_BASE_URL=https://dashscope.ch999.cn/base/v1
MCP_REMOTE_URL=http://10.1.14.177:1348/sse
```

- [ ] **Step 2: Create config.ts to load and validate env**
```typescript
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  WECOM_BOT_ID: z.string(),
  WECOM_BOT_SECRET: z.string(),
  WECOM_WS_URL: z.string(),
  MINIMAX_API_KEY: z.string(),
  MINIMAX_BASE_URL: z.string(),
  MCP_REMOTE_URL: z.string(),
});

export const config = envSchema.parse(process.env);
```

- [ ] **Step 3: Commit**
```bash
git add .env src/config.ts
git commit -m "chore: setup environment and config validation"
```

---

### Task 2: MCP Remote Client

**Files:**
- Create: `src/mcp-client.ts`

- [ ] **Step 1: Implement MCP SSE client connection**
```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { config } from "./config";

export async function getGitNexusTools() {
  const transport = new SSEClientTransport(new URL(config.MCP_REMOTE_URL));
  const client = new Client(
    { name: "wecom-agent-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return await loadMcpTools("gitnexus", client);
}
```

- [ ] **Step 2: Commit**
```bash
git add src/mcp-client.ts
git commit -m "feat: implement remote MCP client for GitNexus"
```

---

### Task 3: LangGraph Agent Engine

**Files:**
- Create: `src/graph.ts`

- [ ] **Step 1: Initialize ChatOpenAI for MiniMax and create React Agent**
```typescript
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { getGitNexusTools } from "./mcp-client";
import { config } from "./config";

export async function createAgent() {
  const model = new ChatOpenAI({
    modelName: "minimax-m2.5",
    apiKey: config.MINIMAX_API_KEY,
    configuration: {
      baseURL: config.MINIMAX_BASE_URL,
    },
    temperature: 0,
  });

  const tools = await getGitNexusTools();
  return createReactAgent({
    llm: model,
    tools,
  });
}
```

- [ ] **Step 2: Commit**
```bash
git add src/graph.ts
git commit -m "feat: initialize LangGraph React Agent with MiniMax and MCP tools"
```

---

### Task 4: WeCom WebSocket Adapter

**Files:**
- Create: `src/wecom-adapter.ts`

- [ ] **Step 1: Implement WeCom WebSocket listener and bridge to Agent**
```typescript
import { WeComBot } from "@wecom/wecom-openclaw-plugin";
import { createAgent } from "./graph";
import { config } from "./config";
import { HumanMessage } from "@langchain/core/messages";

export async function startBot() {
  const agent = await createAgent();
  const bot = new WeComBot({
    botId: config.WECOM_BOT_ID,
    secret: config.WECOM_BOT_SECRET,
    wsUrl: config.WECOM_WS_URL,
  });

  bot.on("message", async (msg) => {
    if (msg.type === "text") {
      const response = await agent.invoke({
        messages: [new HumanMessage(msg.content)],
      });
      const lastMsg = response.messages[response.messages.length - 1];
      await bot.sendText(msg.chatId, lastMsg.content.toString());
    }
  });

  await bot.start();
  console.log("WeCom Bot started.");
}
```

- [ ] **Step 2: Commit**
```bash
git add src/wecom-adapter.ts
git commit -m "feat: implement WeCom WebSocket adapter and link to agent"
```

---

### Task 5: Main Entry & Verification

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Wire up the entry point**
```typescript
import { startBot } from "./wecom-adapter";

startBot().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and verify compilation**
Run: `npx tsc`
Expected: Success (dist folder created)

- [ ] **Step 3: Commit**
```bash
git add src/index.ts
git commit -m "feat: wire up entry point and verify build"
```
