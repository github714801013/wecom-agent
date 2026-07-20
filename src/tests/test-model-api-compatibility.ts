import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { stringifyModelContent } from "../model-content.js";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function writeConfig(config: Record<string, unknown>) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-agent-model-compat-"));
  const configFile = path.join(tempDir, "wecom-agent.config.json");
  fs.writeFileSync(configFile, JSON.stringify(config), "utf-8");
  process.env.CONFIG_FILE = configFile;
}

writeConfig({
  llm: {
    apiKey: "test-api-key",
    baseUrl: "https://dashscope.ch999.cn/codex",
    modelName: "gpt-5.6-luna",
  },
  bots: [{
    name: "test-bot",
    botId: "test-bot-id",
    secret: "test-bot-secret",
  }],
});

const { getBaseModel, resolveLlmApiMode } = await import("../graph.js");
assertEqual(
  resolveLlmApiMode({
    apiMode: "auto",
    baseUrl: "https://dashscope.ch999.cn/codex",
    modelName: "gpt-5.6-luna",
  }),
  "responses",
  "codex endpoint should use Responses API",
);

assertEqual(
  resolveLlmApiMode({
    apiMode: "auto",
    baseUrl: "https://dashscope.ch999.cn/base",
    modelName: "gpt-5.6-luna",
  }),
  "responses",
  "gpt-5.6-luna should use Responses API",
);

assertEqual(
  resolveLlmApiMode({
    apiMode: "auto",
    baseUrl: "https://llm.example.test/v1",
    modelName: "MiniMax-M2.5",
  }),
  "chat_completions",
  "legacy model should keep Chat Completions API",
);

assertEqual(
  resolveLlmApiMode({
    apiMode: "chat_completions",
    baseUrl: "https://dashscope.ch999.cn/codex",
    modelName: "gpt-5.6-luna",
  }),
  "chat_completions",
  "explicit mode should override auto detection",
);

const responsesModel = await getBaseModel();

assertEqual(responsesModel instanceof ChatOpenAI, true, "base model should keep ChatOpenAI compatibility");
assertEqual((responsesModel as ChatOpenAI).useResponsesApi, true, "codex endpoint should use Responses API");
assertEqual((responsesModel as ChatOpenAI).streaming, true, "Responses API model should force streaming");

assertEqual(
  stringifyModelContent([{ type: "text", text: "OK", index: 0 }]),
  "OK",
  "Responses text content block should be normalized",
);

assertEqual(
  stringifyModelContent([{ type: "image", image_url: "..." }]).includes("[object Object]"),
  false,
  "unknown content blocks must not stringify to [object Object]",
);

console.log("model API compatibility test passed");
