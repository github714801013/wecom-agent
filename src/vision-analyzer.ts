import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "./config.js";

export interface VisionAnalysisInput {
  question: string;
  imageUrl: string;
  contextLabel?: string;
}

export type VisionImageAnalyzer = (input: VisionAnalysisInput) => Promise<string>;

const DEFAULT_QUESTION_CONTEXT = "用户未提供明确文字问题，请优先识别图片中的页面标题、圈选重点和标注信息。";

const VISION_ANALYSIS_PROMPT = [
  "你是图片内容识别助手。请结合用户当前问题，从截图或图片中提取对排查代码、页面逻辑、字段来源有用的信息。",
  "",
  "请重点识别：",
  "1. 页面标题、弹窗标题、浏览器路径、菜单路径、接口路径或系统名称。",
  "2. 圈出来、框选、箭头指向、高亮、红字、批注、手写标注等重点。",
  "3. 字段名、按钮名、表格列名、状态值、编号、URL、错误提示、提示语。",
  "4. 截图中已经写出的原因分析、根本原因、调用链、代码位置、方法名、类名、文件路径、行号、错误码含义、排查方向。",
  "5. 与当前用户问题直接相关的文字和位置。",
  "",
  "输出要求：",
  "- 使用中文。",
  "- 不要编造图片中没有的内容。",
  "- 看不清时写“未识别清楚”。",
  "- 输出为纯文本，结构固定为：",
  "【图片识别结果】",
  "图片位置：...",
  "图片标题：...",
  "圈选/标注重点：...",
  "关键字段/按钮/列名：...",
  "原因分析/调用链/代码位置：...",
  "错误码/状态码含义：...",
  "根本原因/排查方向：...",
  "与当前问题相关的信息：...",
  "未识别清楚：...",
].join("\n");

function stringifyModelContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return String(content ?? "").trim();
}

export async function analyzeImageForQuestion(input: VisionAnalysisInput): Promise<string> {
  if (!config.vision.enabled) {
    return "【图片识别结果】\n图片识别未启用，已保留原图供主模型参考。";
  }

  const question = input.question.trim() || DEFAULT_QUESTION_CONTEXT;
  const model = new ChatOpenAI({
    modelName: config.vision.modelName,
    apiKey: config.vision.apiKey || config.llm.apiKey,
    configuration: {
      baseURL: config.vision.baseUrl || config.llm.baseUrl,
    },
    temperature: 0,
  });

  const response = await model.invoke([
    new HumanMessage({
      content: [
        {
          type: "text",
          text: [
            VISION_ANALYSIS_PROMPT,
            "",
            `图片位置：${input.contextLabel || "未标注"}`,
            `用户当前问题：${question}`,
          ].join("\n"),
        },
        { type: "image_url", image_url: { url: input.imageUrl } },
      ],
    }),
  ]);

  const content = stringifyModelContent(response.content);
  if (!content) {
    return "【图片识别结果】\n未识别到有效图片内容，已保留原图供主模型参考。";
  }
  return content.startsWith("【图片识别结果】") ? content : `【图片识别结果】\n${content}`;
}
