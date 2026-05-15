import { query } from "@anthropic-ai/claude-agent-sdk";
import dotenv from "dotenv";
dotenv.config();

async function debug() {
  const modelName = "claude-3-5-sonnet-20240620";
  const baseURL = (process.env.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/v1\/?$/, '');
  
  console.log(`Debug starting... Model: ${modelName}, baseURL: ${baseURL}`);

  const options = {
    model: modelName, 
    systemPrompt: "You are a debugger.",
    permissionMode: "bypassPermissions" as const,
    cwd: process.cwd(),
    env: {
      ...process.env,
      "TERM": "xterm-256color",
      "COLORTERM": "truecolor",
      "HOME": "/root",
      "USER": "root",
      "ANTHROPIC_AUTH_TOKEN": process.env.LLM_API_KEY || "",
      "ANTHROPIC_API_KEY": "", 
      "ANTHROPIC_BASE_URL": baseURL,
      "ANTHROPIC_MODEL": modelName,
      "ANTHROPIC_SMALL_FAST_MODEL": modelName,
    }
  };

  try {
    const iterable = query({
      prompt: "hi",
      options
    });

    for await (const chunk of iterable) {
      console.log("Chunk:", JSON.stringify(chunk, null, 2));
    }
  } catch (err) {
    console.error("DEBUG ERROR:", err);
    if (err instanceof Error) {
      console.error("Stack:", err.stack);
    }
  }
}

debug();
