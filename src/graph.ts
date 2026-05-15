import { query } from "@anthropic-ai/claude-agent-sdk";
import { getClaudeMcpConfig } from "./mcp-client.js";
import { getModelContextSize } from "@langchain/core/language_models/base";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "./config.js";
import { spawn } from "child_process";

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
  return "You are a professional assistant. Follow the SOPs defined in your skills library to handle business operations and technical support.";
}

export async function* runClaudeAgent(prompt: string | AsyncIterable<any>, sessionKey: string) {
  const mcpServers = getClaudeMcpConfig();
  const systemPrompt = await getSystemPrompt();

  // Robustly handle baseURL
  const rawBaseURL = config.LLM_BASE_URL || "https://api.anthropic.com";
  const baseURL = rawBaseURL.replace(/\/v1\/?$/, '');
  
  const modelName = config.LLM_MODEL_NAME;
  const cwd = process.cwd();

  console.log(`Agent starting with model: ${modelName}, baseURL: ${baseURL}, cwd: ${cwd}`);

  const options = {
    model: modelName, 
    systemPrompt: systemPrompt,
    mcpServers: mcpServers,
    spawnClaudeCodeProcess: (spawnOptions: any) => {
      console.log(`Custom Spawning Claude Code: ${spawnOptions.command} ${spawnOptions.args.join(' ')}`);
      
      // If command is 'node' or 'bun' and first arg is the binary, run the binary directly
      const command = spawnOptions.command;
      if ((command === 'node' || command === 'node.exe' || command === 'bun') && spawnOptions.args[0]?.includes('claude')) {
        const binaryPath = spawnOptions.args[0];
        const binaryArgs = spawnOptions.args.slice(1);
        console.log(`Bypassing ${command}, running binary directly: ${binaryPath}`);
        return spawn(binaryPath, binaryArgs, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
        }) as any;
      }
      
      // Default fallback
      return spawn(command, spawnOptions.args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
      }) as any;
    },
    debug: true,
    stderr: (data: string) => {
      console.error(`[ClaudeCode stderr] ${data}`);
    },
    pathToClaudeCodeExecutable: "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    permissionMode: "bypassPermissions" as const,
    settingSources: ['project' as const],
    cwd: cwd,
    env: {
      ...process.env,
      "TERM": "xterm-256color",
      "COLORTERM": "truecolor",
      "HOME": process.env.HOME || "/home/node",
      "USER": process.env.USER || "node",
      "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
      "DISABLE_PROMPT_CACHING": "1",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
      "CLAUDE_CODE_DISABLE_TTY_PROMPTS": "1",
      "CLAUDE_CODE_SKIP_UPDATE_CHECK": "1",
      "DEBUG": "claude-code:*",
      "ANTHROPIC_AUTH_TOKEN": config.LLM_API_KEY || "",
      "ANTHROPIC_API_KEY": config.LLM_API_KEY || "", 
      "ANTHROPIC_BASE_URL": baseURL,
      "ANTHROPIC_MODEL": modelName,
      "ANTHROPIC_SMALL_FAST_MODEL": modelName,
    }
  };

  yield* query({
    prompt: prompt as any,
    options
  });
}
