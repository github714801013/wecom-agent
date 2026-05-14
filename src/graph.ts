import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { getModelContextSize } from "@langchain/core/language_models/base";
import { tool } from "@langchain/core/tools";
import { getAllMcpTools } from "./mcp-client.js";
import { config } from "./config.js";
import { sessionManager } from "./session-manager.js";
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

// 本地工具：清理会话历史
const clearHistoryTool = tool(
  async (_args, config) => {
    const sessionKey = config.configurable?.sessionKey;
    if (sessionKey) {
      sessionManager.clearSession(sessionKey);
      return "会话记录已成功清理。";
    }
    return "错误：未能在上下文中找到有效的会话标识，清理失败。";
  },
  {
    name: "clear_conversation_history",
    description:
      "清理当前的对话历史记录/记忆。当用户明确要求“忘记之前的对话”、“重置聊天”、“清理记忆”或开始全新话题时使用。",
  }
);

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
  const mcpTools = await getAllMcpTools();
  const systemPrompt = await getSystemPrompt();

  const allTools = [...mcpTools, clearHistoryTool];

  // createAgent is the new recommended API in LangChain JS v1
  // It returns a CompiledStateGraph or Runnable that natively supports .stream(), .invoke(), etc.
  return createAgent({
    model: model,
    tools: allTools,
    systemPrompt: systemPrompt,
  });
}
