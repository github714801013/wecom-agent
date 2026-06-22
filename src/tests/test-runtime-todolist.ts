import assert from "node:assert/strict";
import {
  applySqlAuditEvidence,
  assertTodoListComplete,
  buildIncompleteAuditTodoMessage,
  buildProjectScopeAuditEvidence,
  buildRuntimeTodoTool,
  buildSqlAuditEvidence,
  blockTodoItem,
  completeTodoItem,
  createRuntimeTodoList,
  getIncompleteAuditTodoItems,
  getIncompleteTodoItems,
  isFinalAnswerReady,
  isSqlAuditEvidenceBlocking,
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
  defaultTodoList.items.some(item => item.id === "execution_flow_audited"),
  "默认 TodoList 必须包含执行链完整性审核"
);
assert.ok(
  defaultTodoList.items.some(item => item.id === "owner_contact_audited"),
  "默认 TodoList 必须包含开发人员联系建议审核"
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
assert.equal(getIncompleteAuditTodoItems(toolTodoList).length, 6);
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
  itemId: "execution_flow_audited",
  status: "done",
  evidence: "已核对入口、分发、状态映射、下游发送条件和异常捕获",
});
await runtimeTodoTool.invoke({
  itemId: "owner_contact_audited",
  status: "done",
  evidence: "建议联系相关开发人员，git_author_trace 无可用结果",
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
  buildSqlAuditEvidence("dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构"),
  /dev 缺表/,
  "dev 缺表时必须允许代码反推结构路径"
);
assert.match(
  buildSqlAuditEvidence(
    "取消快递按钮由 WuliuController 进入 service 判断；关键字段名包括 deliveryStatus、cancelStatus，Mapper 只用于读取当前状态。可取消条件：未出库、未签收、未生成取消单。",
  ),
  /不涉及 SQL/,
  "代码逻辑类问题即使回答包含字段名和 Mapper，也不应触发 SQL dev 校验要求",
);
assert.match(
  buildSqlAuditEvidence(
    "当前回答只说明代码逻辑：Controller 调 Service，Mapper 按状态字段读取订单；没有输出新的 SQL 语句。",
  ),
  /不涉及 SQL/,
  "用户问题里包含 SQL 但最终回答没有输出 SQL 时，不应触发 SQL dev 校验要求",
);
assert.match(
  buildSqlAuditEvidence(
    "当前只说明取消快递逻辑，不需要写 SQL。",
  ),
  /不涉及 SQL/,
  "否定语境中的写 SQL 不应触发 SQL dev 校验要求",
);
assert.match(
  buildSqlAuditEvidence(
    "Select the best approach based on requirements; show the comparison below.",
  ),
  /不涉及 SQL/,
  "普通英文 select/show 动词不应被误提取为 SQL 语句",
);
assert.match(
  buildSqlAuditEvidence("SELECT * FROM order_info LIMIT 20"),
  /需在最终回答中说明 dev 校验或 dev 缺表代码反推路径/,
  "涉及 SQL 但没有校验证据时必须进入拦截路径"
);
assert.match(
  buildSqlAuditEvidence(
    "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
    [],
  ),
  /缺少.*真实 dev 查询工具结果/,
  "涉及 SQL 时不能只凭最终回答文字声明 dev 校验通过",
);
assert.match(
  buildSqlAuditEvidence(
    "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
    [{ id: "tool-1", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info LIMIT 20\"}", content: "[]" }],
  ),
  /真实 dev 查询工具结果/,
  "真实 dev 查询工具结果可以支撑 SQL 校验通过",
);
assert.match(
  buildSqlAuditEvidence(
    "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
    [{ id: "tool-1a", name: "read_query", args: "{\"database_name\":\"dev\",\"sql\":\"SELECT * FROM order_info LIMIT 20\"}", content: "[]" }],
  ),
  /真实 dev 查询工具结果/,
  "真实 dev 查询工具使用 sql 参数时也可以支撑 SQL 校验通过",
);
const sqlAuditPassedEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
  [{ id: "tool-1b", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info LIMIT 20; -- verified in dev\"}", content: "[]" }],
);
assert.equal(
  isSqlAuditEvidenceBlocking(sqlAuditPassedEvidence),
  false,
  "真实 dev 查询工具结果支撑的 SQL 审核证据不应阻塞最终发送",
);
const sqlAuditTodoList = createRuntimeTodoList();
applySqlAuditEvidence(sqlAuditTodoList, sqlAuditPassedEvidence);
assert.equal(
  sqlAuditTodoList.items.find(item => item.id === "sql_correctness_audited")?.status,
  "done",
  "SQL 审核非阻塞证据必须把 sql_correctness_audited 标记为 done",
);
const sqlAuditBlockingEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
  [],
);
const sqlAuditBlockingTodoList = createRuntimeTodoList();
applySqlAuditEvidence(sqlAuditBlockingTodoList, sqlAuditBlockingEvidence);
assert.equal(
  sqlAuditBlockingTodoList.items.find(item => item.id === "sql_correctness_audited")?.status,
  "blocked",
  "SQL 审核阻塞证据必须把 sql_correctness_audited 标记为 blocked",
);
const inlineSqlEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\nSELECT * FROM order_info LIMIT 20\n后续按该 SQL 判断。",
  [{ id: "tool-1c", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info LIMIT 20\"}", content: "[]" }],
);
assert.match(
  inlineSqlEvidence,
  /已有真实 dev 查询工具结果支撑/,
  "行内 SQL 不带分号且后续还有文字时，不应把后续说明拼进 SQL 匹配",
);
assert.equal(
  isSqlAuditEvidenceBlocking(inlineSqlEvidence),
  false,
  "行内 SQL 正确匹配时应为非阻塞证据",
);
const mixedSqlEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```\n补充校验：SELECT id FROM order_info LIMIT 1;",
  [{ id: "tool-1d", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT id FROM order_info LIMIT 1\"}", content: "[]" }],
);
assert.match(
  mixedSqlEvidence,
  /已有真实 dev 查询工具结果支撑/,
  "代码块 SQL 和行内 SQL 应合并提取，不能只校验代码块里的第一条 SQL",
);
assert.equal(
  isSqlAuditEvidenceBlocking(mixedSqlEvidence),
  false,
  "代码块与行内 SQL 正确匹配时应为非阻塞证据",
);
const multiStatementSqlEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20; SELECT id FROM order_info LIMIT 1;\n```",
  [{ id: "tool-1e", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT id FROM order_info LIMIT 1\"}", content: "[]" }],
);
assert.match(
  multiStatementSqlEvidence,
  /已有真实 dev 查询工具结果支撑/,
  "多语句 SQL 代码块应按分号拆分后匹配 dev 查询工具结果",
);
assert.equal(
  isSqlAuditEvidenceBlocking(multiStatementSqlEvidence),
  false,
  "多语句 SQL 正确匹配时应为非阻塞证据",
);
const commentedSqlEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info /* get all; columns */ LIMIT 20;\n```",
  [{ id: "tool-1f", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info LIMIT 20\"}", content: "[]" }],
);
assert.match(
  commentedSqlEvidence,
  /已有真实 dev 查询工具结果支撑/,
  "SQL 注释中的分号不应导致同一条 SQL 匹配失败",
);
assert.equal(
  isSqlAuditEvidenceBlocking(commentedSqlEvidence),
  false,
  "SQL 注释中的分号正确处理时应为非阻塞证据",
);
const quotedSemicolonSqlEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info WHERE remark = 'a;b' LIMIT 20;\n```",
  [{ id: "tool-1g", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info WHERE remark = 'a;b' LIMIT 20\"}", content: "[]" }],
);
assert.match(
  quotedSemicolonSqlEvidence,
  /已有真实 dev 查询工具结果支撑/,
  "SQL 字符串字面量中的分号不应导致同一条 SQL 匹配失败",
);
assert.equal(
  isSqlAuditEvidenceBlocking(quotedSemicolonSqlEvidence),
  false,
  "SQL 字符串字面量中的分号正确处理时应为非阻塞证据",
);
const doubleDashInStringSqlEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info WHERE remark = 'a--b' LIMIT 20;\n```",
  [{ id: "tool-1h", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info WHERE remark = 'a--b' LIMIT 20\"}", content: "[]" }],
);
assert.equal(
  isSqlAuditEvidenceBlocking(doubleDashInStringSqlEvidence),
  false,
  "SQL 字符串字面量中的双横线不应被误当作注释",
);
const hashCommentSqlEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20 # comment; ignored\n```",
  [{ id: "tool-1i", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info LIMIT 20\"}", content: "[]" }],
);
assert.equal(
  isSqlAuditEvidenceBlocking(hashCommentSqlEvidence),
  false,
  "MySQL # 注释中的分号不应导致同一条 SQL 匹配失败",
);
const backtickIdentifierSqlEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT `order_id` FROM `order_info` LIMIT 20;\n```",
  [{ id: "tool-1ia", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT order_id FROM order_info LIMIT 20\"}", content: "[]" }],
);
assert.equal(
  isSqlAuditEvidenceBlocking(backtickIdentifierSqlEvidence),
  false,
  "MySQL 反引号标识符和无反引号工具 SQL 应识别为同一条 SQL",
);
const escapedBackslashSqlEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info WHERE path = 'C:\\\\' LIMIT 20;\n```",
  [{ id: "tool-1j", name: "read_query", args: JSON.stringify({ database_name: "dev", query: "SELECT * FROM order_info WHERE path = 'C:\\\\' LIMIT 20" }), content: "[]" }],
);
assert.equal(
  isSqlAuditEvidenceBlocking(escapedBackslashSqlEvidence),
  false,
  "SQL 字符串中偶数反斜杠后的引号应正确闭合",
);
assert.match(
  buildSqlAuditEvidence(
    "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT bad_col FROM order_info LIMIT 20;\n```",
    [{ id: "tool-2", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT bad_col FROM order_info LIMIT 20\"}", content: "Unknown column 'bad_col'" }],
  ),
  /缺少.*真实 dev 查询工具结果/,
  "dev 查询工具结果报错时不能支撑 SQL 校验通过",
);
assert.match(
  buildSqlAuditEvidence(
    "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
    [{ id: "tool-3", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT 1\"}", content: "[{\"1\":1}]" }],
  ),
  /缺少同一条 SQL 的真实 dev 查询工具结果/,
  "必须校验最终回答中的同一条 SQL，不能用无关 dev 查询冒充",
);
assert.equal(
  isSqlAuditEvidenceBlocking(buildSqlAuditEvidence(
    "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
    [{ id: "tool-4", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT 1\"}", content: "[{\"1\":1}]" }],
  )),
  true,
  "同 SQL 校验缺失必须被最终发送前审核拦截",
);
const noSqlInAnswerEvidence = buildSqlAuditEvidence(
  "已在 dev 环境对应库执行，查询不报错。",
  [{ id: "tool-4a", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info LIMIT 20\"}", content: "[]" }],
);
assert.match(
  noSqlInAnswerEvidence,
  /缺少.*真实 dev 查询工具结果/,
  "声明已校验但最终回答没有可提取 SQL 时必须提示缺少校验结果",
);
assert.equal(
  isSqlAuditEvidenceBlocking(noSqlInAnswerEvidence),
  true,
  "声明已校验但最终回答没有可提取 SQL 时必须拦截",
);
assert.equal(
  isSqlAuditEvidenceBlocking(buildSqlAuditEvidence(
    "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
    [{ id: "tool-5", name: "mock_read_query_debug", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info LIMIT 20\"}", content: "[]" }],
  )),
  true,
  "调试类相似工具名不能冒充 dev SQL 校验工具",
);
assert.match(
  buildSqlAuditEvidence(
    "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
    [{ id: "tool-6", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info LIMIT 20\"}", content: "No error found, query executed with 0 exceptions" }],
  ),
  /真实 dev 查询工具结果/,
  "非错误语义的 error/exception 文本不能误判为 dev 校验失败",
);
assert.match(
  buildSqlAuditEvidence(
    "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
    [{ id: "tool-7", name: "read_query", args: "{\"database_name\":\"dev\",\"query\":\"SELECT * FROM order_info LIMIT 20\"}", content: "已排除异常数据行，查询返回 0 行" }],
  ),
  /真实 dev 查询工具结果/,
  "非错误语义的中文异常文本不能误判为 dev 校验失败",
);
assert.match(
  buildSqlAuditEvidence("权限值是 6e6"),
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
completeTodoItem(finalFormatAuditTodoList, "execution_flow_audited", "不涉及接口链路");
completeTodoItem(finalFormatAuditTodoList, "owner_contact_audited", "不涉及开发推动");
const finalFormatAuditMessage = buildIncompleteAuditTodoMessage(getIncompleteAuditTodoItems(finalFormatAuditTodoList));
assert.match(finalFormatAuditMessage, /最终输出格式审核未完成/);
assert.match(finalFormatAuditMessage, /过程标签和最终结论分离/);

const ownerContactAuditTodoList = createRuntimeTodoList();
completeTodoItem(ownerContactAuditTodoList, "project_scope_audited", "已核对 repo");
completeTodoItem(ownerContactAuditTodoList, "sql_correctness_audited", "不涉及 SQL");
completeTodoItem(ownerContactAuditTodoList, "evidence_audited", "已有结论证据");
completeTodoItem(ownerContactAuditTodoList, "execution_flow_audited", "已核对完整执行链");
const ownerContactAuditMessage = buildIncompleteAuditTodoMessage(getIncompleteAuditTodoItems(ownerContactAuditTodoList));
assert.match(ownerContactAuditMessage, /开发人员联系建议审核未完成/);
assert.match(ownerContactAuditMessage, /git_author_trace/);
assert.match(ownerContactAuditMessage, /联系相关开发人员/);
assert.match(ownerContactAuditMessage, /最终结论实际引用/);
assert.match(ownerContactAuditMessage, /最终未引用的候选文件/);
assert.match(ownerContactAuditMessage, /最相关的修改优先/);
assert.match(ownerContactAuditMessage, /最新修改优先/);

const executionFlowAuditTodoList = createRuntimeTodoList();
completeTodoItem(executionFlowAuditTodoList, "project_scope_audited", "已核对 repo");
completeTodoItem(executionFlowAuditTodoList, "sql_correctness_audited", "不涉及 SQL");
completeTodoItem(executionFlowAuditTodoList, "evidence_audited", "已有结论证据");
const executionFlowAuditMessage = buildIncompleteAuditTodoMessage(getIncompleteAuditTodoItems(executionFlowAuditTodoList));
assert.match(executionFlowAuditMessage, /执行链完整性审核未完成/);
assert.match(executionFlowAuditMessage, /缺失日志/);
assert.match(executionFlowAuditMessage, /下游触达条件/);
assert.match(executionFlowAuditMessage, /前置短路点/);
assert.match(executionFlowAuditMessage, /不得反过来作为主因/);
assert.match(executionFlowAuditMessage, /取数验证方式/);
assert.match(executionFlowAuditMessage, /继续下一层/);

console.log("runtime todolist 验证通过");
