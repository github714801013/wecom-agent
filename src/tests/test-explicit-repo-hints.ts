import assert from "node:assert/strict";
import { extractExplicitRepoHints } from "../graph.js";

assert.deepEqual(
  extractExplicitRepoHints("请在 StateAllowanceDeclaration 项目中核对提交逻辑", ["oa-order"]),
  ["StateAllowanceDeclaration"],
  "用户明确指定的未配置项目应优先作为范围提示",
);
assert.deepEqual(
  extractExplicitRepoHints("只查 oa-order 项目", ["oa-order", "oa-stock"]),
  ["oa-order"],
  "已配置的明确项目应保持原有识别结果",
);
assert.deepEqual(
  extractExplicitRepoHints("查询订单逻辑", ["oa-order"]),
  [],
  "没有项目声明时不得把普通词当作项目范围",
);

console.log("explicit repo hints 验证通过");
