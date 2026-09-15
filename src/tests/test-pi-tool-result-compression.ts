import assert from "node:assert/strict";
import { createPiMcpPluginTools } from "../pi-agent-runtime.js";
import {
  buildToolResultFileReadTool,
  readStoredToolResult,
  storeToolResult,
} from "../tool-result-store.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  assert.ok(block && block.type === "text");
  return block.text || "";
}

const largeCode = JSON.stringify({
  repo: "oa-stock",
  filePath: "src/order.ts",
  startLine: 40,
  endLine: 200,
  content: `const evidence = "order evidence";\n${"irrelevant implementation line\n".repeat(500)}`,
});
const [codeTool] = createPiMcpPluginTools([{
  name: "code_snippet",
  description: "读取代码片段",
  schema: { type: "object", properties: {} },
  invoke: async () => largeCode,
}]);
assert.ok(codeTool);
const codeSummaryText = textOf(await codeTool.execute("code-1", {}));
const codeSummary = JSON.parse(codeSummaryText) as {
  kind?: string;
  fileId?: string;
  originalSize?: number;
  matches?: Array<{ file?: string; line?: number; evidence?: string }>;
};
assert.equal(codeSummary.kind, "evidence_summary");
assert.ok(codeSummary.fileId);
assert.equal(codeSummary.originalSize, largeCode.length);
assert.ok(codeSummary.matches?.some(match => match.file === "src/order.ts" && match.line === 40));
assert.match(codeSummaryText, /order evidence/);
assert.ok(codeSummaryText.length < 8_000, "摘要不得再次膨胀到分工具阈值");
assert.match(readStoredToolResult(codeSummary.fileId!, 0, 200), /order evidence/);

const [smallQueryTool] = createPiMcpPluginTools([{
  name: "query",
  description: "检索代码",
  schema: { type: "object", properties: {} },
  invoke: async () => "src/order.ts:42 已命中直接证据",
}]);
assert.ok(smallQueryTool);
assert.equal(
  textOf(await smallQueryTool.execute("small-query-1", {})),
  "src/order.ts:42 已命中直接证据",
  "未超过阈值的 query 结果应保持原样",
);

const [emptyQueryTool] = createPiMcpPluginTools([{
  name: "query",
  description: "检索代码",
  schema: { type: "object", properties: { query: { type: "string" } } },
  invoke: async () => JSON.stringify({ total: 0, results: [] }),
}]);
assert.ok(emptyQueryTool);
assert.equal(
  textOf(await emptyQueryTool.execute("empty-query-1", { query: "missing" })),
  "本次检索未获得相关结果：query missing。后续避免重复使用相同条件。",
  "无命中结果应在进入模型前压缩",
);

const queryWithNestedZeroCount = JSON.stringify({
  total: 0,
  processes: [{
    process_symbols: [{
      name: "NestedEvidence",
      file_path: "src/nested-evidence.ts",
      line_start: 12,
      content: `nested evidence ${"x".repeat(9_000)}`,
    }],
  }],
});
const [queryWithNestedZeroCountTool] = createPiMcpPluginTools([{
  name: "query",
  description: "检索代码",
  schema: { type: "object", properties: {} },
  invoke: async () => queryWithNestedZeroCount,
}]);
assert.ok(queryWithNestedZeroCountTool);
const nestedZeroCountSummary = JSON.parse(textOf(await queryWithNestedZeroCountTool.execute("nested-zero-count-1", {}))) as {
  kind?: string;
  fileId?: string;
  matches?: Array<{ file?: string; line?: number }>;
};
assert.equal(nestedZeroCountSummary.kind, "evidence_summary", "包含可定位证据时不得因嵌套零计数丢弃结果");
assert.ok(nestedZeroCountSummary.fileId);
assert.ok(nestedZeroCountSummary.matches?.some(match => match.file === "src/nested-evidence.ts" && match.line === 12));
assert.match(readStoredToolResult(nestedZeroCountSummary.fileId!, 0, 200), /NestedEvidence/);

const largeQuery = JSON.stringify({
  processes: [{
    process_symbols: [{
      name: "OrderService",
      file_path: "src/order-service.ts",
      line_start: 42,
      line_end: 80,
    }],
  }],
  padding: "query result padding ".repeat(500),
});
const [queryTool] = createPiMcpPluginTools([{
  name: "query",
  description: "检索代码",
  schema: { type: "object", properties: {} },
  invoke: async () => largeQuery,
}]);
assert.ok(queryTool);
const querySummary = JSON.parse(textOf(await queryTool.execute("query-1", {}))) as {
  kind?: string;
  fileId?: string;
  matches?: Array<{ file?: string; line?: number }>;
};
assert.equal(querySummary.kind, "evidence_summary");
assert.ok(querySummary.fileId);
assert.ok(querySummary.matches?.some(match => match.file === "src/order-service.ts" && match.line === 42));
assert.match(readStoredToolResult(querySummary.fileId!, 0, 300), /OrderService/);

// MCP 常在 JSON 之后追加 markdown 页脚：不得因此判定为解析失败而丢弃证据
const gitnexusPayload = `{
  "processes": [
    {
      "id": "proc_1",
      "summary": "AutoMkc → 调货",
      "process_symbols": [
        { "name": "AutoMkc", "file_path": "oa999UI/AutoMkc.aspx.cs", "line_start": 42, "line_end": 80 }
      ]
    }
  ],
  "errors": []
}

---
**Next:** To understand a specific symbol in depth, use context({name: "<symbol_name>"}) to see categorized refs.`;
const [footeredQueryTool] = createPiMcpPluginTools([{
  name: "query",
  description: "带页脚的检索结果",
  schema: { type: "object", properties: {} },
  invoke: async () => `${gitnexusPayload}${" ".repeat(9_000)}`,
}]);
assert.ok(footeredQueryTool);
const footeredSummary = JSON.parse(textOf(await footeredQueryTool.execute("footered-query-1", {}))) as {
  kind?: string;
  matches?: Array<{ file?: string; line?: number }>;
};
assert.equal(footeredSummary.kind, "evidence_summary", "JSON 后的 markdown 页脚不得导致证据被丢弃");
assert.ok(footeredSummary.matches?.some(match => match.file === "oa999UI/AutoMkc.aspx.cs" && match.line === 42));

const veryLargeStructuredQuery = JSON.stringify({
  results: [{
    file_path: "src/very-large.ts",
    line_start: 77,
    line_end: 91,
    content: "large structured evidence",
  }],
  padding: "irrelevant result padding ".repeat(12_000),
});
assert.ok(veryLargeStructuredQuery.length > 256_000);
const [veryLargeStructuredQueryTool] = createPiMcpPluginTools([{
  name: "query",
  description: "读取超大结构化检索结果",
  schema: { type: "object", properties: {} },
  invoke: async () => veryLargeStructuredQuery,
}]);
assert.ok(veryLargeStructuredQueryTool);
const veryLargeStructuredSummary = JSON.parse(textOf(await veryLargeStructuredQueryTool.execute("very-large-structured-1", {}))) as {
  kind?: string;
  matches?: Array<{ file?: string; line?: number; endLine?: number; evidence?: string }>;
};
assert.equal(veryLargeStructuredSummary.kind, "evidence_summary", "超大可解析结果仍应生成结构化证据摘要");
assert.ok(veryLargeStructuredSummary.matches?.some(match =>
  match.file === "src/very-large.ts" && match.line === 77 && match.endLine === 91 && match.evidence === "large structured evidence",
));

const scopedQuery = JSON.stringify([{
  repo: "oa-stock",
  result: JSON.stringify({ file_path: "src/scoped.ts", line_start: 7, content: `scoped evidence ${"x".repeat(9_000)}` }),
}]);
const [scopedQueryTool] = createPiMcpPluginTools([{
  name: "query",
  description: "检索代码",
  schema: { type: "object", properties: {} },
  invoke: async () => scopedQuery,
}]);
assert.ok(scopedQueryTool);
const scopedSummary = JSON.parse(textOf(await scopedQueryTool.execute("scoped-query-1", {}))) as {
  matches?: Array<{ repo?: string; file?: string; line?: number }>;
};
assert.ok(scopedSummary.matches?.some(match => match.repo === "oa-stock" && match.file === "src/scoped.ts" && match.line === 7));

const plainSnippet = `src/plain-order.ts:42 | const evidence = "plain snippet evidence";\n${"unrelated implementation line\n".repeat(500)}`;
const [plainSnippetTool] = createPiMcpPluginTools([{
  name: "code_snippet",
  description: "读取代码片段",
  schema: { type: "object", properties: {} },
  invoke: async () => plainSnippet,
}]);
assert.ok(plainSnippetTool);
const plainSnippetSummary = JSON.parse(textOf(await plainSnippetTool.execute("plain-snippet-1", {}))) as {
  kind?: string;
  matches?: Array<{ file?: string; line?: number; evidence?: string }>;
};
assert.equal(plainSnippetSummary.kind, "evidence_summary");
assert.ok(plainSnippetSummary.matches?.some(match => match.file === "src/plain-order.ts" && match.line === 42));
assert.match(JSON.stringify(plainSnippetSummary), /plain snippet evidence/);

const malformed = "unstructured result ".repeat(600);
const [malformedTool] = createPiMcpPluginTools([{
  name: "code_snippet",
  description: "读取代码片段",
  schema: { type: "object", properties: {} },
  invoke: async () => malformed,
}]);
assert.ok(malformedTool);
const malformedSummaryText = textOf(await malformedTool.execute("malformed-1", {}));
const malformedSummary = JSON.parse(malformedSummaryText) as { kind?: string; fileId?: string; preview?: string };
assert.equal(malformedSummary.kind, "tool_result_reference");
assert.ok(malformedSummary.fileId);
assert.match(malformedSummary.preview || "", /unstructured result/);
assert.ok((malformedSummary.preview || "").length <= 300, "解析失败预览必须受限");
assert.ok(malformedSummaryText.length < malformed.length, "解析失败不得把完整原文重新送入模型");
assert.match(readStoredToolResult(malformedSummary.fileId!, 0, 100), /unstructured result/);

const projectsResult = JSON.stringify({
  scope: "all_indexed",
  repositories: [{ name: "oa-stock", path: "/projects/oa-stock", branch: "master", stats: { files: 99999 } }],
});
const [listReposTool] = createPiMcpPluginTools([{
  name: "gitnexus_list_repos",
  description: "列出项目",
  schema: { type: "object", properties: {} },
  invoke: async () => projectsResult,
}]);
assert.ok(listReposTool);
const projectsSummaryText = textOf(await listReposTool.execute("repos-1", {}));
const projectsSummary = JSON.parse(projectsSummaryText) as {
  kind?: string;
  projects?: Array<{ name?: string; path?: string; branch?: string; stats?: unknown }>;
};
assert.equal(projectsSummary.kind, "project_scope_summary");
assert.deepEqual(projectsSummary.projects, [{ name: "oa-stock", path: "/projects/oa-stock", branch: "master" }]);
assert.equal("stats" in (projectsSummary.projects?.[0] || {}), false);

const [listReposBlockTool] = createPiMcpPluginTools([{
  name: "gitnexus_list_repos",
  description: "返回 MCP 文本块项目清单",
  schema: { type: "object", properties: {} },
  invoke: async () => ({ content: [{ type: "text", text: projectsResult }] }),
}]);
assert.ok(listReposBlockTool);
const blockProjectsSummary = JSON.parse(textOf(await listReposBlockTool.execute("repos-block-1", {}))) as {
  kind?: string;
  projects?: Array<{ name?: string; path?: string; branch?: string }>;
};
assert.equal(blockProjectsSummary.kind, "project_scope_summary", "MCP 文本块项目结果也必须生成项目摘要");
assert.deepEqual(blockProjectsSummary.projects, [{ name: "oa-stock", path: "/projects/oa-stock", branch: "master" }]);

const longGeneric = "generic tool result ".repeat(2_000);
const [genericTool] = createPiMcpPluginTools([{
  name: "describe_table",
  description: "读取表结构",
  schema: { type: "object", properties: {} },
  invoke: async () => longGeneric,
}]);
assert.ok(genericTool);
const genericReference = textOf(await genericTool.execute("generic-1", {}));
assert.match(genericReference, /结果较大已保存/);
assert.ok(genericReference.length < longGeneric.length, "通用大结果必须以受限预览替代完整内容");
const genericFileId = genericReference.match(/fileId=([0-9a-f-]{36})/iu)?.[1];
assert.ok(genericFileId, "通用大结果应返回 UUID 文件标识");
assert.match(readStoredToolResult(genericFileId!, 0, 100), /generic tool result/);
assert.match(readStoredToolResult(`${genericFileId}suffix`, 0, 100), /文件标识无效/);

const hugeRepoList = JSON.stringify({ projects: Array.from({ length: 20_000 }, (_, index) => ({ name: `repo-${index}`, path: `src/repo-${index}` })) });
const [hugeRepoTool] = createPiMcpPluginTools([{
  name: "gitnexus_list_repos",
  description: "列出项目",
  schema: { type: "object", properties: {} },
  invoke: async () => hugeRepoList,
}]);
assert.ok(hugeRepoTool);
const hugeRepoSummary = textOf(await hugeRepoTool.execute("huge-repos-1", {}));
assert.match(hugeRepoSummary, /tool_result_reference|project_scope_summary/);
assert.ok(hugeRepoSummary.length < 6_000, "超大项目结果必须在解析前受控");

const exactRead = "按需读取的完整证据".repeat(1_000);
const storedRead = storeToolResult(exactRead);
const [readTool] = createPiMcpPluginTools([buildToolResultFileReadTool()]);
assert.ok(readTool);
assert.equal(
  textOf(await readTool.execute("read-1", { fileId: storedRead.fileId, limit: 20_000 })),
  exactRead,
  "内部按需读取工具不得再次递归压缩",
);

const overlongRead = "分段读取内容".repeat(10_000);
const storedLargeRead = storeToolResult(overlongRead);
const internalLargeRead = textOf(await readTool.execute("read-large-internal", { fileId: storedLargeRead.fileId, limit: 20_000 }));
assert.doesNotMatch(internalLargeRead, /结果较大已保存/);
assert.match(internalLargeRead, /已读/);
assert.ok(internalLargeRead.length <= 20_100, "内部读取工具仍受单次读取上限保护");

const [overlongReadTool] = createPiMcpPluginTools([{
  name: "tool_result_file_read",
  description: "伪造读取工具",
  schema: { type: "object", properties: {} },
  invoke: async () => overlongRead,
}]);
assert.ok(overlongReadTool);
assert.match(textOf(await overlongReadTool.execute("read-large-1", {})), /结果较大已保存/);

const [spoofedReadTool] = createPiMcpPluginTools([{
  name: "mcp_tool_result_file_read",
  description: "外部同名工具",
  schema: { type: "object", properties: {} },
  invoke: async () => overlongRead,
}]);
assert.ok(spoofedReadTool);
assert.match(textOf(await spoofedReadTool.execute("spoofed-read-1", {})), /结果较大已保存/);

const oversizedEvidence = JSON.stringify({
  filePath: "src/oversized-evidence.ts",
  startLine: 3,
  content: `oversized evidence ${"x".repeat(1_100_000)}`,
});
const [oversizedEvidenceTool] = createPiMcpPluginTools([{
  name: "code_snippet",
  description: "读取超大代码片段",
  schema: { type: "object", properties: {} },
  invoke: async () => oversizedEvidence,
}]);
assert.ok(oversizedEvidenceTool);
const oversizedSummary = JSON.parse(textOf(await oversizedEvidenceTool.execute("oversized-evidence-1", {}))) as {
  kind?: string;
  fileId?: string;
  storedTruncated?: boolean;
  next?: string;
};
assert.equal(oversizedSummary.kind, "evidence_summary");
assert.equal(oversizedSummary.storedTruncated, true, "超出存储上限必须标记受控截断");
assert.match(oversizedSummary.next || "", /尾部未保存/);
assert.match(readStoredToolResult(oversizedSummary.fileId!, 999_900, 2_000), /未保存/);

let deepResult: Record<string, unknown> = { file_path: "src/deep-evidence.ts", line_start: 8 };
for (let depth = 0; depth < 40; depth += 1) {
  deepResult = { next: deepResult };
}
const [deepResultTool] = createPiMcpPluginTools([{
  name: "query",
  description: "读取深层结果",
  schema: { type: "object", properties: {} },
  invoke: async () => deepResult,
}]);
assert.ok(deepResultTool);
const deepSummary = JSON.parse(textOf(await deepResultTool.execute("deep-result-1", {}))) as {
  sourceTruncated?: boolean;
  next?: string;
};
assert.equal(deepSummary.sourceTruncated, true, "深层对象必须在序列化边界受控截断");
assert.match(deepSummary.next || "", /序列化边界/);

const manyLargeFields = Object.fromEntries(
  Array.from({ length: 12 }, (_, index) => [`field_${index}`, "x".repeat(100_000)]),
);
const [manyLargeFieldsTool] = createPiMcpPluginTools([{
  name: "query",
  description: "读取宽对象结果",
  schema: { type: "object", properties: {} },
  invoke: async () => manyLargeFields,
}]);
assert.ok(manyLargeFieldsTool);
const manyLargeFieldsSummary = JSON.parse(textOf(await manyLargeFieldsTool.execute("many-large-fields-1", {}))) as {
  sourceTruncated?: boolean;
  next?: string;
};
assert.equal(manyLargeFieldsSummary.sourceTruncated, true, "总预算耗尽必须保留截断状态");
assert.match(manyLargeFieldsSummary.next || "", /序列化边界/);

const expiringResult = storeToolResult("即将过期的工具结果");
const originalDateNow = Date.now;
try {
  Date.now = () => originalDateNow() + 2 * 60 * 60 * 1000 + 1;
  assert.match(readStoredToolResult(expiringResult.fileId), /文件已过期/);
} finally {
  Date.now = originalDateNow;
}

console.log("Pi 工具结果压缩边界验证通过");
