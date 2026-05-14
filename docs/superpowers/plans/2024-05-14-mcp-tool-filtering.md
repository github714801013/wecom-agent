# Update Configuration for MCP Tool Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ALLOWED_TOOLS` configuration option to support tool whitelisting in the MCP client.

**Architecture:** Update the Zod environment schema to include the optional `ALLOWED_TOOLS` string, then parse and transform it into a string array in the exported configuration object. Update documentation/examples accordingly.

**Tech Stack:** TypeScript, Zod, Dotenv

---

### Task 1: Update Environment Schema and Config Object

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add ALLOWED_TOOLS to envSchema**

```typescript
const envSchema = z.object({
  // ...
  MCP_SERVERS: z.string().optional(),
  ALLOWED_TOOLS: z.string().optional(),
});
```

- [ ] **Step 2: Add allowedTools property to the exported config object**

```typescript
export const config = {
  ...parsedEnv,
  mcpServers: z.array(mcpServerSchema).parse(mcpServers),
  allowedTools: parsedEnv.ALLOWED_TOOLS ? parsedEnv.ALLOWED_TOOLS.split(",").map(t => t.trim()) : null,
};
```

- [ ] **Step 3: Verify changes compile**

Run: `npx tsc --noEmit`
Expected: No compilation errors.

### Task 2: Update .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add ALLOWED_TOOLS example to .env.example**

```text
# 可选：允许使用的 MCP 工具列表（英文逗号分隔），为空则允许所有工具
# ALLOWED_TOOLS=tool_name_1,tool_name_2
```

### Task 3: Verification

- [ ] **Step 1: Create a temporary test file to verify config parsing**

Create: `src/tests/test-config-parsing.ts`

```typescript
import { config } from "../config";

console.log("Config allowedTools:", config.allowedTools);

// Test case 1: Simulate ALLOWED_TOOLS environment variable
process.env.ALLOWED_TOOLS = "tool1, tool2, tool3";
// Since config is already exported, we might need to re-import or manually trigger parsing 
// if we want to test different values in the same process, but for basic verification
// of the logic added, checking the initial value is enough.
```

- [ ] **Step 2: Run the test**

Run: `npx ts-node src/tests/test-config-parsing.ts`
Expected: Outputs the parsed tools or null depending on current .env file.
