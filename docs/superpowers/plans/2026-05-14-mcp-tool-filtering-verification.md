# Verify MCP Tool Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a test script to verify that MCP tools are correctly filtered based on the `ALLOWED_TOOLS` environment variable.

**Architecture:** The test will set up a specific whitelist via environment variables, call the existing `getAllMcpTools` function, and assert that only whitelisted tools are returned.

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk`.

---

### Task 1: Create Test Script

**Files:**
- Create: `src/tests/test-tool-filtering.ts`

- [ ] **Step 1: Write the test script content**

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

testFiltering().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Compile the project**

Run: `npx tsc`
Expected: SUCCESS

- [ ] **Step 3: Run the test with whitelist**

Run: `$env:ALLOWED_TOOLS="query,cypher,read_query"; node dist/tests/test-tool-filtering.js`
Expected: Output should show only `query`, `cypher`, `read_query` (if available from servers) and "SUCCESS: All loaded tools are in the whitelist."

- [ ] **Step 4: Run the test without whitelist**

Run: `$env:ALLOWED_TOOLS=""; node dist/tests/test-tool-filtering.js`
Expected: Output should show "No whitelist configured, all tools loaded."

- [ ] **Step 5: Commit changes**

```bash
git add src/tests/test-tool-filtering.ts
git commit -m "test: add MCP tool filtering verification test"
```
