import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wecom-agent-config-"));
const tempConfigFile = path.join(tempDir, "wecom-agent.config.json");

process.env.CONFIG_FILE = tempConfigFile;
process.env.TEST_LLM_API_KEY = "test-api-key";
process.env.TEST_LLM_BASE_URL = "https://llm.example.test/v1";
process.env.TEST_BOT_ID = "test-bot-id";
process.env.TEST_BOT_SECRET = "test-bot-secret";
process.env.TEST_SECRET_VALUE = "resolved-secret";

fs.writeFileSync(tempConfigFile, JSON.stringify({
  llm: {
    apiKey: "${TEST_LLM_API_KEY}",
    baseUrl: "${TEST_LLM_BASE_URL}",
    modelName: "MiniMax-M2.5",
    recursionLimit: 25,
    contextWindow: 0,
  },
  mcpServers: [],
  bots: [{
    name: "robot-a",
    botId: "${TEST_BOT_ID}",
    secret: "${TEST_BOT_SECRET}",
    wsUrl: "wss://openws.work.weixin.qq.com",
    mcpHeaders: {},
  }],
  tools: {
    allowed: [],
    excluded: [],
    cacheTtlMinutes: 15,
  },
}), "utf-8");

const { resolveEnvPlaceholders, config } = await import("../config.js");
const { buildMcpHeaders } = await import("../mcp-client.js");

assertEqual(config.llm.apiKey, "test-api-key", "config should resolve llm api key placeholder");
assertEqual(config.bots[0]?.botId, "test-bot-id", "config should resolve bot id placeholder");
assertEqual(config.tools.cacheTtlMinutes, 15, "config should parse MCP tools cache TTL");

const resolved = resolveEnvPlaceholders({
  secret: "${TEST_SECRET_VALUE}",
  nested: {
    header: "token ${TEST_SECRET_VALUE}",
  },
});

assertEqual(resolved.secret, "resolved-secret", "env placeholder should resolve full string");
assertEqual(resolved.nested.header, "token resolved-secret", "env placeholder should resolve inside string");

const gitnexusServer = {
  name: "gitnexus",
  url: "http://127.0.0.1:1348/sse",
  type: "sse" as const,
  headers: {
    "x-global": "global",
    "x-overlap": "server",
  },
};

const dbServer = {
  name: "db",
  url: "http://127.0.0.1:1248/sse",
  type: "sse" as const,
  headers: {
    "x-global": "db-global",
  },
};

const bot = {
  name: "robot-a",
  botId: "bot-id",
  secret: "secret",
  wsUrl: "wss://openws.work.weixin.qq.com",
  mcpHeaders: {
    gitnexus: {
      "x-overlap": "bot",
      "x-robot": "robot-a",
    },
  },
};

const gitnexusHeaders = buildMcpHeaders(gitnexusServer, bot);
assertEqual(gitnexusHeaders["x-global"], "global", "server header should remain");
assertEqual(gitnexusHeaders["x-overlap"], "bot", "bot header should override server header");
assertEqual(gitnexusHeaders["x-robot"], "robot-a", "bot header should be added to matched MCP server");

const dbHeaders = buildMcpHeaders(dbServer, bot);
assertEqual(dbHeaders["x-global"], "db-global", "unmatched MCP server should keep server header");
assertEqual(dbHeaders["x-robot"], undefined, "unmatched MCP server should not receive bot header");

console.log("配置解析与 MCP header 合并验证通过");
