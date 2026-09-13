import assert from "node:assert/strict";
import {
  buildRequestRawTrace,
  isRequestRawLoggingEnabled,
} from "../request-raw-trace.js";

assert.equal(isRequestRawLoggingEnabled("true"), true);
assert.equal(isRequestRawLoggingEnabled("1"), false);
assert.equal(isRequestRawLoggingEnabled("TRUE"), false);
assert.equal(
  buildRequestRawTrace({ userInput: "不应记录" }, false),
  undefined,
  "关闭开关时不得生成原文日志",
);

const trace = buildRequestRawTrace({
  userInput: "查询 Authorization: Bearer user-secret 和 postgres://user:db-secret@localhost/app 的请求",
  error: "request failed?api_key=api-secret",
  toolRecords: [{
    id: "tool-1",
    name: "query",
    args: JSON.stringify({ token: "token-secret", query: "select 1" }),
    content: "password=pass-secret\nprivateKey=-----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----\n结果",
  }],
}, true);

assert.ok(trace);
assert.match(trace, /\[用户原文\]/);
assert.match(trace, /\[错误原文\]/);
assert.match(trace, /\[工具参数\]/);
assert.match(trace, /\[工具返回\]/);
assert.doesNotMatch(trace, /user-secret|api-secret|token-secret|pass-secret|db-secret|private-key-secret/);

const truncated = buildRequestRawTrace({ userInput: "x".repeat(20_000) }, true);
assert.match(truncated || "", /已截断/);
assert.ok((truncated || "").length <= 256_000);

console.log("request raw trace 验证通过");
