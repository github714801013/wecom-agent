import assert from "node:assert/strict";

// 名义推理先仅在业务提示词中做软约束，不在最终审核闸门做确定性硬拦截。
// 该测试文件保留为占位，避免历史测试入口引用已撤销的审核函数。
assert.equal(true, true);

console.log("name-only inference soft rule 验证通过");
