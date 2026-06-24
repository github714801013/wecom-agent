import { parseWeComMessage, shouldStartEarlyProgressBeforeParse } from "../wecom-adapter.js";
import type { VisionAnalysisInput } from "../vision-analyzer.js";

function assertTrue(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

const analyzerInputs: VisionAnalysisInput[] = [];
const mockAnalyzer = async (input: VisionAnalysisInput) => {
  analyzerInputs.push(input);
  return [
    "【图片识别结果】",
    `上下文：${input.contextLabel}`,
    "图片标题：常用资产历史价",
    "圈选/标注重点：历史价字段被红圈标出",
    "与当前问题相关的信息：用户在问历史价取值逻辑",
  ].join("\n");
};

const mockBot = {
  downloadFile: async () => ({ buffer: Buffer.from("image-bytes") }),
} as any;

const mixedBody = {
  msgid: "mixed-image",
  msgtype: "mixed",
  from: { userid: "zhangsan" },
  mixed: {
    msg_item: [
      { msgtype: "text", text: { content: "@OA智能助手 常用资产历史价显示这里的取值逻辑帮我看看" } },
      { msgtype: "image", image: { url: "https://ww-aibot-img.example.com/history-price.jpg" } },
    ],
  },
};

const mixedResult = await parseWeComMessage(mixedBody, mockBot, mockAnalyzer);
const mixedResultText = JSON.stringify(mixedResult);
const mixedAnalyzerInput = analyzerInputs[0];

assertTrue(Array.isArray(mixedResult), "mixed 图片消息应返回多模态数组");
assertTrue(mixedResultText.includes("【图片识别结果】"), "解析结果应包含图片识别结果文本");
assertTrue(mixedResultText.includes("常用资产历史价"), "图片识别结果应保留页面标题");
assertTrue(mixedResultText.includes("data:image/jpeg;base64,"), "解析结果应保留原图作为主模型兜底");
assertTrue(Boolean(mixedAnalyzerInput), "mixed 图片应调用图片识别器");
assertTrue(mixedAnalyzerInput?.question.includes("常用资产历史价显示这里的取值逻辑") === true, "图片识别器应拿到当前用户提问上下文");
assertTrue(mixedAnalyzerInput?.contextLabel === "主消息图文混排第2项", "mixed 图片应带主消息图文上下文标识");
assertTrue(shouldStartEarlyProgressBeforeParse(mixedBody), "主消息图文混排图片应提前发送处理中反馈");

const quoteBody = {
  msgid: "quote-image",
  msgtype: "text",
  from: { userid: "lisi" },
  text: { content: "@OA智能助手 这张图里圈出来的按钮是什么条件显示" },
  quote: {
    msgtype: "image",
    image: { url: "https://ww-aibot-img.example.com/detail-button.jpg" },
  },
};

const quoteResult = await parseWeComMessage(quoteBody, mockBot, mockAnalyzer);
const quoteResultText = JSON.stringify(quoteResult);
const quoteAnalyzerInput = analyzerInputs[1];

assertTrue(Array.isArray(quoteResult), "引用图片消息应返回多模态数组");
assertTrue(quoteResultText.includes("【图片识别结果】"), "引用图片应插入识别结果");
assertTrue(Boolean(quoteAnalyzerInput), "引用图片应调用图片识别器");
assertTrue(quoteAnalyzerInput?.question.includes("圈出来的按钮是什么条件显示") === true, "引用图片识别器应拿到当前主消息问题");
assertTrue(quoteAnalyzerInput?.contextLabel === "引用图片", "引用图片应带引用上下文标识");
assertTrue(shouldStartEarlyProgressBeforeParse(quoteBody), "引用图片应提前发送处理中反馈");

assertTrue(
  !shouldStartEarlyProgressBeforeParse({ msgtype: "text", text: { content: "帮助" } }),
  "纯文本消息不应提前插入处理中反馈",
);
assertTrue(shouldStartEarlyProgressBeforeParse({ msgtype: "file", file: { filename: "a.pdf" } }), "文件消息应提前发送处理中反馈");
assertTrue(shouldStartEarlyProgressBeforeParse({ msgtype: "video", video: { url: "https://example.com/a.mp4" } }), "视频消息应提前发送处理中反馈");

const failingAnalyzer = async () => {
  throw new Error("vision unavailable");
};
const fallbackResult = await parseWeComMessage(quoteBody, mockBot, failingAnalyzer);
const fallbackResultText = JSON.stringify(fallbackResult);

assertTrue(fallbackResultText.includes("图片识别失败"), "图片识别失败时应生成可见失败说明");
assertTrue(fallbackResultText.includes("data:image/jpeg;base64,"), "图片识别失败时仍应保留原图");

console.log("图片视觉上下文解析测试通过");
