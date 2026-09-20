import assert from "node:assert/strict";
import { createMcpSdkTool, loadMcpSdkTools } from "../mcp-client.js";

const calls: Array<{ name: string; arguments: unknown; signal?: AbortSignal }> = [];
const controller = new AbortController();
const tool = createMcpSdkTool({
  name: "query",
  description: "Search code",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
}, {
  callTool: async (params, _resultSchema, options) => {
    calls.push({
      name: params.name,
      arguments: params.arguments,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return {
      content: [{ type: "text", text: "repo=fixture file=src/a.ts line=1 evidence=ok" }],
      isError: false,
    };
  },
});

assert.equal(tool.name, "query");
assert.equal(tool.description, "Search code");
assert.deepEqual(tool.schema, {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
});

const result = await tool.invoke(
  { query: "order" },
  { signal: controller.signal, toolCallId: "call-1" },
);
assert.deepEqual(calls, [{
  name: "query",
  arguments: { query: "order" },
  signal: controller.signal,
}]);
assert.equal(result, "repo=fixture file=src/a.ts line=1 evidence=ok", "纯文本 MCP 结果必须在 bridge 边界展开");

const structuredResult = {
  structuredContent: { rows: [{ id: 1 }] },
  content: [{ type: "text" as const, text: "fallback" }],
  isError: false,
};
const structuredTool = createMcpSdkTool({
  name: "structured",
  inputSchema: { type: "object" },
}, {
  callTool: async () => structuredResult,
});
assert.equal(await structuredTool.invoke({}), structuredResult, "结构化 MCP 结果不得丢失结构");

const errorResult = {
  content: [{ type: "text" as const, text: "upstream failed" }],
  isError: true,
};
const errorTool = createMcpSdkTool({
  name: "error",
  inputSchema: { type: "object" },
}, {
  callTool: async () => errorResult,
});
assert.equal(await errorTool.invoke({}), errorResult, "MCP 错误结果必须保留 isError 语义");

const cursors: Array<string | undefined> = [];
const pagedTools = await loadMcpSdkTools("fixture", {
  listTools: async params => {
    cursors.push(params?.cursor);
    return params?.cursor === "page-2"
      ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
      : { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" };
  },
  callTool: async () => ({ content: [] }),
  close: async () => {},
});
assert.deepEqual(cursors, [undefined, "page-2"], "MCP 工具目录必须读取所有分页");
assert.deepEqual(pagedTools.map(item => item.name), ["first", "second"]);

console.log("MCP SDK 工具桥接验证通过");
