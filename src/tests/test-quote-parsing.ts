import { MessageType } from "@wecom/aibot-node-sdk";
import { parseWeComMessage } from "../wecom-adapter.js";

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

const expectedQuoteContent = "样机折旧逻辑";
if (typeof result === "string" && result.includes(expectedQuoteContent)) {
  console.log("Test PASSED");
} else {
  console.log(`Test FAILED: Quote content "${expectedQuoteContent}" not found in result`);
  process.exit(1);
}
