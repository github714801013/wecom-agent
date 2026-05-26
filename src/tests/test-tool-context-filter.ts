import { strict as assert } from "node:assert";
import {
  buildToolContextSummary,
  filterToolResultForCurrentTurn,
  isLikelyIrrelevantToolResult,
} from "../tool-context-filter.js";

assert.equal(
  isLikelyIrrelevantToolResult("No results found for query"),
  true,
  "no-result tool output should be treated as irrelevant",
);

assert.equal(
  isLikelyIrrelevantToolResult(JSON.stringify({ row_count: 0, markdown: "| name |\n| --- |" })),
  true,
  "zero-row tool output should be treated as irrelevant",
);

assert.equal(
  isLikelyIrrelevantToolResult("src/order.ts:42 收款方式不能变更"),
  false,
  "file evidence should be treated as relevant",
);

const summary = buildToolContextSummary([
  {
    id: "1",
    name: "remote_gitnexus_query",
    args: JSON.stringify({ query: "收款方式变更", repo: "oa-pay" }),
    content: "No results found",
  },
  {
    id: "2",
    name: "remote_gitnexus_code_snippet",
    args: JSON.stringify({ filePath: "src/order.ts", startLine: 40 }),
    content: "src/order.ts:42 if (isGuoBu) throw new Error('收款方式不能变更')",
  },
]);

assert.match(summary, /无效检索条件/);
assert.match(summary, /remote_gitnexus_query/);
assert.match(summary, /收款方式变更/);
assert.doesNotMatch(summary, /No results found/);
assert.match(summary, /有效工具证据/);
assert.match(summary, /src\/order\.ts:42/);

const filteredNoHit = filterToolResultForCurrentTurn({
  id: "3",
  name: "remote_gitnexus_query",
  args: JSON.stringify({ query: "不存在的收款方式规则", repo: "oa-order" }),
  content: "No results found\n".repeat(100),
});

assert.equal(
  filteredNoHit,
  "本次检索未获得相关结果：remote_gitnexus_query repo=oa-order 不存在的收款方式规则。后续避免重复使用相同条件。",
  "current-turn no-hit result should be compact before entering model context",
);

const longLowSignal = filterToolResultForCurrentTurn({
  id: "4",
  name: "remote_gitnexus_query",
  args: JSON.stringify({ query: "收款方式变更", repo: "oa-pay" }),
  content: " unrelated noise ".repeat(2000),
});

assert.match(longLowSignal, /结果过长且与检索条件相关性较低/);
assert.doesNotMatch(longLowSignal, /unrelated noise unrelated noise unrelated noise/);

const relevantResult = filterToolResultForCurrentTurn({
  id: "5",
  name: "remote_gitnexus_code_snippet",
  args: JSON.stringify({ filePath: "src/order.ts" }),
  content: "src/order.ts 收款方式变更 不允许切换",
});

assert.equal(relevantResult, "src/order.ts 收款方式变更 不允许切换");

console.log("tool context filter 验证通过");
