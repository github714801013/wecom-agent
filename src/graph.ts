import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { getModelContextSize } from "@langchain/core/language_models/base";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getAllMcpTools } from "./mcp-client.js";
import { config } from "./config.js";
import { readFile } from "fs/promises";
import { join } from "path";

const MODEL_CONTEXT_MAP: Record<string, number> = {
  "MiniMax-M2.5": 200000,
  "MiniMax-M2.7": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "claude-3-5-sonnet-20240620": 200000,
  "deepseek-v3.2": 64000,
};

export function getModelContextWindow() {
  if (config.LLM_CONTEXT_WINDOW > 0) return config.LLM_CONTEXT_WINDOW;
  
  const modelName = config.LLM_MODEL_NAME;
  const langchainSize = getModelContextSize(modelName);
  
  if (langchainSize !== 4097) {
    return langchainSize;
  }
  
  const mappedSize = MODEL_CONTEXT_MAP[modelName] || 
                     MODEL_CONTEXT_MAP[Object.keys(MODEL_CONTEXT_MAP).find(k => k.toLowerCase() === modelName.toLowerCase()) || ""];
                     
  return mappedSize || 4096;
}

export async function getBaseModel() {
  return new ChatOpenAI({
    modelName: config.LLM_MODEL_NAME,
    apiKey: config.LLM_API_KEY,
    configuration: {
      baseURL: config.LLM_BASE_URL,
    },
    temperature: 0,
  });
}

export async function getPlannerPrompt() {
  try {
    const promptPath = join(process.cwd(), "src/prompts/planner-prompt.md");
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load planner prompt:", err);
    return "You are a code search planner. Convert user questions to search queries.";
  }
}

export async function getBusinessPrompt() {
  try {
    const promptPath = join(process.cwd(), "src/prompts/business-prompt.md");
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load business prompt:", err);
    return "You are a professional assistant.";
  }
}

export interface PlannerResult {
  intent: string;
  secondary_intents: string[];
  confidence: number;
  normalized_question: string;
  business_terms: string[];
  code_terms: {
    chinese: string[];
    english: string[];
    pinyin: string[];
    abbr: string[];
    mixed: string[];
    combined?: string;
    stripped_combined?: string;
  };
  queries: Array<{
    query: string;
    type: string;
    priority: number;
    reason: string;
  }>;
  hypotheses: Array<{
    title: string;
    queries: string[];
  }>;
  search_plan: {
    primary: string[];
    secondary: string[];
    exclude: string[];
  };
  missing_info: string[];
}

export interface CompressorResult {
  status: string;
  intent: string;
  partial: boolean;
  compressed_sections: Array<{
    section_id: string;
    file_path: string;
    symbol: string;
    kind: string;
    lines: string;
    score: number;
    reason: string;
    anchors: string[];
    content: string;
    merged_from: string[];
  }>;
  call_chain: Array<{
    from: string;
    to: string;
    relation: string;
  }>;
  key_evidence: string[];
  dropped: Array<{
    id: string;
    reason: string;
  }>;
  missing_info: string[];
  warnings: string[];
  errors: string[];
  budget: {
    input_est: number;
    output_est: number;
    target: number;
    mode: string;
  };
}

/**
 * 运行 Planner 节点，将用户问题转化为高质量搜索 Query
 */
export async function runPlanner(userQuestion: string): Promise<PlannerResult | null> {
  const model = await getBaseModel();
  const plannerPrompt = await getPlannerPrompt();
  
  const response = await model.invoke([
    new SystemMessage(plannerPrompt),
    new HumanMessage(userQuestion),
  ]);

  try {
    const content = response.content.toString();
    // 简单提取 JSON 部分，防止 LLM 输出多余文字
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[0]
        .replace(/\\n/g, " ") // 处理 JSON 字符串中的换行
        .replace(/\n/g, " ")  // 处理 JSON 外部的换行
        .trim();
      return JSON.parse(jsonStr);
    }
    return null;
  } catch (err) {
    console.error("Failed to parse planner response:", err);
    console.error("Raw response content:", response.content.toString());
    return null;
  }
}

export async function getCompressorPrompt() {
  try {
    const promptPath = join(process.cwd(), "src/prompts/compress-prompt.md");
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load compressor prompt:", err);
    return "You are a context compressor. Filter and compress code context.";
  }
}

/**
 * 运行 Compressor 节点，压缩检索结果或历史上下文
 */
export async function runCompressor(input: {
  user_question: string;
  rewrite_result?: PlannerResult;
  search_results: any[];
  project_context?: string;
  token_budget?: { target: number; max_per_section: number; mode: string };
}): Promise<CompressorResult | null> {
  const model = await getBaseModel();
  const compressorPrompt = await getCompressorPrompt();

  const response = await model.invoke([
    new SystemMessage(compressorPrompt),
    new HumanMessage(JSON.stringify(input)),
  ]);

  try {
    const content = response.content.toString();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[0]
        .replace(/\\n/g, " ")
        .replace(/\n/g, " ")
        .trim();
      return JSON.parse(jsonStr);
    }
    return null;
  } catch (err) {
    console.error("Failed to parse compressor response:", err);
    console.error("Raw response content:", response.content.toString());
    return null;
  }
}

export async function initializeAgent() {
  const model = await getBaseModel();
  const tools = await getAllMcpTools();
  const systemPrompt = await getBusinessPrompt();

  return createAgent({
    model: model,
    tools,
    systemPrompt: systemPrompt,
  });
}
