import assert from "node:assert/strict";
import {
  analyzedCodeRangesFromCompressionSections,
  analyzedCodeRangesFromText,
  buildAnalyzedCodeRangeIndex,
  formatAnalyzedCodeRangeIndex,
} from "../analyzed-code-range-index.js";

const sectionRanges = analyzedCodeRangesFromCompressionSections([
  {
    file_path: "oaapi-service/src/main/java/com/jiuji/oaapi/service/impl/SubServiceImpl.java",
    symbol: "SubServiceImpl.submitFilmYearOrder",
    lines: "300-500",
  },
  {
    file_path: "oaapi-service/src/main/java/com/jiuji/oaapi/service/impl/SubServiceImpl.java",
    symbol: "SubServiceImpl.submitFilmYearOrder",
    lines: "300~500",
  },
  {
    file_path: "oa-after/src/main/java/SmallproFilmCardServiceImpl.java",
    symbol: "repurchaseBuyTime",
    lines: "L743-L760",
  },
]);

assert.deepEqual(
  sectionRanges.map(range => `${range.symbol}:${range.startLine}~${range.endLine}:${range.filePath}`),
  [
    "SubServiceImpl.submitFilmYearOrder:300~500:oaapi-service/src/main/java/com/jiuji/oaapi/service/impl/SubServiceImpl.java",
    "repurchaseBuyTime:743~760:oa-after/src/main/java/SmallproFilmCardServiceImpl.java",
  ],
);

const textRanges = analyzedCodeRangesFromText([
  "已读取第 510-570 行，submitFilmYearOrder 仍需继续看调用方。",
  "已分析 ShellFilmServiceImpl.getYearPackageInfo:2300~2400，后续不要重复读取。",
].join("\n"));

assert.deepEqual(
  textRanges.map(range => `${range.symbol}:${range.startLine}~${range.endLine}`),
  [
    "已读取:510~570",
    "ShellFilmServiceImpl.getYearPackageInfo:2300~2400",
  ],
);

const index = buildAnalyzedCodeRangeIndex({
  sections: [
    {
      file_path: "src/order.ts",
      symbol: "OrderService.submit",
      lines: "40-90",
    },
  ],
  texts: ["OrderService.submit:40~90 已经看过", "OrderController.create:10-30"],
});

const formatted = formatAnalyzedCodeRangeIndex(index);
assert.match(formatted, /OrderService\.submit:40~90（文件: src\/order\.ts）/);
assert.match(formatted, /OrderController\.create:10~30/);
assert.equal((formatted.match(/OrderService\.submit:40~90/g) || []).length, 1);

console.log("analyzed code range index 验证通过");
