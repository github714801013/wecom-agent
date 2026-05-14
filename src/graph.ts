import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { getGitNexusTools } from "./mcp-client.js";
import { config } from "./config.js";

export async function createAgent() {
  const model = new ChatOpenAI({
    modelName: "minimax-m2.5",
    apiKey: config.MINIMAX_API_KEY,
    configuration: {
      baseURL: config.MINIMAX_BASE_URL,
    },
    temperature: 0,
  });

  const tools = await getGitNexusTools();
  return createReactAgent({
    llm: model,
    tools,
  });
}
