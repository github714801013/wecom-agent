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
      authorization: "Bearer header-secret",
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

const cacheKey = buildMcpToolsCacheKey(bot);
assert.match(cacheKey, /^[a-f0-9]{64}$/);
assert.doesNotMatch(cacheKey, /project-a|header-secret/);
assert.notEqual(
  cacheKey,
  buildMcpToolsCacheKey(otherBot),
  "不同机器人和 MCP header 应生成不同缓存 key",
);
assert.notEqual(
  buildMcpToolsCacheKey(bot, { gitnexus: { projects: "oa-stock,oa-order" } }),
  buildMcpToolsCacheKey(bot, { gitnexus: { projects: "small-oa,neo-oa" } }),
  "不同会话 projects override 应生成不同缓存 key，避免复用错误的 queryable 项目列表",
);

let now = 1_000;
let loadCount = 0;
const cache = createMcpToolsCache(30 * 60 * 1000, () => now);
const cacheLogs: string[] = [];
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => cacheLogs.push(args.map(String).join(" "));
type CachedTool = Awaited<ReturnType<typeof cache.get>>[number];
const mockTool = (name: string): CachedTool => ({ name } as CachedTool);

let first: CachedTool[];
let second: CachedTool[];
let third: CachedTool[];
try {
  first = await cache.get(cacheKey, async () => {
    loadCount += 1;
    return [mockTool("query")];
  });

  second = await cache.get(cacheKey, async () => {
    loadCount += 1;
    return [mockTool("query-reloaded")];
  });

  assert.equal(loadCount, 1, "TTL 内应复用已加载工具");
  assert.equal(second, first, "TTL 内应返回同一个工具列表实例");
  assert.doesNotMatch(cacheLogs.join("\n"), /header-secret|project-a/, "缓存日志不得记录请求头原文");

  now += 30 * 60 * 1000 + 1;
  third = await cache.get(cacheKey, async () => {
    loadCount += 1;
    return [mockTool("query-reloaded")];
  });
} finally {
  console.log = originalConsoleLog;
}

assert.equal(loadCount, 2, "超过 TTL 后应重新加载工具");
assert.notEqual(third!, first!, "超过 TTL 后应返回新的工具列表实例");

let disposed = 0;
let fourth: CachedTool[];
const disposableCache = createMcpToolsCache(10, () => now);
await disposableCache.get("disposable", async () => ({
  tools: [mockTool("first-client")],
  dispose: async () => { disposed += 1; },
}));
now += 11;
fourth = await disposableCache.get("disposable", async () => ({
  tools: [mockTool("second-client")],
}));
assert.equal(disposed, 1, "TTL 刷新时必须释放旧 MCP 客户端");
assert.equal(fourth[0]?.name, "second-client");

console.log("MCP 工具缓存验证通过");
