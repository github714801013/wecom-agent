import { query } from "@anthropic-ai/claude-agent-sdk";
import { getClaudeTools } from "./mcp-client.js";
import { getModelContextSize } from "@langchain/core/language_models/base";
import { ChatOpenAI } from "@langchain/openai";
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

export async function getSystemPrompt() {
  try {
    const promptPath = join(process.cwd(), "src/prompts/system-prompt.md");
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load system prompt:", err);
    return "You are a professional assistant.";
  }
}

export async function* runClaudeAgent(prompt: string, sessionKey: string) {
  const tools = await getClaudeTools();
  const systemPrompt = await getSystemPrompt();

  // Strip /v1 to let Claude SDK append it
  const baseURL = config.LLM_BASE_URL.replace(/\/v1\/?$/, '');

  const options = {
    model: config.LLM_MODEL_NAME, // Use model from environment
    systemPrompt: systemPrompt,
    tools: tools,
    permissionMode: "acceptEdits" as const,
    settingSources: ['project' as const], // Auto loads .claude/skills/
    env: {
      "ANTHROPIC_AUTH_TOKEN": config.LLM_API_KEY || "",
      "ANTHROPIC_API_KEY": "",
      "ANTHROPIC_BASE_URL": baseURL,
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
      "DISABLE_PROMPT_CACHING": "1",
    }
  };

  yield* query({
    prompt,
    options
  });
}
