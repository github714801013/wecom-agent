# WeCom Mixed Quote Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `wecom-agent` to correctly parse and extract content from `mixed` type quotes in WeCom messages, ensuring both text and images are captured.

**Architecture:** Update `wecom-adapter.ts` to handle the `mixed` msgtype in the `quote` field by iterating through its `msg_item` array.

**Tech Stack:** TypeScript, Node.js

---

### Task 1: Create failing test for mixed quote parsing

**Files:**
- Create: `src/test-mixed-quote.ts`
- Modify: `wecom-adapter.js` (implicitly via test import)

- [ ] **Step 1: Write the failing test**

```typescript
import { parseWeComMessage } from "./wecom-adapter.js";

const mockBody = {
  msgid: "ca1dcb56cca103e520ca48ced3ba2440",
  msgtype: "text",
  text: { content: "@OA智能助手 这张图片里面有什么" },
  quote: {
    msgtype: "mixed",
    mixed: {
      msg_item: [
        { msgtype: "text", text: { content: "@OA智能助手 美团国补订单..." } },
        { msgtype: "image", image: { url: "https://ww-aibot-img.example.com/test.jpg" } }
      ]
    }
  }
};

const result = parseWeComMessage(mockBody);
console.log("Parsed content:", JSON.stringify(result, null, 2));

const hasText = JSON.stringify(result).includes("美团国补订单");
const hasImage = JSON.stringify(result).includes("https://ww-aibot-img.example.com/test.jpg");

if (hasText && hasImage) {
  console.log("Test PASSED");
} else {
  console.log("Test FAILED: Mixed quote content missing parts");
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc && node dist/test-mixed-quote.js`
Expected: FAIL with "Test FAILED: Mixed quote content missing parts"

- [ ] **Step 3: Commit**

```bash
git add src/test-mixed-quote.ts
git commit -m "test: add failing test for mixed quote parsing"
```
