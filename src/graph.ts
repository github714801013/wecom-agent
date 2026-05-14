import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { getGitNexusTools } from "./mcp-client.js";
import { config } from "./config.js";
import { readFile } from "fs/promises";
import { join } from "path";

export async function initializeAgent() {
  const model = new ChatOpenAI({
    modelName: "MiniMax-M2.5",
    apiKey: config.MINIMAX_API_KEY,
    configuration: {
      baseURL: config.MINIMAX_BASE_URL,
    },
    temperature: 0,
  });

  const tools = await getGitNexusTools();
  
  // Load system prompt from MD file
  let systemPrompt = "";
  try {
    const promptPath = join(process.cwd(), "src/prompts/system-prompt.md");
    systemPrompt = await readFile(promptPath, "utf-8");
  } catch (err) {
    console.error("Failed to load system prompt:", err);
    systemPrompt = "You are a professional assistant.";
  }
  
  // createAgent is the new recommended API in LangChain JS v1
  return createAgent({
    model: model,
    tools,
    systemPrompt: systemPrompt,
  });
}
