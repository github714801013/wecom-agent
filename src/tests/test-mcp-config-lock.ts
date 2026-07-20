import assert from "node:assert/strict";
import { resolveActiveMcpProfileHeaders, wrapMcpToolWithConfiguredArgs } from "../mcp-client.js";

const profileServer = {
  name: "gitnexus",
  url: "http://127.0.0.1:1348/api/mcp",
  type: "http" as const,
  headers: {
    env: "static-server-env",
  },
  headerProfiles: {
    "/oa": {
      projects: "oa-stock,oa-order",
      env: "pro",
    },
    "/neo": {
      projects: "small-oa,jiuyun-oa",
    },
  },
};
const profileBot = {
  name: "robot-a",
  botId: "bot-id",
  secret: "secret",
  wsUrl: "wss://openws.work.weixin.qq.com",
  defaultMcpHeaderCommand: "/oa",
  mcpHeaders: {},
};
assert.deepEqual(
  resolveActiveMcpProfileHeaders(profileServer, profileBot),
  { projects: "oa-stock,oa-order", env: "pro" },
  "default command should expose only its active profile config to the tool lock",
);
assert.deepEqual(
  resolveActiveMcpProfileHeaders(profileServer, profileBot, {
    gitnexus: profileServer.headerProfiles["/neo"],
  }),
  { projects: "small-oa,jiuyun-oa" },
  "explicit command should replace the default profile config",
);
assert.deepEqual(
  resolveActiveMcpProfileHeaders(profileServer, profileBot, {
    db: { env: "neo-db" },
  }),
  {},
  "an explicit global switch should not leak another server profile into this tool lock",
);

const calls: Array<Record<string, unknown>> = [];
const baseTool = {
  name: "query",
  description: "Search code",
  schema: {
    shape: {
      query: {},
      repo: {},
      env: {},
      limit: {},
    },
  },
  async invoke(args: Record<string, unknown>) {
    calls.push(args);
    return { ok: true, args };
  },
};

const lockedTool = wrapMcpToolWithConfiguredArgs(baseTool, {
  projects: "small-oa,jiuyun-oa",
  env: "neo-prod",
});

await lockedTool.invoke({
  query: "order service",
  repo: "SMALL-OA",
  env: "ai-custom-env",
  limit: 20,
});
assert.deepEqual(calls, [{
  query: "order service",
  repo: "small-oa",
  limit: 20,
}], "profile-owned args should be removed from the tool body while preserving unlocked args");

const blockedResult = await lockedTool.invoke({
  query: "payment service",
  repo: "oa-order",
  env: "ai-custom-env",
});
assert.equal(calls.length, 1, "out-of-scope repo must be blocked before invoking the MCP tool");
assert.match(String(blockedResult), /MCP_CONFIG_SCOPE_VIOLATION/);
assert.doesNotMatch(String(blockedResult), /neo-prod|small-oa|jiuyun-oa/iu, "blocked reply must not expose configured header values");

const projectCalls: Array<Record<string, unknown>> = [];
const projectsTool = wrapMcpToolWithConfiguredArgs({
  name: "batch_query",
  description: "Batch query projects",
  schema: {
    shape: {
      query: {},
      projects: {},
    },
  },
  async invoke(args: Record<string, unknown>) {
    projectCalls.push(args);
    return args;
  },
}, {
  projects: "small-oa,jiuyun-oa",
});

await projectsTool.invoke({
  query: "inventory",
  projects: ["oa-stock"],
});
assert.deepEqual(projectCalls, [{
  query: "inventory",
}], "AI-provided projects should be removed because the active profile already owns that config");

const passthroughCalls: Array<Record<string, unknown>> = [];
const passthroughTool = wrapMcpToolWithConfiguredArgs({
  name: "query",
  description: "Search code without profile constraints",
  schema: {
    shape: {
      query: {},
      repo: {},
      env: {},
    },
  },
  async invoke(args: Record<string, unknown>) {
    passthroughCalls.push(args);
    return args;
  },
}, {});

await passthroughTool.invoke({
  query: "inventory",
  repo: "oa-stock",
  env: "dev",
});
assert.deepEqual(passthroughCalls, [{
  query: "inventory",
  repo: "oa-stock",
  env: "dev",
}], "AI args should pass through when the active profile does not configure those fields");

const sensitiveCalls: Array<Record<string, unknown>> = [];
const sensitiveTool = wrapMcpToolWithConfiguredArgs({
  name: "secure_query",
  description: "Secure query",
  schema: {
    shape: {
      query: {},
      authorization: {},
    },
  },
  async invoke(args: Record<string, unknown>) {
    sensitiveCalls.push(args);
    return args;
  },
}, {
  Authorization: "Bearer profile-secret",
});

await sensitiveTool.invoke({
  query: "inventory",
  authorization: "Bearer ai-secret",
});
assert.deepEqual(sensitiveCalls, [{ query: "inventory" }], "profile secrets must stay in headers and never be copied into tool args");

console.log("[SUCCESS] MCP command config lock verified");
