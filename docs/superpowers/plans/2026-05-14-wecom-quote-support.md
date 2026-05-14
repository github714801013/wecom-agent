# WeCom Agent Quote Context Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the AI agent can reuse content from referenced/quoted messages in WeCom, especially when users follow up with "Continue" or similar commands.

**Architecture:** Modify `parseWeComMessage` in `src/wecom-adapter.ts` to detect the `quote` field in the message body and merge its content into the main prompt sent to the LLM.

**Tech Stack:** TypeScript, @wecom/aibot-node-sdk.

---

### Task 1: Add Unit Test for Quoted Message Parsing

**Files:**
- Create: `src/test-quote-parsing.ts`

- [ ] **Step 1: Create a test script to simulate quoted message parsing**

```typescript
import { MessageType } from "@wecom/aibot-node-sdk";

// Mock implementation of parseWeComMessage (copy from src/wecom-adapter.ts for isolated test)
function parseWeComMessage(body: any): string | any[] {
  const msgType = body.msgtype;
  const fromUser = body.from?.userid || "unknown";

  let mainContent: any = "";

  switch (msgType) {
    case MessageType.Text:
      mainContent = body.text.content;
      break;
    default:
      mainContent = `[Unhandled msgtype: ${msgType}]`;
  }

  // TODO: Implement quote parsing here later
  return mainContent;
}

const mockBody = {
  msgid: "7378310b32d71f8bdc3027a9e54e2d92",
  msgtype: "text",
  text: { content: "@OA智能助手 继续" },
  quote: {
    msgtype: "text",
    text: { content: "@OA智能助手 样机折旧逻辑" }
  }
};

const result = parseWeComMessage(mockBody);
console.log("Parsed content:", result);

if (result.includes("样机折旧逻辑")) {
  console.log("Test PASSED");
} else {
  console.log("Test FAILED: Quote content not found in result");
  process.exit(1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc src/test-quote-parsing.ts --esModuleInterop --moduleResolution node --target esnext; node src/test-quote-parsing.js`
Expected: FAIL with "Quote content not found in result"

### Task 2: Implement Quote Parsing Logic

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Refactor `parseWeComMessage` to handle the `quote` field**

```typescript
function parseWeComMessage(body: any): string | { type: string; text?: string; image_url?: string }[] {
  const msgType = body.msgtype;
  const fromUser = body.from?.userid || "unknown";
  
  let content: any = "";

  switch (msgType) {
    case MessageType.Text:
      content = body.text.content;
      break;

    case MessageType.Image:
      content = [
        { type: "text", text: `[用户 ${fromUser} 发送了一张图片]` },
        { type: "image_url", image_url: body.image.url }
      ];
      break;

    case MessageType.Voice:
      const recognition = body.voice?.recognition || "";
      content = `[用户 ${fromUser} 发送了一段语音] ${recognition ? `(识别结果: ${recognition})` : "(未识别到文字)"}`;
      break;

    case MessageType.Video:
      content = `[用户 ${fromUser} 发送了一个视频] (链接: ${body.video?.url})`;
      break;

    case MessageType.File:
      content = `[用户 ${fromUser} 发送了一个文件] 名称: ${body.file?.filename || "未知"}, 大小: ${body.file?.size || "未知"}`;
      break;

    case "location":
      content = `[用户 ${fromUser} 发送了一个位置] 地址: ${body.location?.address}, 经纬度: ${body.location?.lat},${body.location?.lng}`;
      break;

    case "mixed":
      const items = body.mixed?.msg_item || [];
      content = items.map((item: any) => {
        if (item.msgtype === "text") return item.text?.content;
        if (item.msgtype === "image") return `[图片: ${item.image?.url}]`;
        return `[${item.msgtype}]`;
      }).join("\n");
      break;

    default:
      content = `[用户 ${fromUser} 发送了未处理的消息类型: ${msgType}]`;
  }

  // 处理引用内容 (Quote)
  if (body.quote) {
    let quoteText = "";
    if (body.quote.msgtype === "text" && body.quote.text?.content) {
      quoteText = body.quote.text.content;
    } else if (body.quote.msgtype === "image") {
      quoteText = "[图片]";
    } else {
      quoteText = `[${body.quote.msgtype} 消息]`;
    }

    if (quoteText) {
      const quoteInfo = `[引用内容: ${quoteText}]`;
      if (typeof content === "string") {
        content = `${quoteInfo}\n\n${content}`;
      } else if (Array.isArray(content)) {
        content.unshift({ type: "text", text: quoteInfo });
      }
    }
  }

  return content;
}
```

- [ ] **Step 2: Update the test script with actual implementation and verify it passes**

Run: `npx tsc; node dist/test-quote-parsing.js` (assuming you update the test script or use the real function)
Expected: PASS

- [ ] **Step 3: Commit changes**

```bash
git add src/wecom-adapter.ts
git commit -m "feat: support quoted message context in WeCom adapter"
```

### Task 3: Verification & Deployment

- [ ] **Step 1: Final compilation check**

Run: `npx tsc`
Expected: Success

- [ ] **Step 2: Deploy to remote**

Run: `bash deploy.sh`
Expected: Success

- [ ] **Step 3: Update TODO**

Mark Phase 3 tasks as complete.
