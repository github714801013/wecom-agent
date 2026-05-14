# WeCom Mixed Quote Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct handle `mixed` type quotes in `src/wecom-adapter.ts` by extracting all items (text/image) and promoting the result to multimodal format if images are present.

**Architecture:** Refactor `parseWeComMessage` to use a unified `quoteItems` collection phase before merging with main message content. Handle multimodal promotion automatically when images are detected in either main message or quote.

**Tech Stack:** TypeScript, WeCom Bot SDK

---

### Task 1: Refactor parseWeComMessage to support mixed quotes

**Files:**
- Modify: `src/wecom-adapter.ts`

- [ ] **Step 1: Update type definitions and handle mixed quotes**

Refactor the logic to:
1. Extract items from `mixed` type quotes.
2. Store quote items in an array of objects `{ type: "text" | "image_url", ... }`.
3. Consolidate multimodal promotion logic.

```typescript
export function parseWeComMessage(body: any): string | { type: string; text?: string; image_url?: { url: string } | string }[] {
  const msgType = body.msgtype;
  const fromUser = body.from?.userid || "unknown";
  
  // 1. Parse main message content
  let mainItems: any[] = [];
  switch (msgType) {
    case MessageType.Text:
      mainItems.push({ type: "text", text: body.text.content });
      break;
    case MessageType.Image:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一张图片]` });
      mainItems.push({ type: "image_url", image_url: body.image.url });
      break;
    case MessageType.Voice:
      const recognition = body.voice?.recognition || "";
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一段语音] ${recognition ? `(识别结果: ${recognition})` : "(未识别到文字)"}` });
      break;
    case MessageType.Video:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个视频] (链接: ${body.video?.url})` });
      break;
    case MessageType.File:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个文件] 名称: ${body.file?.filename || "未知"}, 大小: ${body.file?.size || "未知"}` });
      break;
    case "location":
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个位置] 地址: ${body.location?.address}, 经纬度: ${body.location?.lat},${body.location?.lng}` });
      break;
    case "mixed":
      const items = body.mixed?.msg_item || [];
      items.forEach((item: any) => {
        if (item.msgtype === "text") mainItems.push({ type: "text", text: item.text?.content });
        else if (item.msgtype === "image") mainItems.push({ type: "image_url", image_url: item.image?.url });
      });
      break;
    default:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了未处理的消息类型: ${msgType}]` });
      break;
  }

  // 2. Parse quote content
  let quoteItems: any[] = [];
  if (body.quote) {
    const qType = body.quote.msgtype;
    if (qType === "text") {
      quoteItems.push({ type: "text", text: body.quote.text?.content });
    } else if (qType === "image") {
      quoteItems.push({ type: "image_url", image_url: body.quote.image?.url });
    } else if (qType === "mixed") {
      const qMixedItems = body.quote.mixed?.msg_item || [];
      qMixedItems.forEach((item: any) => {
        if (item.msgtype === "text") quoteItems.push({ type: "text", text: item.text?.content });
        else if (item.msgtype === "image") quoteItems.push({ type: "image_url", image_url: item.image?.url });
      });
    } else {
      quoteItems.push({ type: "text", text: `[${qType} 消息]` });
    }
  }

  // 3. Combine and Merge
  const hasImage = mainItems.some(i => i.type === "image_url") || quoteItems.some(i => i.type === "image_url");

  if (!hasImage) {
    // Pure text mode: return string
    const mainText = mainItems.map(i => i.text).filter(Boolean).join("\n");
    if (quoteItems.length > 0) {
      const quoteText = quoteItems.map(i => i.text).filter(Boolean).join(" ");
      return `[引用内容: ${quoteText}]\n\n${mainText}`;
    }
    return mainText;
  } else {
    // Multimodal mode: return array
    const result: any[] = [];
    if (quoteItems.length > 0) {
      result.push({ type: "text", text: "[引用内容]:" });
      quoteItems.forEach(item => {
        if (item.type === "text") result.push({ type: "text", text: `> ${item.text}` });
        else result.push(item);
      });
      result.push({ type: "text", text: "\n" });
    }
    result.push(...mainItems);
    return result;
  }
}
```

- [ ] **Step 2: Run verification test**

Run: `npx tsc; node dist/test-mixed-quote.js`
Expected: PASS

- [ ] **Step 3: Commit changes**

```bash
git add src/wecom-adapter.ts
git commit -m "feat: support mixed type quotes and multimodal message promotion"
```
