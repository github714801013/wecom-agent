# Claude Agent SDK Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LangChain agent logic with Claude Agent SDK to support dynamic MCP tools and business skills.

**Architecture:** 
1. **Engine Layer**: Use `query` from `@anthropic-ai/claude-agent-sdk` as the primary reasoning engine.
2. **Tool Adapter**: Convert existing MCP tools to SDK-compatible `Tool` objects.
3. **Skill Library**: Implement `.claude/skills/` directory structure for business SOPs.
4. **UX Mapping**: Map SDK event stream (text, toolUse, thought) to WeCom Markdown updates.

**Tech Stack:** 
- `@anthropic-ai/claude-agent-sdk`
- `@modelcontextprotocol/sdk`
- `@wecom/aibot-node-sdk`
- TypeScript

---

### Task 1: Environment & Dependencies Setup

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install Claude Agent SDK**

Run: `npm install @anthropic-ai/claude-agent-sdk`

- [ ] **Step 2: Add Claude specific env vars**

Update `.env.example`:
```env
# Existing LLM vars stay the same
# Add explicit SDK options if needed
CLAUDE_PERMISSION_MODE=acceptEdits
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add @anthropic-ai/claude-agent-sdk dependency"
```

---

### Task 2: Tool Transformation Logic

**Files:**
- Modify: `src/mcp-client.ts`

- [ ] **Step 1: Implement getClaudeTools function**

Add to `src/mcp-client.ts`:
```typescript
import { Tool } from "@anthropic-ai/claude-agent-sdk";

export async function getClaudeTools(): Promise<Tool[]> {
  const mcpTools = await getAllMcpTools();
  return mcpTools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema, // Assuming LangChain tool schema maps closely
    call: async (args: any) => {
        const result = await t.invoke(args);
        return typeof result === 'string' ? result : JSON.stringify(result);
    }
  }));
}
```

- [ ] **Step 2: Create a verification script**

Create `src/tests/verify-claude-tools.ts`:
```typescript
import { getClaudeTools } from "../mcp-client.js";

async function test() {
  const tools = await getClaudeTools();
  console.log(`Successfully converted ${tools.length} tools.`);
  if (tools.length > 0) {
    console.log("First tool sample:", JSON.stringify(tools[0], null, 2));
  }
}
test();
```

- [ ] **Step 3: Run verification**

Run: `npx tsc; node dist/tests/verify-claude-tools.js`
Expected: Successfully prints tool count and sample.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-client.ts src/tests/verify-claude-tools.ts
git commit -m "feat: implement MCP tool transformation for Claude SDK"
```

---

### Task 3: Core Agent Engine Refactor

**Files:**
- Modify: `src/graph.ts`

- [ ] **Step 1: Replace LangChain Agent with Claude SDK query**

```typescript
import { query, Tool } from "@anthropic-ai/claude-agent-sdk";
import { getClaudeTools } from "./mcp-client.js";
import { config } from "./config.js";
import { join } from "path";
import { readFile } from "fs/promises";

// Remove createAgent, initializeAgent, etc.
// Keep getSystemPrompt, getBaseModel (for recovery if needed)

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

- [ ] **Step 2: Fix TypeScript errors in src/graph.ts**

Ensure all unused LangChain imports are removed.

- [ ] **Step 3: Commit**

```bash
git add src/graph.ts
git commit -m "refactor: replace LangChain engine with Claude Agent SDK query"
```

---

### Task 4: WeCom Adapter UX Mapping

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Update bot message handler to use runClaudeAgent**

```typescript
// Inside bot.on("message", ...)
// Replace agent.stream block with:

const stream = runClaudeAgent(parsedContent as string, sessionKey);
let fullContent = "";
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 2000;

for await (const event of stream) {
    if (event.type === "text") {
        fullContent += event.content;
        if (Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
            await bot.replyStream(frame, streamId, fullContent, false);
            lastUpdateTime = Date.now();
        }
    }
    // Thought and toolUse are handled silently by not emitting them to replyStream
}
```

- [ ] **Step 2: Handle image content in prompt**

Ensure `parsedContent` (if array for multi-modal) is correctly handled by `runClaudeAgent`.

- [ ] **Step 3: Commit**

```bash
git add src/wecom-adapter.ts
git commit -m "feat: map Claude SDK events to WeCom stream"
```

---

### Task 5: Skill Library Setup

**Files:**
- Create: `.claude/skills/demo-skill/SKILL.md`

- [ ] **Step 1: Create skill directory**

Run: `mkdir -p .claude/skills/demo-skill`

- [ ] **Step 2: Create a demo skill**

Write to `.claude/skills/demo-skill/SKILL.md`:
```markdown
---
name: internal_system_expert
description: Expert in internal CH999 systems and SOPs.
---
You MUST strictly follow these rules:
1. Always prefix internal system IDs with 'ID-'.
2. If unsure about a system, refer to the 'jiuji-admin' project.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/demo-skill/SKILL.md
git commit -m "feat: setup initial business skill library"
```

---

### Task 6: Final Verification & Deployment

- [ ] **Step 1: Run full compilation check**

Run: `npx tsc`
Expected: 0 errors.

- [ ] **Step 2: Deploy to remote**

Run: `bash deploy.sh`

- [ ] **Step 3: Test via WeCom**

Send: "请根据内部系统专家技能，帮我查询 ID-123 的状态。"
Verify: AI recognizes the skill and uses gitnexus tools.
