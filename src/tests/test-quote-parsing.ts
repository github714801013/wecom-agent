import { MessageType } from "@wecom/aibot-node-sdk";
import { parseWeComMessage, stripBoundaryMentions } from "../wecom-adapter.js";

const mockBody = {
  msgid: "7378310b32d71f8bdc3027a9e54e2d92",
  msgtype: "text",
  text: { content: "@OA智能助手 继续" },
  quote: {
    msgtype: "text",
    text: { content: "@OA智能助手 样机折旧逻辑" }
  }
};

const mockBot = { downloadFile: async () => ({ buffer: Buffer.from('') }) } as any;

const result = await parseWeComMessage(mockBody, mockBot);
console.log("Parsed content:", result);

const expectedQuoteContent = "@OA智能助手 样机折旧逻辑";
if (typeof result === "string" && result.includes(expectedQuoteContent)) {
  console.log("Test PASSED");
} else {
  console.log(`Test FAILED: Quote content "${expectedQuoteContent}" not found in result`);
  process.exit(1);
}


const strippedStartAndEnd = stripBoundaryMentions("@李飞 @OA智能助手 查询库存 @张三");
if (strippedStartAndEnd !== "查询库存") {
  console.log(`Test FAILED: boundary mentions should be stripped, got "${strippedStartAndEnd}"`);
  process.exit(1);
}

const keptMiddleMention = stripBoundaryMentions("帮我问 @李飞 库存还有多少");
if (keptMiddleMention !== "帮我问 @李飞 库存还有多少") {
  console.log(`Test FAILED: middle mention should be kept, got "${keptMiddleMention}"`);
  process.exit(1);
}

const punctuationBoundaryMention = stripBoundaryMentions("@李飞，查询库存，@张三");
if (punctuationBoundaryMention !== "查询库存") {
  console.log(`Test FAILED: punctuation boundary mentions should be stripped, got "${punctuationBoundaryMention}"`);
  process.exit(1);
}

console.log("Mention strip tests PASSED");
