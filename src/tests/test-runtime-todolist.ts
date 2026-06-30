import assert from "node:assert/strict";
import {
  addRuntimeAuditTodoItem,
  applySqlAuditEvidence,
  assertTodoListComplete,
  buildIncompleteAuditTodoMessage,
  buildUserFacingAuditFallbackMessage,
  buildProjectScopeAuditEvidence,
  buildRuntimeTodoTool,
  buildSqlAuditEvidence,
  blockTodoItem,
  completeAnswerSupportedAuditItems,
  completeRecoveryAuditItems,
  completeSkippedAuditItems,
  completeTodoItem,
  createRuntimeTodoList,
  generateUserFacingAuditFallbackMessage,
  getActiveAuditTodoItems,
  getIncompleteAuditTodoItems,
  getIncompleteTodoItems,
  appendIncompleteFinalNotice,
  isFinalAnswerReady,
  isSqlAuditEvidenceBlocking,
  syncRuntimeAuditTodoPlan,
  startTodoItem,
} from "../runtime-todolist.js";

function addAuditItems(todoList: ReturnType<typeof createRuntimeTodoList>, itemIds: string[]) {
  for (const itemId of itemIds) {
    addRuntimeAuditTodoItem(todoList, itemId);
  }
}

const defaultTodoList = createRuntimeTodoList();
assert.equal(
  getActiveAuditTodoItems(defaultTodoList).length,
  0,
  "默认 TodoList 只包含核心流程，审核节点必须按问题动态加入"
);
syncRuntimeAuditTodoPlan(defaultTodoList, {
  question: "九机物流单详情，什么情况下显示作废按钮",
  answer: "结论：按钮显示由 oa-pc 页面状态和接口返回共同决定。",
  plannerIntent: "API",
  repoHints: ["oa-pc"],
  toolResultCount: 2,
});
assert.deepEqual(
  getActiveAuditTodoItems(defaultTodoList).map(item => item.id),
  ["project_scope_audited", "evidence_audited", "execution_flow_audited"],
  "代码/接口类问题应动态加入范围、证据和执行链审核"
);
completeAnswerSupportedAuditItems(defaultTodoList, {
  question: "这个队列 cm_returned_imeis 是干啥的？vhost 是 oaAsync",
  answer: `结论：队列 cm_returned_imeis 用于串号转现退单。

生产者：saasoanew 的 orderTransferServices.cs 调用 SendDjangoQueueMessage。
消费者：MyDjangoProject 的 cm_order_entry/task.py 消费队列。
触发条件：调拨删除且 imeis.Count > 0。
代码证据：RabbitmqHelperSend.cs、orderTransferServices.cs、task.py。`,
  plannerIntent: "FLOW",
  repoHints: ["saasoanew", "MyDjangoProject"],
  toolResultCount: 4,
});
assert.deepEqual(
  getIncompleteAuditTodoItems(defaultTodoList).map(item => item.id),
  [],
  "已包含结论、上下游和代码证据的最终答案应程序化补齐审核项，不能被中间状态 fallback 覆盖",
);
syncRuntimeAuditTodoPlan(defaultTodoList, {
  question: "给我查询物流单 SQL",
  answer: "SELECT * FROM order_info LIMIT 20",
  plannerIntent: "SQL",
});
assert.ok(
  defaultTodoList.items.some(item => item.id === "sql_correctness_audited"),
  "SQL 类问题应动态加入 SQL 正确性审核"
);

const skippedAuditTodoList = createRuntimeTodoList();
addAuditItems(skippedAuditTodoList, [
  "execution_flow_audited",
  "owner_contact_audited",
  "sql_correctness_audited",
]);
completeSkippedAuditItems(skippedAuditTodoList, [
  "execution_flow_audited",
  "owner_contact_audited",
  "sql_correctness_audited",
  "not_a_real_item",
]);
assert.equal(
  skippedAuditTodoList.items.find(item => item.id === "execution_flow_audited")?.status,
  "done",
  "flow_control 明确跳过 execution_flow_audited 时应程序化完成该节点",
);
assert.equal(
  skippedAuditTodoList.items.find(item => item.id === "owner_contact_audited")?.status,
  "done",
  "flow_control 明确跳过 owner_contact_audited 时应程序化完成该节点",
);
assert.equal(
  skippedAuditTodoList.items.find(item => item.id === "sql_correctness_audited")?.status,
  "pending",
  "SQL 审核不能由通用跳过函数完成，必须走确定性 SQL 审核保护",
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
assert.equal(
  isFinalAnswerReady("接口 doSendWuLiuV2 在 wlCompany=jingdong 时，京东开放平台返回 code=18，即 accessToken=null，属于京东授权 Token 缺失或未正确获取。"),
  true,
  "诊断型事实结论不应因没有显式“结论”标题而被判为无意义进度",
);
assert.equal(
  isFinalAnswerReady("接口返回 code=18，accessToken=null，下一步我会继续核实 Token 刷新逻辑。"),
  true,
  "已有错误码和缺失方向的混合回答应被识别为可用诊断结论",
);
const incompleteFinalNotice = appendIncompleteFinalNotice("已识别到接口路径或请求参数锚点，我会继续围绕这些锚点核实代码入口。");
assert.match(incompleteFinalNotice, /已识别到接口路径或请求参数锚点/);
assert.match(incompleteFinalNotice, /不是最终结论/);
assert.match(incompleteFinalNotice, /目前能搜索到的信息/);
assert.match(appendIncompleteFinalNotice(""), /不是最终结论/);

const toolTodoList = createRuntimeTodoList();
const runtimeTodoTool = buildRuntimeTodoTool(toolTodoList);
assert.equal(getIncompleteAuditTodoItems(toolTodoList).length, 0);
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
addRuntimeAuditTodoItem(sqlAuditTodoList, "sql_correctness_audited");
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
addRuntimeAuditTodoItem(sqlAuditBlockingTodoList, "sql_correctness_audited");
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
const codeInferredSqlEvidence = buildSqlAuditEvidence(
  "list 数据来源是分页查库，不直接来自前端缓存；Service 调用 baseMapper.getInitData 后做动态表头组装。",
  [],
  "evidence_audited=done (Service 代码确认 page=baseMapper.getInitData(page,req) 为分页查库；XML 确认 SQL 从 productinfo + OperatorBusinessConfig + Ok3w_qudao + category + ch999_user 等表联查；extracted 方法确认 searchType==1 时先查商品名匹配 ppriceid 列表再传入 SQL); execution_flow_audited=done (Controller → Service → Mapper(baseMapper.getInitData 分页查询) → XML getInitData SQL)",
);
assert.match(
  codeInferredSqlEvidence,
  /代码证据反推 Mapper\/表字段结构路径/,
  "已有 Mapper/XML/表字段来源证据时，应允许 SQL 审核按代码反推路径通过",
);
assert.equal(
  isSqlAuditEvidenceBlocking(codeInferredSqlEvidence),
  false,
  "代码反推结构路径属于非阻塞 SQL 审核证据",
);

const incompleteAuditTodoList = createRuntimeTodoList();
addRuntimeAuditTodoItem(incompleteAuditTodoList, "sql_correctness_audited");
blockTodoItem(incompleteAuditTodoList, "sql_correctness_audited", "回答包含 SELECT，但没有 dev 校验结果");
const incompleteAuditMessage = buildIncompleteAuditTodoMessage(getIncompleteAuditTodoItems(incompleteAuditTodoList));
assert.match(incompleteAuditMessage, /SQL 正确性审核未完成/);
assert.match(incompleteAuditMessage, /原因：回答包含 SELECT，但没有 dev 校验结果/);
assert.match(incompleteAuditMessage, /下一步：/);
assert.match(incompleteAuditMessage, /dev 执行校验结果/);
assert.match(incompleteAuditMessage, /dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构/);

const incompleteScopeTodoList = createRuntimeTodoList();
addRuntimeAuditTodoItem(incompleteScopeTodoList, "project_scope_audited");
blockTodoItem(incompleteScopeTodoList, "project_scope_audited", "未定位到截图区域或页面字段");

const userFacingScopeFallback = buildUserFacingAuditFallbackMessage(
  "常用资产历史价显示这里的取值逻辑帮我看看",
  getIncompleteAuditTodoItems(incompleteScopeTodoList),
);
assert.doesNotMatch(userFacingScopeFallback, /审核未完成/);
assert.doesNotMatch(userFacingScopeFallback, /project_scope_audited|sql_correctness_audited|runtime_todolist_update/);
assert.match(userFacingScopeFallback, /常用资产历史价/);
assert.doesNotMatch(userFacingScopeFallback, /请补充以下任一信息后我继续查/);
assert.match(userFacingScopeFallback, /请说明你指的具体字段、按钮或区域/);

const noDeicticScopeFallback = buildUserFacingAuditFallbackMessage(
  "你用了哪些模型",
  getIncompleteAuditTodoItems(incompleteScopeTodoList),
);
assert.match(noDeicticScopeFallback, /你用了哪些模型/);
assert.match(noDeicticScopeFallback, /哪个助手、哪次会话或哪个时间范围内的模型调用记录/);
assert.doesNotMatch(noDeicticScopeFallback, /请补充以下任一信息后我继续查/);
assert.doesNotMatch(noDeicticScopeFallback, /你说的“这里”/);
assert.doesNotMatch(noDeicticScopeFallback, /具体指页面上的哪个字段或区域/);

const auditFallbackModelCalls: string[] = [];
const llmGeneratedFallback = await generateUserFacingAuditFallbackMessage({
  question: "你用了哪些模型",
  items: getIncompleteAuditTodoItems(incompleteAuditTodoList),
  model: {
    async invoke(messages) {
      auditFallbackModelCalls.push(messages.map(message => String(message.content)).join("\n\n"));
      return { content: "我需要确认你问的是哪个助手、哪次会话或哪个时间范围内的模型调用记录。" };
    },
  },
});
assert.equal(
  llmGeneratedFallback,
  "我需要确认你问的是哪个助手、哪次会话或哪个时间范围内的模型调用记录。",
  "主路径应采用 LLM 生成的补充引导，而不是程序固定模板",
);
assert.equal(auditFallbackModelCalls.length, 1, "生成用户补充引导时必须调用 LLM");
assert.match(auditFallbackModelCalls[0]!, /不使用固定模板/);
assert.match(auditFallbackModelCalls[0]!, /不要说“你说的这里”/);
assert.match(auditFallbackModelCalls[0]!, /你用了哪些模型/);
assert.match(auditFallbackModelCalls[0]!, /不要再反问这些参数是否应该有值/);
assert.match(auditFallbackModelCalls[0]!, /禁止输出“想确认几点：”/);

const failedLlmGeneratedFallback = await generateUserFacingAuditFallbackMessage({
  question: "你用了哪些模型",
  items: getIncompleteAuditTodoItems(incompleteScopeTodoList),
  model: {
    async invoke() {
      throw new Error("llm unavailable");
    },
  },
});
assert.match(failedLlmGeneratedFallback, /哪个助手、哪次会话或哪个时间范围内的模型调用记录|最小定位锚点/);
assert.doesNotMatch(failedLlmGeneratedFallback, /你说的“这里”/);

const curlScopeFallback = buildUserFacingAuditFallbackMessage(
  `curl 'https://oawcf2.ch999.cn/kcApi/doSendWuLiu' --data-raw 'wlCompany=shunfeng&expressCategory=&wlIds=42836554'
这个提交顺丰物流单，默认是标快还是特快`,
  getIncompleteAuditTodoItems(incompleteScopeTodoList),
);
assert.doesNotMatch(curlScopeFallback, /请补充以下任一信息后我继续查/);
assert.doesNotMatch(curlScopeFallback, /所在系统、项目、页面、菜单路径或接口地址/);
assert.match(curlScopeFallback, /接口路径或请求参数锚点/);
assert.match(curlScopeFallback, /继续围绕这些锚点核实代码入口、参数映射和下游调用|如果还缺少信息，只需要补最小的项目、页面或入口/);

const guardedCurlFallback = await generateUserFacingAuditFallbackMessage({
  question: `curl -k -i --raw -o 0.dat -X POST -d "sub_id=18117666&sub_check=2&TakeMobile=&mobile_basket_id=&confirmInfo=" "https://oa.dev.9ji.com/addOrder/subCheckOp"
这个接口报这个异常是什么原因：SN校验不通过，000002 不可售,未查到
【图片识别结果】
原因分析/调用链/代码位置：subCheckOp(sub_check=2) -> CheckSubKcGovSn -> payGatewayServices.SnQuery() -> orderServices.cs:6516`,
  items: getIncompleteAuditTodoItems(incompleteAuditTodoList),
  model: {
    async invoke() {
      return {
        content: `从 curl 来看，TakeMobile、mobile_basket_id、confirmInfo 三个参数都是空的，而错误信息里提到了"SN校验不通过"和"000002 不可售"。我会继续围绕 subCheckOp、CheckSubKcGovSn 和 payGatewayServices.SnQuery 这条链路核实，先确认当前缺口是在参数映射、前置校验还是 SN 返回结果。`,
      };
    },
  },
});
assert.doesNotMatch(guardedCurlFallback, /想确认几点/);
assert.doesNotMatch(guardedCurlFallback, /TakeMobile.*是否应该有值/);
assert.doesNotMatch(guardedCurlFallback, /sub_check=1/);
assert.match(guardedCurlFallback, /接口路径或请求参数锚点|继续围绕 subCheckOp/);

const finalFormatAuditTodoList = createRuntimeTodoList();
addAuditItems(finalFormatAuditTodoList, [
  "project_scope_audited",
  "sql_correctness_audited",
  "evidence_audited",
  "execution_flow_audited",
  "owner_contact_audited",
  "final_format_audited",
]);
completeTodoItem(finalFormatAuditTodoList, "project_scope_audited", "不涉及代码范围");
completeTodoItem(finalFormatAuditTodoList, "sql_correctness_audited", "不涉及 SQL");
completeTodoItem(finalFormatAuditTodoList, "evidence_audited", "已有结论证据");
completeTodoItem(finalFormatAuditTodoList, "execution_flow_audited", "不涉及接口链路");
completeTodoItem(finalFormatAuditTodoList, "owner_contact_audited", "不涉及开发推动");
const finalFormatAuditMessage = buildIncompleteAuditTodoMessage(getIncompleteAuditTodoItems(finalFormatAuditTodoList));
assert.match(finalFormatAuditMessage, /最终输出格式审核未完成/);
assert.match(finalFormatAuditMessage, /过程标签和最终结论分离/);

const ownerContactAuditTodoList = createRuntimeTodoList();
addAuditItems(ownerContactAuditTodoList, [
  "project_scope_audited",
  "sql_correctness_audited",
  "evidence_audited",
  "execution_flow_audited",
  "owner_contact_audited",
]);
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
addAuditItems(executionFlowAuditTodoList, [
  "project_scope_audited",
  "sql_correctness_audited",
  "evidence_audited",
  "execution_flow_audited",
]);
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

const recoveryAuditTodoList = createRuntimeTodoList();
addAuditItems(recoveryAuditTodoList, [
  "project_scope_audited",
  "sql_correctness_audited",
  "evidence_audited",
  "execution_flow_audited",
  "owner_contact_audited",
]);
completeTodoItem(recoveryAuditTodoList, "sql_correctness_audited", "不涉及 SQL");
completeRecoveryAuditItems(recoveryAuditTodoList, {
  question: "九机物流单详情，什么情况下显示作废按钮",
  answer: "结论：已命中 oa-pc 物流单详情页面和作废按钮判断逻辑，当前恢复总结基于已有工具证据输出。",
  repoHints: ["oa-pc"],
  toolResultCount: 3,
  reason: "工具调用达到进展守卫上限后的恢复总结",
});
assert.equal(
  getIncompleteAuditTodoItems(recoveryAuditTodoList).length,
  0,
  "恢复总结路径必须程序化补齐非 SQL 审核项，避免再次返回审核未完成",
);

const recoveryWithBlockedSqlTodoList = createRuntimeTodoList();
addRuntimeAuditTodoItem(recoveryWithBlockedSqlTodoList, "sql_correctness_audited");
blockTodoItem(
  recoveryWithBlockedSqlTodoList,
  "sql_correctness_audited",
  "涉及 SQL，回答声明 dev 校验，但缺少同一条 SQL 的真实 dev 查询工具结果",
);
completeRecoveryAuditItems(recoveryWithBlockedSqlTodoList, {
  question: "查询物流单 SQL",
  answer: "已在 dev 环境对应库执行，查询不报错。\n\n```sql\nSELECT * FROM order_info LIMIT 20;\n```",
  repoHints: ["oa-pc"],
  toolResultCount: 0,
  reason: "LangGraph 递归上限后的恢复总结",
});
assert.equal(
  recoveryWithBlockedSqlTodoList.items.find(item => item.id === "sql_correctness_audited")?.status,
  "blocked",
  "恢复总结路径不能覆盖 SQL 审核阻塞项",
);

console.log("runtime todolist 验证通过");
