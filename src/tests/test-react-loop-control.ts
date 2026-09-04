import { strict as assert } from "node:assert";
import {
  REACT_LOOP_GRAPH,
  createReactLoopController,
  wrapToolsWithReactLoopControl,
} from "../react-loop-control.js";

assert.deepEqual(REACT_LOOP_GRAPH.START, ["init"], "START should enter init");
assert.deepEqual(REACT_LOOP_GRAPH.init, ["plan"], "init should enter plan");
assert.deepEqual(REACT_LOOP_GRAPH.plan, ["act"], "plan should enter act");
assert.deepEqual(REACT_LOOP_GRAPH.act, ["evaluateAction"], "act should only enter evaluateAction");
assert.deepEqual(
  REACT_LOOP_GRAPH.evaluateAction,
  ["executeTool", "final", "askUser", "revisePlan", "abort"],
  "evaluateAction should route to execution or controlled terminal/repair nodes",
);
assert.deepEqual(REACT_LOOP_GRAPH.executeTool, ["observeUpdate"], "executeTool should enter observeUpdate");
assert.deepEqual(REACT_LOOP_GRAPH.observeUpdate, ["evaluateProgress"], "observeUpdate should enter evaluateProgress");
assert.deepEqual(
  REACT_LOOP_GRAPH.evaluateProgress,
  ["act", "revisePlan", "final", "askUser", "abort"],
  "evaluateProgress should route to continue, repair, finish, ask or abort",
);
assert.deepEqual(REACT_LOOP_GRAPH.final, ["END"], "final should end");
assert.deepEqual(REACT_LOOP_GRAPH.askUser, ["END"], "askUser should end");
assert.deepEqual(REACT_LOOP_GRAPH.abort, ["END"], "abort should end");

const repeatController = createReactLoopController({ maxRepeatedToolActions: 2, maxToolActions: 99 });
const firstRepeat = repeatController.evaluateAction({ type: "tool", toolName: "query", args: { query: "订单状态", repo: "oa-order" } });
const secondRepeat = repeatController.evaluateAction({ type: "tool", toolName: "query", args: { repo: "oa-order", query: "订单状态" } });
const thirdRepeat = repeatController.evaluateAction({ type: "tool", toolName: "query", args: { query: "订单状态", repo: "oa-order" } });
assert.equal(firstRepeat.allowed, true, "first equivalent action should pass");
assert.equal(secondRepeat.allowed, true, "second equivalent action should pass within repeat limit");
assert.equal(thirdRepeat.allowed, false, "third equivalent action should be blocked");
assert.equal(thirdRepeat.nextNode, "revisePlan", "duplicate action should revise plan");

const budgetController = createReactLoopController({ maxToolActions: 1, maxRepeatedToolActions: 99 });
assert.equal(
  budgetController.evaluateAction({ type: "tool", toolName: "runtime_todolist_update", args: { items: [] } }).allowed,
  true,
  "runtime todo update should not consume evidence budget",
);
assert.equal(
  budgetController.evaluateAction({ type: "tool", toolName: "query", args: { query: "A" } }).allowed,
  true,
  "first evidence tool should pass within budget",
);
const budgetDecision = budgetController.evaluateAction({ type: "tool", toolName: "read_file", args: { path: "src/a.ts" } });
assert.equal(budgetDecision.allowed, false, "evidence tool beyond budget should be blocked");
assert.equal(budgetDecision.nextNode, "final", "budget exhaustion should route to final with existing evidence");

const terminalController = createReactLoopController();
assert.equal(terminalController.evaluateAction({ type: "final", content: "done" }).nextNode, "final", "final action should route to final");
assert.equal(terminalController.evaluateAction({ type: "askUser", content: "need input" }).nextNode, "askUser", "ask action should route to askUser");
assert.equal(terminalController.evaluateAction({ type: "abort", content: "stop" }).nextNode, "abort", "abort action should route to abort");

const observeController = createReactLoopController();
const observation = observeController.observeUpdate({ id: "tool-1", name: "query", args: "{}", content: "命中代码" });
assert.equal(observation.name, "query", "observeUpdate should return recorded observation");
assert.equal(observeController.getObservations().length, 1, "observeUpdate should persist observation");
assert.equal(
  observeController.evaluateProgress({ latestObservation: observation }).nextNode,
  "act",
  "valid observation should continue to act by default",
);
assert.equal(
  observeController.evaluateProgress({ latestObservation: { ...observation, content: "timeout error" } }).nextNode,
  "revisePlan",
  "failure observation should revise plan",
);
assert.equal(
  observeController.evaluateProgress({ finalContent: "最终结论" }).nextNode,
  "final",
  "final content should route to final",
);

let invokeCount = 0;
const fakeTool = {
  name: "query",
  async invoke(args: unknown) {
    invokeCount += 1;
    return { content: `ok:${JSON.stringify(args)}` };
  },
};
const wrappedTools = wrapToolsWithReactLoopControl([fakeTool], createReactLoopController({ maxRepeatedToolActions: 1, maxToolActions: 99 }));
const wrappedTool = wrappedTools[0]!;
const firstResult = await wrappedTool.invoke({ query: "订单" });
const secondResult = await wrappedTool.invoke({ query: "订单" });
assert.deepEqual(firstResult, { content: "ok:{\"query\":\"订单\"}" }, "first wrapped tool call should return original result");
assert.equal(typeof secondResult, "string", "blocked wrapped tool call should return control text");
assert.match(String(secondResult), /REACT_LOOP_CONTROL/, "blocked result should include control marker");
assert.equal(invokeCount, 1, "blocked duplicate action must not call original tool");

// 查询类工具独立预算：8 次后强制收敛，即使总预算未耗尽
const queryBudgetController = createReactLoopController({ maxToolActions: 99, maxRepeatedToolActions: 99, maxQueryToolActions: 3 });
for (let index = 0; index < 3; index += 1) {
  assert.equal(
    queryBudgetController.evaluateAction({ type: "tool", toolName: "query", args: { query: `q${index}` } }).allowed,
    true,
    `query ${index + 1} should pass within query budget`,
  );
}
const queryExhausted = queryBudgetController.evaluateAction({ type: "tool", toolName: "query", args: { query: "q4" } });
assert.equal(queryExhausted.allowed, false, "query beyond budget should be blocked");
assert.equal(queryExhausted.nextNode, "final", "query exhaustion should route to final with existing evidence");
assert.match(queryExhausted.reason, /查询预算已耗尽/, "blocked reason should mention query budget");
// 非查询工具不受查询预算影响
assert.equal(
  queryBudgetController.evaluateAction({ type: "tool", toolName: "code_snippet", args: { filePath: "src/a.ts" } }).allowed,
  true,
  "non-query tool should not consume query budget",
);

// 直接匹配可设置更低的查询预算，超过后应在执行前强制收敛
const directMatchToolNames = ["query", "gitnexusQuery", "searchCode", "queryTool"];
for (const toolName of directMatchToolNames) {
  const directMatchController = createReactLoopController({ maxToolActions: 4, maxRepeatedToolActions: 1, maxQueryToolActions: 1 });
  assert.equal(
    directMatchController.evaluateAction({ type: "tool", toolName, args: { query: "库存调拨推送日志" } }).allowed,
    true,
    `direct match should allow the first ${toolName} call`,
  );
  const directMatchQueryExhausted = directMatchController.evaluateAction({ type: "tool", toolName, args: { query: "库存调拨源单据" } });
  assert.equal(directMatchQueryExhausted.allowed, false, `direct match should block the second ${toolName} call`);
  assert.equal(directMatchQueryExhausted.nextNode, "final", "direct match query exhaustion should finalize with current evidence");
}

console.log("ReAct Loop Control 验证通过");
