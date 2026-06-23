import { parseWeComMessage } from "../wecom-adapter.js";

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

const mockBot = { downloadFile: async () => ({ buffer: Buffer.from('') }) } as any;
const mockAnalyzer = async () => "【图片识别结果】\n图片标题：美团国补订单";

const result = await parseWeComMessage(mockBody, mockBot, mockAnalyzer);
console.log("Parsed content:", JSON.stringify(result, null, 2));

const hasText = JSON.stringify(result).includes("美团国补订单");
const hasImage = JSON.stringify(result).includes("data:image/jpeg;base64,");
const hasVisionText = JSON.stringify(result).includes("【图片识别结果】");

if (hasText && hasImage && hasVisionText) {
  console.log("Test PASSED");
} else {
  console.log("Test FAILED: Mixed quote content missing parts");
  process.exit(1);
}
