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

/**
 * 运行 Planner 节点，将用户问题转化为高质量搜索 Query
 */
export async function runPlanner(userQuestion: string): Promise<{ combined: string; regex: string; semantic: string; status?: string } | null> {
  const model = await getBaseModel();
  const plannerPrompt = await getPlannerPrompt();
  
  const response = await model.invoke([
    new SystemMessage(plannerPrompt),
    new HumanMessage(userQuestion),
  ]);

  try {
    const content = response.content.toString();
    // 简单提取 JSON 部分，防止 LLM 输出多余文字
    const jsonMatch = content.match(/\{.*\}/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (err) {
    console.error("Failed to parse planner response:", err);
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
