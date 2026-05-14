# MCP Tool Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a whitelist mechanism to restrict the MCP tools available to the agent.

**Architecture:** Add an `ALLOWED_TOOLS` environment variable (comma-separated list). Update the configuration loader to parse this list and modify `getAllMcpTools` to filter the loaded tools accordingly.

**Tech Stack:** TypeScript, Zod, LangChain MCP Adapters.

---

### Task 1: Update Configuration

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add `ALLOWED_TOOLS` to the environment schema in `src/config.ts`**

```typescript
const envSchema = z.object({
  // ... existing fields ...
  ALLOWED_TOOLS: z.string().optional(),
});
```

- [ ] **Step 2: Update the `config` export to include the parsed allowed tools list**

```typescript
export const config = {
  ...parsedEnv,
  mcpServers: z.array(mcpServerSchema).parse(mcpServers),
  allowedTools: parsedEnv.ALLOWED_TOOLS ? parsedEnv.ALLOWED_TOOLS.split(",").map(t => t.trim()) : null,
};
```

- [ ] **Step 3: Add `ALLOWED_TOOLS` to `.env.example`**

```text
# 可选：允许使用的 MCP 工具列表（英文逗号分隔），为空则允许所有工具
# ALLOWED_TOOLS=tool_name_1,tool_name_2
```

### Task 2: Implement Tool Filtering

**Files:**
- Modify: `src/mcp-client.ts`

- [ ] **Step 1: Update `getAllMcpTools` to filter tools based on `config.allowedTools`**

```typescript
export async function getAllMcpTools() {
  let allTools = [];

  for (const server of config.mcpServers) {
    // ... connection logic remains same ...
    const tools = await loadMcpTools(server.name, client);
    allTools.push(...tools);
  }

  // 过滤工具
  if (config.allowedTools && config.allowedTools.length > 0) {
    const whitelist = new Set(config.allowedTools);
    allTools = allTools.filter(tool => whitelist.has(tool.name));
    console.log(`Filtered tools: ${allTools.length} tools allowed out of original set.`);
  }

  return allTools;
}
```

### Task 3: Verification

**Files:**
- Create: `src/tests/test-tool-filtering.ts`

- [ ] **Step 1: Create a test script to verify tool filtering**

```typescript
import { config } from "../config.js";
import { getAllMcpTools } from "../mcp-client.js";

async function testFiltering() {
  console.log("Current allowed tools config:", config.allowedTools);
  
  const tools = await getAllMcpTools();
  console.log("Loaded tools names:", tools.map(t => t.name));

  if (config.allowedTools) {
    const allAllowed = tools.every(t => config.allowedTools!.includes(t.name));
    if (allAllowed) {
      console.log("SUCCESS: All loaded tools are in the whitelist.");
    } else {
      console.log("FAILED: Found tools not in the whitelist.");
      process.exit(1);
    }
  } else {
    console.log("No whitelist configured, all tools loaded.");
  }
}

testFiltering();
```

- [ ] **Step 2: Run test with a mock whitelist**

Run: `export ALLOWED_TOOLS="get_file_problems,grep_search"; npx tsc; node dist/tests/test-tool-filtering.js`
(Note: Use PowerShell syntax on Windows: `$env:ALLOWED_TOOLS="get_file_problems,grep_search"; npx tsc; node dist/tests/test-tool-filtering.js`)

- [ ] **Step 3: Commit changes**

```bash
git add src/config.ts .env.example src/mcp-client.ts
git commit -m "feat: add support for MCP tool filtering via ALLOWED_TOOLS env var"
```
