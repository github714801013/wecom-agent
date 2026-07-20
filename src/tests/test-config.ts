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
  mcpServers: [{
    name: "gitnexus",
    url: "http://127.0.0.1:1348/api/mcp",
    type: "http",
    headers: {
      "x-server": "gitnexus",
    },
    headerProfiles: {
      "/oa": {
        projects: "oa-stock,jiuji-m,9ji-admin",
        env: "pro,iteng",
      },
      "/neo": {
        projects: "small-oa,jiuyun-oa",
      },
      "/oa-dev": {
        projects: "oa-stock,jiuji-m,9ji-admin",
        env: "dev",
      },
    },
  }],
  bots: [{
    name: "robot-a",
    botId: "${TEST_BOT_ID}",
    secret: "${TEST_BOT_SECRET}",
    wsUrl: "wss://openws.work.weixin.qq.com",
    mcpHeaders: {},
    defaultMcpHeaderCommand: "/oa",
  }],
  tools: {
    allowed: [],
    excluded: [],
    cacheTtlMinutes: 15,
  },
}), "utf-8");

const { resolveEnvPlaceholders, config } = await import("../config.js");
const { buildMcpHeaders, createMcpTransport, withMcpServerLoadTimeout } = await import("../mcp-client.js");

assertEqual(config.llm.apiKey, "test-api-key", "config should resolve llm api key placeholder");
assertEqual(config.bots[0]?.botId, "test-bot-id", "config should resolve bot id placeholder");
assertEqual(config.mcpServers[0]?.headerProfiles["/oa"]?.projects, "oa-stock,jiuji-m,9ji-admin", "config should parse OA MCP header profile");
assertEqual(config.mcpServers[0]?.headerProfiles["/oa"]?.env, "pro,iteng", "config should parse OA environment header");
assertEqual(config.mcpServers[0]?.headerProfiles["/neo"]?.projects, "small-oa,jiuyun-oa", "config should parse NEO MCP header profile");
assertEqual(config.mcpServers[0]?.type, "http", "config should parse Streamable HTTP MCP transport type");
assertEqual(config.bots[0]?.defaultMcpHeaderCommand, "/oa", "bot should configure default MCP header command");
assertEqual(config.tools.cacheTtlMinutes, 15, "config should parse MCP tools cache TTL");
assertEqual(config.tools.maxAgentToolResultsPerTurn, 64, "config should default max agent tool results per turn to 64");
assertEqual(config.vision.enabled, true, "config should enable image vision analysis by default");
assertEqual(config.vision.modelName, "gemini-3.1-pro-preview", "config should default image vision model");

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
  headerProfiles: {},
};

const dbServer = {
  name: "db",
  url: "http://127.0.0.1:1248/sse",
  type: "sse" as const,
  headers: {
    "x-global": "db-global",
  },
  headerProfiles: {},
};

const bot = {
  name: "robot-a",
  botId: "bot-id",
  secret: "secret",
  wsUrl: "wss://openws.work.weixin.qq.com",
  defaultMcpHeaderCommand: "/oa",
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

const defaultProfileHeaders = buildMcpHeaders(config.mcpServers[0]!, config.bots[0]);
assertEqual(defaultProfileHeaders["projects"], "oa-stock,jiuji-m,9ji-admin", "default MCP header command should apply profile headers");

const dbHeaders = buildMcpHeaders(dbServer, bot);
assertEqual(dbHeaders["x-global"], "db-global", "unmatched MCP server should keep server header");
assertEqual(dbHeaders["x-robot"], undefined, "unmatched MCP server should not receive bot header");

const overriddenHeaders = buildMcpHeaders(gitnexusServer, bot, {
  gitnexus: {
    projects: "small-oa,jiuyun-oa",
  },
});
assertEqual(overriddenHeaders["projects"], "small-oa,jiuyun-oa", "session MCP header should override server and bot headers");

const switchedProfileHeaders = buildMcpHeaders(config.mcpServers[0]!, config.bots[0], {
  gitnexus: {
    projects: "small-oa,jiuyun-oa",
  },
});
assertEqual(switchedProfileHeaders["projects"], "small-oa,jiuyun-oa", "explicit NEO profile should replace default OA projects");
assertEqual(switchedProfileHeaders["env"], undefined, "explicit NEO profile should clear default OA-only env header");
assertEqual(switchedProfileHeaders["x-server"], "gitnexus", "explicit profile switch should keep server static headers");

const oaDevProfileHeaders = buildMcpHeaders(config.mcpServers[0]!, config.bots[0], {
  gitnexus: config.mcpServers[0]!.headerProfiles["/oa-dev"]!,
});
assertEqual(oaDevProfileHeaders["env"], "dev", "explicit OA dev profile should use its own env header");
assertEqual(oaDevProfileHeaders["projects"], "oa-stock,jiuji-m,9ji-admin", "explicit OA dev profile should keep its own projects header");

const defaultOnlyServer = {
  name: "oa-only-service",
  url: "http://127.0.0.1:1350/sse",
  type: "sse" as const,
  headers: {
    "x-global": "oa-only-global",
  },
  headerProfiles: {
    "/oa": {
      env: "pro",
    },
  },
};
const switchedDefaultOnlyHeaders = buildMcpHeaders(defaultOnlyServer, bot, {
  gitnexus: {
    projects: "small-oa,jiuyun-oa",
  },
});
assertEqual(switchedDefaultOnlyHeaders["x-global"], "oa-only-global", "explicit global profile switch should keep unrelated server static headers");
assertEqual(switchedDefaultOnlyHeaders["env"], undefined, "explicit global profile switch should not retain another server default OA profile");

const httpTransport = createMcpTransport(config.mcpServers[0]!, config.bots[0]);
assertEqual(httpTransport?.constructor.name, "StreamableHTTPClientTransport", "http MCP server should use Streamable HTTP transport");

try {
  await withMcpServerLoadTimeout(new Promise(() => {}), "stuck MCP server", 1);
  throw new Error("stuck MCP server should time out");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("stuck MCP server timed out")) {
    throw error;
  }
}

console.log("配置解析与 MCP header 合并验证通过");
