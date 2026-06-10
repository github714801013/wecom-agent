import assert from "node:assert/strict";
import {
  assertTodoListComplete,
  buildIncompleteAuditTodoMessage,
  buildRuntimeTodoTool,
  buildProjectScopeAuditEvidence,
  buildSqlAuditEvidence,
  blockTodoItem,
  completeTodoItem,
  createRuntimeTodoList,
  getIncompleteAuditTodoItems,
  getIncompleteTodoItems,
  isFinalAnswerReady,
  startTodoItem,
} from "../runtime-todolist.js";

const defaultTodoList = createRuntimeTodoList();
assert.ok(
  defaultTodoList.items.some(item => item.id === "project_scope_audited"),
  "默认 TodoList 必须包含项目/代码包一致性审核"
);
assert.ok(
  defaultTodoList.items.some(item => item.id === "sql_correctness_audited"),
  "默认 TodoList 必须包含 SQL 正确性审核"
);
assert.ok(
  defaultTodoList.items.some(item => item.id === "evidence_audited"),
  "默认 TodoList 必须包含证据完整性审核"
);
assert.ok(
  defaultTodoList.items.some(item => item.id === "final_format_audited"),
  "默认 TodoList 必须包含最终输出格式审核"
);

const todoList = createRuntimeTodoList([
  { id: "step_one", task: "第一步" },
  { id: "step_two", task: "第二步" },
]);

assert.equal(getIncompleteTodoItems(todoList).length, 2);

startTodoItem(todoList, "step_one");
assert.equal(todoList.items[0]?.status, "in_progress");

assert.throws(
  () => completeTodoItem(todoList, "step_one", ""),
  /evidence is required/,
  "完成 TodoList 条目必须提供证据"
);

completeTodoItem(todoList, "step_one", "已完成第一步");
assert.equal(todoList.items[0]?.status, "done");

assert.throws(
  () => assertTodoListComplete(todoList),
  /incomplete/,
  "未完成所有步骤时必须阻止完结"
);

completeTodoItem(todoList, "step_two", "已完成第二步");
assertTodoListComplete(todoList);

assert.equal(isFinalAnswerReady("已定位到候选入口，继续核实中。"), false);
assert.equal(isFinalAnswerReady("结论：已核实接口逻辑，权限值是 6e6。"), true);

const toolTodoList = createRuntimeTodoList();
const runtimeTodoTool = buildRuntimeTodoTool(toolTodoList);
assert.equal(getIncompleteAuditTodoItems(toolTodoList).length, 4);
await runtimeTodoTool.invoke({
  itemId: "project_scope_audited",
  status: "done",
  evidence: "已核对 repoHints=iteng-sp",
});
await runtimeTodoTool.invoke({
  itemId: "sql_correctness_audited",
  status: "done",
  evidence: "不涉及 SQL",
});
await runtimeTodoTool.invoke({
  itemId: "evidence_audited",
  status: "done",
  evidence: "已有工具证据支撑",
});
await runtimeTodoTool.invoke({
  itemId: "final_format_audited",
  status: "done",
  evidence: "已确认过程标签和最终结论分离",
});
assert.equal(getIncompleteAuditTodoItems(toolTodoList).length, 0);

assert.match(
  buildProjectScopeAuditEvidence("iteng-sp 项目查接口", "结论：已命中 iteng-sp 入口。", ["iteng-sp"]),
  /repoHints=iteng-sp/,
  "项目范围审核必须记录 repoHints"
);

assert.match(
  buildSqlAuditEvidence("查询订单 SQL", "dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构"),
  /dev 缺表/,
  "dev 缺表时必须允许代码反推结构路径"
);
assert.match(
  buildSqlAuditEvidence("查询订单 SQL", "SELECT * FROM order_info LIMIT 20"),
  /需在最终回答中说明 dev 校验或 dev 缺表代码反推路径/,
  "涉及 SQL 但没有校验证据时必须进入拦截路径"
);
assert.match(
  buildSqlAuditEvidence("查按钮权限", "权限值是 6e6"),
  /不涉及 SQL/,
  "不涉及 SQL 时允许审核项以不适用完成"
);

const incompleteAuditTodoList = createRuntimeTodoList();
blockTodoItem(incompleteAuditTodoList, "sql_correctness_audited", "回答包含 SELECT，但没有 dev 校验结果");
const incompleteAuditMessage = buildIncompleteAuditTodoMessage(getIncompleteAuditTodoItems(incompleteAuditTodoList));
assert.match(incompleteAuditMessage, /SQL 正确性审核未完成/);
assert.match(incompleteAuditMessage, /原因：回答包含 SELECT，但没有 dev 校验结果/);
assert.match(incompleteAuditMessage, /下一步：/);
assert.match(incompleteAuditMessage, /dev 执行校验结果/);
assert.match(incompleteAuditMessage, /dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构/);

const finalFormatAuditTodoList = createRuntimeTodoList();
completeTodoItem(finalFormatAuditTodoList, "project_scope_audited", "不涉及代码范围");
completeTodoItem(finalFormatAuditTodoList, "sql_correctness_audited", "不涉及 SQL");
completeTodoItem(finalFormatAuditTodoList, "evidence_audited", "已有结论证据");
const finalFormatAuditMessage = buildIncompleteAuditTodoMessage(getIncompleteAuditTodoItems(finalFormatAuditTodoList));
assert.match(finalFormatAuditMessage, /最终输出格式审核未完成/);
assert.match(finalFormatAuditMessage, /过程标签和最终结论分离/);

console.log("runtime todolist 验证通过");
