import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "./config.js";

export interface VisionAnalysisInput {
  question: string;
  imageUrl: string;
  contextLabel?: string;
}

export type VisionImageAnalyzer = (input: VisionAnalysisInput) => Promise<string>;

const DEFAULT_QUESTION_CONTEXT = "用户未提供明确文字问题，请优先识别图片中的页面标题、圈选重点和标注信息，并说明用户关注点和想解决的问题。";

const REQUIRED_VISION_SECTIONS = [
  "图片位置",
  "图片标题",
  "用户标注重点",
  "用户关注点",
  "用户想解决的问题",
  "关键字段/按钮/列名",
  "原因分析/调用链/代码位置",
  "错误码/状态码含义",
  "根本原因/排查方向",
  "与当前问题相关的信息",
  "未识别清楚",
] as const;

export const VISION_ANALYSIS_PROMPT = [
  "你是图片内容识别助手。请结合用户当前问题，从截图或图片中提取对排查代码、页面逻辑、字段来源有用的信息。",
  "",
  "最高优先级：",
  "- 必须优先关注用户人为标注过的地方，包括圈出来、框选、箭头指向、高亮、红字、批注、手写标注、下划线、截图裁剪焦点等。",
  "- 输出中必须有相关文字描述，明确说明标注区域里有什么、用户在关注什么、用户想解决什么问题。",
  "- 如果图片里存在多个标注区域，请按从上到下、从左到右列出；如果标注区域看不清，也要写明“标注区域未识别清楚”。",
  "",
  "请重点识别：",
  "1. 页面标题、弹窗标题、浏览器路径、菜单路径、接口路径或系统名称。",
  "2. 用户标注区域：圈选、框选、箭头、高亮、红字、批注、手写标注、下划线等位置及其文字内容。",
  "3. 字段名、按钮名、表格列名、状态值、编号、URL、错误提示、提示语。",
  "4. 截图中已经写出的原因分析、根本原因、调用链、代码位置、方法名、类名、文件路径、行号、错误码含义、排查方向。",
  "5. 根据图片标注和用户问题，判断用户当前关注点和想解决的问题。",
  "",
  "输出要求：",
  "- 使用中文。",
  "- 不要编造图片中没有的内容。",
  "- 看不清时写“未识别清楚”。",
  "- 不允许省略“用户标注重点”“用户关注点”“用户想解决的问题”三项；即使没有明显标注，也要说明“未发现明显标注”。",
  "- 输出为纯文本，结构固定为：",
  "【图片识别结果】",
  "图片位置：...",
  "图片标题：...",
  "用户标注重点：...",
  "用户关注点：...",
  "用户想解决的问题：...",
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

export function ensureVisionMarkedFocusSections(content: string): string {
  const normalized = content.trim().startsWith("【图片识别结果】")
    ? content.trim()
    : `【图片识别结果】\n${content.trim()}`;

  const lines = normalized.split(/\r?\n/);
  const existing = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^([^：:]{2,30})[：:]/u);
    if (match?.[1]) existing.add(match[1].trim());
  }

  const missingLines = REQUIRED_VISION_SECTIONS
    .filter(section => !existing.has(section))
    .map(section => `${section}：未识别清楚`);

  return missingLines.length > 0
    ? `${normalized}\n${missingLines.join("\n")}`
    : normalized;
}

export async function analyzeImageForQuestion(input: VisionAnalysisInput): Promise<string> {
  if (!config.vision.enabled) {
    return ensureVisionMarkedFocusSections("【图片识别结果】\n图片识别未启用，已保留原图供主模型参考。");
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
    return ensureVisionMarkedFocusSections("【图片识别结果】\n未识别到有效图片内容，已保留原图供主模型参考。");
  }
  return ensureVisionMarkedFocusSections(content);
}
