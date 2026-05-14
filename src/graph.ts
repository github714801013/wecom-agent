import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { getModelContextSize } from "@langchain/core/language_models/base";
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
  "deepseek-v3.2": 64000, // Example
};

export function getModelContextWindow() {
  if (config.LLM_CONTEXT_WINDOW > 0) return config.LLM_CONTEXT_WINDOW;
  
  const modelName = config.LLM_MODEL_NAME;
  const langchainSize = getModelContextSize(modelName);
  
  // getModelContextSize returns 4097 for unknown models
  if (langchainSize !== 4097) {
    return langchainSize;
  }
  
  // Case-insensitive lookup in our map
  const mappedSize = MODEL_CONTEXT_MAP[modelName] || 
                     MODEL_CONTEXT_MAP[Object.keys(MODEL_CONTEXT_MAP).find(k => k.toLowerCase() === modelName.toLowerCase()) || ""];
                     
  return mappedSize || 4096; // Fallback to safe default
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

export async function getSystemPrompt() {
  try {
    const promptPath = join(process.cwd(), "src/prompts/system-prompt.md");
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load system prompt:", err);
    return "You are a professional assistant.";
  }
}

export async function initializeAgent() {
  const model = await getBaseModel();
  const tools = await getAllMcpTools();
  const systemPrompt = await getSystemPrompt();
  
  // createAgent is the new recommended API in LangChain JS v1
  // It returns a CompiledStateGraph or Runnable that natively supports .stream(), .invoke(), etc.
  return createAgent({
    model: model,
    tools,
    systemPrompt: systemPrompt,
  });
}
