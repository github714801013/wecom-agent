import { strict as assert } from "node:assert";
import {
  buildAgentToolErrorLimitReply,
  createAgentProgressGuard,
  createAgentProgressLimitError,
  createAgentToolErrorLimitError,
} from "../agent-progress-guard.js";

const guard = createAgentProgressGuard({ maxToolResults: 99, maxRepeatedToolCalls: 2 });

assert.equal(
  guard.recordToolResult({ id: "todo-1", name: "runtime_todolist_update", args: "{}", content: "done" }).shouldStop,
  false,
  "runtime todolist updates should not count as evidence tool results",
);

assert.equal(
  guard.recordToolResult({ id: "tool-1", name: "query", args: "{\"query\":\"物流单 详情 作废\",\"repo\":\"oa-pc\"}", content: "hit 1" }).shouldStop,
  false,
  "first evidence tool result should not stop",
);

const duplicateDecision = guard.recordToolResult({
  id: "tool-2",
  name: "query",
  args: "{\"repo\":\"oa-pc\",\"query\":\"物流单 详情 作废\"}",
  content: "hit 1 again",
});
assert.equal(duplicateDecision.shouldStop, false, "same tool args should allow one repeated confirmation when configured to 2");
const thirdDuplicateDecision = guard.recordToolResult({
  id: "tool-3",
  name: "query",
  args: "{\"repo\":\"oa-pc\",\"query\":\"物流单 详情 作废\"}",
  content: "hit 3",
});
assert.equal(thirdDuplicateDecision.shouldStop, true, "same tool args should stop on third repeated call when configured to 2");
assert.match(thirdDuplicateDecision.reason, /重复工具调用/, "duplicate stop reason should be explicit");

const arrayArgsGuard = createAgentProgressGuard({ maxToolResults: 99, maxRepeatedToolCalls: 2 });
assert.equal(
  arrayArgsGuard.recordToolResult({ id: "tool-1", name: "query", args: "{\"filters\":[{\"b\":1,\"a\":2}]}", content: "hit" }).shouldStop,
  false,
  "first array object args result should not stop",
);
assert.equal(
  arrayArgsGuard.recordToolResult({ id: "tool-2", name: "query", args: "{\"filters\":[{\"a\":2,\"b\":1}]}", content: "hit again" }).shouldStop,
  false,
  "array object args should allow one repeated confirmation",
);
assert.equal(
  arrayArgsGuard.recordToolResult({ id: "tool-3", name: "query", args: "{\"filters\":[{\"a\":2,\"b\":1}]}", content: "hit third time" }).shouldStop,
  true,
  "array object args should be normalized for duplicate detection on third call when configured to 2",
);

const defaultRepeatedSnippetGuard = createAgentProgressGuard({ maxToolResults: 99 });
for (let index = 1; index <= 20; index += 1) {
  const decision = defaultRepeatedSnippetGuard.recordToolResult({
    id: `snippet-${index}`,
    name: "code_snippet",
    args: "{\"filePath\":\"src/once-ending/logistics/views/logistics-list/components/add-mixins.jsx\",\"startLine\":1}",
    content: `snippet ${index}`,
  });
  assert.equal(
    decision.shouldStop,
    false,
    "默认重复阈值不能早于总工具上限拦截代码定位问题",
  );
}

const maxGuard = createAgentProgressGuard({ maxToolResults: 2 });
assert.equal(
  maxGuard.recordToolResult({ id: "tool-1", name: "query", args: "{\"query\":\"a\"}", content: "hit" }).shouldStop,
  false,
  "first result should stay under max results",
);
const maxDecision = maxGuard.recordToolResult({ id: "tool-2", name: "code_snippet", args: "{\"filePath\":\"a.ts\"}", content: "code" });
assert.equal(maxDecision.shouldStop, true, "max evidence tool results should stop");
assert.match(maxDecision.reason, /工具调用达到上限/, "max stop reason should be explicit");

const defaultLimitGuard = createAgentProgressGuard();
for (let index = 1; index < 64; index += 1) {
  const decision = defaultLimitGuard.recordToolResult({
    id: `default-tool-${index}`,
    name: "query",
    args: JSON.stringify({ query: `物流单 详情 作废 ${index}`, repo: "oa-pc" }),
    content: `hit ${index}`,
  });
  assert.equal(
    decision.shouldStop,
    false,
    "默认工具上限不能在 64 个证据工具结果前停止",
  );
}
const defaultLimitDecision = defaultLimitGuard.recordToolResult({
  id: "default-tool-64",
  name: "query",
  args: JSON.stringify({ query: "物流单 详情 作废 64", repo: "oa-pc" }),
  content: "hit 64",
});
assert.equal(defaultLimitDecision.shouldStop, true, "默认工具上限应在第 64 个证据工具结果触发");

const toolErrorGuard = createAgentProgressGuard({
  maxToolResults: 99,
  maxRepeatedToolCalls: 99,
  maxToolErrors: 3,
});
assert.equal(
  toolErrorGuard.recordToolResult({
    id: "error-1",
    name: "query",
    args: "{\"query\":\"订单状态\"}",
    content: "Error: MCP connection timeout\n Please fix your mistakes.",
    status: "error",
  }).shouldStop,
  false,
  "first tool error should not stop the current turn",
);
assert.equal(
  toolErrorGuard.recordToolResult({
    id: "success-1",
    name: "query",
    args: "{\"query\":\"订单状态 fallback\"}",
    content: "Error rate dashboard is healthy",
    status: "success",
  }).shouldStop,
  false,
  "successful tool result containing the word Error must not be counted as a tool failure",
);
assert.equal(
  toolErrorGuard.recordToolResult({
    id: "error-2",
    name: "code_snippet",
    args: "{\"filePath\":\"src/order.ts\"}",
    content: "Error: repository index unavailable",
    status: "error",
  }).shouldStop,
  false,
  "second tool error should still allow one final attempt",
);
assert.equal(
  toolErrorGuard.recordToolResult({
    id: "todo-error",
    name: "runtime_todolist_update",
    args: "{}",
    content: "Error: todo update rejected",
    status: "error",
  }).shouldStop,
  false,
  "runtime todolist errors should not consume the business tool error budget",
);
const thirdToolErrorDecision = toolErrorGuard.recordToolResult({
  id: "error-3",
  name: "read_query",
  args: "{\"database_name\":\"dev\"}",
  content: "Error: database permission denied",
  status: "error",
});
assert.equal(thirdToolErrorDecision.shouldStop, true, "third business tool error should stop further tool calls");
assert.equal(thirdToolErrorDecision.errorCode, "AGENT_TOOL_ERROR_LIMIT");
assert.match(thirdToolErrorDecision.reason, /3\/3/, "tool error stop reason should include the configured threshold");
assert.match(thirdToolErrorDecision.reason, /read_query/, "tool error stop reason should identify the latest failed tool");
assert.match(thirdToolErrorDecision.reason, /database permission denied/, "tool error stop reason should include a bounded error summary");

const limitError = createAgentProgressLimitError("limit");
assert.equal((limitError as Error & { lc_error_code?: string }).lc_error_code, "AGENT_TOOL_PROGRESS_LIMIT");
const toolErrorLimitError = createAgentToolErrorLimitError("tool error limit");
assert.equal((toolErrorLimitError as Error & { lc_error_code?: string }).lc_error_code, "AGENT_TOOL_ERROR_LIMIT");
const toolErrorReply = buildAgentToolErrorLimitReply(thirdToolErrorDecision.reason);
assert.match(toolErrorReply, /已停止继续调用/, "user feedback should explicitly state that further tool calls were stopped");
assert.match(toolErrorReply, /3\/3/, "user feedback should include the observed tool error threshold");
assert.match(toolErrorReply, /检查对应 MCP、数据源或权限/, "user feedback should provide an actionable boundary");

console.log("agent progress guard 验证通过");
