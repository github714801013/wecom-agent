import assert from "node:assert/strict";

import {
  buildMcpToolsCacheKey,
  createMcpToolsCache,
} from "../mcp-client.js";

const bot = {
  name: "robot-a",
  botId: "bot-a",
  secret: "secret",
  wsUrl: "wss://example.invalid/wecom",
  mcpHeaders: {
    gitnexus: {
      "x-project": "project-a",
    },
  },
};

const otherBot = {
  ...bot,
  botId: "bot-b",
  mcpHeaders: {
    gitnexus: {
      "x-project": "project-b",
    },
  },
};

assert.equal(
  buildMcpToolsCacheKey(bot),
  "bot-a:{\"gitnexus\":{\"x-project\":\"project-a\"}}",
  "缓存 key 应区分机器人和 MCP header",
);
assert.notEqual(
  buildMcpToolsCacheKey(bot),
  buildMcpToolsCacheKey(otherBot),
  "不同机器人和 MCP header 应生成不同缓存 key",
);

let now = 1_000;
let loadCount = 0;
const cache = createMcpToolsCache(30 * 60 * 1000, () => now);
type CachedTool = Awaited<ReturnType<typeof cache.get>>[number];
const mockTool = (name: string): CachedTool => ({ name } as CachedTool);

const first = await cache.get("robot-a", async () => {
  loadCount += 1;
  return [mockTool("query")];
});

const second = await cache.get("robot-a", async () => {
  loadCount += 1;
  return [mockTool("query-reloaded")];
});

assert.equal(loadCount, 1, "TTL 内应复用已加载工具");
assert.equal(second, first, "TTL 内应返回同一个工具列表实例");

now += 30 * 60 * 1000 + 1;
const third = await cache.get("robot-a", async () => {
  loadCount += 1;
  return [mockTool("query-reloaded")];
});

assert.equal(loadCount, 2, "超过 TTL 后应重新加载工具");
assert.notEqual(third, first, "超过 TTL 后应返回新的工具列表实例");

console.log("MCP 工具缓存验证通过");
