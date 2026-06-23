import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { parseArgs, type ToolContextRecord } from "./tool-context-filter.js";

export type RuntimeTodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface RuntimeTodoItem {
  id: string;
  task: string;
  status: RuntimeTodoStatus;
  evidence?: string;
}

export interface RuntimeTodoList {
  items: RuntimeTodoItem[];
}

const DEFAULT_RUNTIME_TODO_ITEMS: Array<Pick<RuntimeTodoItem, "id" | "task">> = [
  { id: "message_parsed", task: "解析用户消息并确定当前问题" },
  { id: "planner_checked", task: "完成问题规划或记录跳过原因" },
  { id: "tools_loaded", task: "加载 MCP 工具和项目范围" },
  { id: "analysis_finished", task: "完成业务分析节点执行" },
  { id: "project_scope_audited", task: "审核代码包、仓库、项目和用户目标范围一致性" },
  { id: "sql_correctness_audited", task: "审核 SQL 正确性、dev 校验或 dev 缺表代码反推路径" },
  { id: "evidence_audited", task: "审核结论证据完整性、字段语义和查询收敛" },
  { id: "execution_flow_audited", task: "审核接口链路、缺失日志和下游触达条件的执行链完整性" },
  { id: "owner_contact_audited", task: "审核建议处理是否需要联系相关开发人员" },
  { id: "final_format_audited", task: "审核过程标签和最终结论分离" },
  { id: "final_checked", task: "确认最终回答不是阶段性进度" },
];

const PROGRESS_ONLY_PATTERN = /(?:继续核实中|继续读取|继续确认|准备输出结论)[。.!！\s]*$/u;
const SQL_INTENT_PATTERN = /(?:查询|输出|生成|执行|校验|验证|检查|写|给|补充).{0,12}SQL|SQL.{0,12}(?:查询|语句|执行|校验|验证|正确性|只读)|生产\s*SQL|prod_sql_required/iu;
const DEV_SQL_VALIDATION_CLAIM_PATTERN = /dev\s*(环境|库).*(验证|校验)|已验证\s*dev|查询不报错/u;
const SQL_NOT_APPLICABLE_CLAIM_PATTERN = /不涉及\s*SQL|没有输出.{0,8}SQL|未输出.{0,8}SQL|不需要.{0,8}SQL|无需.{0,8}SQL|不用.{0,8}SQL|不(?:给|写|补充|输出).{0,8}SQL|暂时不(?:给|写|补充|输出).{0,8}SQL/iu;
const DEV_SQL_VALIDATION_TOOL_PATTERN = /(?:^|[_-])(?:read_query|export_query)$/iu;
const SQL_QUERY_PATTERN = /\b(select|show|explain)\b/iu;
const SQL_STATEMENT_LIKENESS_PATTERN = /\bselect\b[\s\S]{0,500}\bfrom\b|\bshow\b[\s\S]{0,120}\b(?:tables|columns|databases|create|index|indexes|variables|status)\b|\bexplain\b[\s\S]{0,500}\bselect\b/iu;
const SQL_VALIDATION_FAILURE_PATTERN = /sqlsyntaxerror|syntax\s+error|unknown\s+(column|table)|does\s+not\s+exist|doesn't\s+exist|ER_[A-Z0-9_]+|\berror\s*[:：]|\bexception\s*[:：]|(?:错误|异常|报错)\s*[:：]|(?:表|字段|列|数据库|权限).{0,12}(?:不存在|无权限)|(?:不存在|无权限).{0,12}(?:表|字段|列|数据库|权限)/iu;
const SQL_CODE_BLOCK_PATTERN = /```sql\s*([\s\S]*?)```/giu;
const SQL_INLINE_PATTERN = /\b(?:select|show|explain)\b[\s\S]*?(?:;|$)/gimu;
const CODE_SCOPE_PATTERN = /项目|仓库|代码包|模块|接口|页面|入口|类名|方法名|controller|service|mapper|repo|package|GitNexus/iu;
const SQL_AUDIT_NOT_APPLICABLE = "不涉及 SQL，SQL 正确性审核不适用";
const SQL_AUDIT_DEV_SCHEMA_MISSING = "涉及 SQL，dev 缺表，已标记代码反推结构路径";
const SQL_AUDIT_DEV_VALIDATED = "涉及 SQL，已有真实 dev 查询工具结果支撑执行校验路径";
const SQL_AUDIT_MISSING_SAME_SQL_TOOL_RESULT = "涉及 SQL，回答声明 dev 校验，但缺少同一条 SQL 的真实 dev 查询工具结果";
const SQL_AUDIT_MISSING_TOOL_RESULT = "涉及 SQL，回答声明 dev 校验，但缺少真实 dev 查询工具结果";
const SQL_AUDIT_MISSING_VALIDATION_PATH = "涉及 SQL，需在最终回答中说明 dev 校验或 dev 缺表代码反推路径";
const DEV_SCHEMA_MISSING_MARKER = "dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构";
const SQL_AUDIT_BLOCKING_EVIDENCE = new Set([
  SQL_AUDIT_MISSING_SAME_SQL_TOOL_RESULT,
  SQL_AUDIT_MISSING_TOOL_RESULT,
  SQL_AUDIT_MISSING_VALIDATION_PATH,
]);
const AUDIT_TODO_IDS = new Set([
  "project_scope_audited",
  "sql_correctness_audited",
  "evidence_audited",
  "execution_flow_audited",
  "owner_contact_audited",
  "final_format_audited",
]);

export function createRuntimeTodoList(
  items: Array<Pick<RuntimeTodoItem, "id" | "task">> = DEFAULT_RUNTIME_TODO_ITEMS
): RuntimeTodoList {
  return {
    items: items.map(item => ({
      ...item,
      status: "pending",
    })),
  };
}

function findTodoItem(todoList: RuntimeTodoList, id: string) {
  const item = todoList.items.find(todo => todo.id === id);
  if (!item) {
    throw new Error(`Runtime TodoList item not found: ${id}`);
  }
  return item;
}

export function startTodoItem(todoList: RuntimeTodoList, id: string) {
  for (const item of todoList.items) {
    if (item.status === "in_progress" && item.id !== id) {
      item.status = "pending";
    }
  }

  const item = findTodoItem(todoList, id);
  if (item.status !== "done") {
    item.status = "in_progress";
  }
}

export function completeTodoItem(todoList: RuntimeTodoList, id: string, evidence: string) {
  if (!evidence.trim()) {
    throw new Error(`Runtime TodoList evidence is required: ${id}`);
  }

  const item = findTodoItem(todoList, id);
  item.status = "done";
  item.evidence = evidence.trim();
}

export function blockTodoItem(todoList: RuntimeTodoList, id: string, evidence: string) {
  const item = findTodoItem(todoList, id);
  item.status = "blocked";
  item.evidence = evidence.trim() || "未记录阻塞原因";
}

export function getIncompleteTodoItems(todoList: RuntimeTodoList) {
  return todoList.items.filter(item => item.status !== "done");
}

export function getIncompleteAuditTodoItems(todoList: RuntimeTodoList) {
  return todoList.items.filter(item => AUDIT_TODO_IDS.has(item.id) && item.status !== "done");
}

export function completeSkippedAuditItems(todoList: RuntimeTodoList, itemIds: string[]) {
  for (const itemId of itemIds) {
    if (itemId === "sql_correctness_audited" || !AUDIT_TODO_IDS.has(itemId)) continue;
    const item = todoList.items.find(todo => todo.id === itemId);
    if (!item || item.status === "done" || item.status === "blocked") continue;
    completeTodoItem(todoList, itemId, `flow_control: 上游明确声明跳过 ${itemId} 节点`);
  }
}

export function assertTodoListComplete(todoList: RuntimeTodoList) {
  const incomplete = getIncompleteTodoItems(todoList);
  if (incomplete.length > 0) {
    const summary = incomplete.map(item => `${item.id}:${item.status}`).join(", ");
    throw new Error(`Runtime TodoList incomplete: ${summary}`);
  }
}

export function isFinalAnswerReady(content: string) {
  const normalized = content.trim();
  return Boolean(normalized)
    && !PROGRESS_ONLY_PATTERN.test(normalized)
    && !normalized.includes("> 🔍 正在调用:");
}

export function buildProjectScopeAuditEvidence(question: string, answer: string, repoHints: string[] = []) {
  const combined = `${question}\n${answer}`;
  if (!CODE_SCOPE_PATTERN.test(combined)) {
    return "非代码范围问题，项目/代码包一致性不适用";
  }

  if (repoHints.length > 0) {
    return `已按项目范围审核，repoHints=${repoHints.join(",")}`;
  }

  return "已审核回答中的项目、仓库、入口或接口锚点，未检测到显式 repoHint";
}

function isEscapedAt(text: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

type SqlQuote = "'" | "\"" | "`";

function advanceSqlQuote(sql: string, index: number, quote: SqlQuote | null) {
  const char = sql[index]!;
  const next = index + 1 < sql.length ? sql[index + 1] : "";

  if ((char === "'" || char === "\"" || char === "`") && (char === "`" || !isEscapedAt(sql, index))) {
    if (quote === char && next === char) {
      return { quote, escapedPair: true };
    }
    return { quote: quote === char ? null : quote || char, escapedPair: false };
  }

  return { quote, escapedPair: false };
}

function stripSqlComments(sql: string) {
  let stripped = "";
  let quote: SqlQuote | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = index + 1 < sql.length ? sql[index + 1] : "";

    if (!quote && char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 1;
      stripped += " ";
      continue;
    }

    if (!quote && char === "-" && next === "-") {
      while (index + 1 < sql.length && !/[\r\n]/u.test(sql[index + 1]!)) {
        index += 1;
      }
      stripped += " ";
      continue;
    }

    if (!quote && char === "#") {
      while (index + 1 < sql.length && !/[\r\n]/u.test(sql[index + 1]!)) {
        index += 1;
      }
      stripped += " ";
      continue;
    }

    const quoteState = advanceSqlQuote(sql, index, quote);
    if (quoteState.escapedPair) {
        stripped += char + next;
        index += 1;
        continue;
    }
    quote = quoteState.quote;

    stripped += char;
  }

  return stripped;
}

function normalizeSql(sql: string) {
  return stripSqlComments(sql)
    .replace(/```sql|```/giu, "")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\s+/g, " ")
    .replace(/;+\s*$/u, "")
    .trim()
    .toLowerCase();
}

function splitSqlStatements(sql: string) {
  const statements: string[] = [];
  let current = "";
  let quote: SqlQuote | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;

    const quoteState = advanceSqlQuote(sql, index, quote);
    if (quoteState.escapedPair) {
      current += char + sql[index + 1];
      index += 1;
      continue;
    }
    quote = quoteState.quote;

    if (char === ";" && !quote) {
      statements.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    statements.push(current);
  }

  return statements;
}

function extractSqlStatements(text: string) {
  const codeBlockSql = Array.from(text.matchAll(SQL_CODE_BLOCK_PATTERN))
    .map(match => match[1] || "");
  const inlineSql = Array.from(text.matchAll(SQL_INLINE_PATTERN))
    .map(match => match[0] || "");

  return Array.from(new Set([...codeBlockSql, ...inlineSql]
    .flatMap(sql => splitSqlStatements(stripSqlComments(sql)))
    .filter(sql => SQL_STATEMENT_LIKENESS_PATTERN.test(sql))
    .map(normalizeSql)
    .filter(Boolean)));
}

function getToolQuery(record: ToolContextRecord) {
  const args = parseArgs(record.args || "");
  if (typeof args.query === "string") return args.query;
  return typeof args.sql === "string" ? args.sql : "";
}

function analyzeDevSqlValidationToolResults(toolRecords: ToolContextRecord[] = [], answerSqlStatements: string[] = []) {
  let hasDevSqlQuery = false;
  let hasSuccessfulMatchingQuery = false;

  for (const record of toolRecords) {
    if (!DEV_SQL_VALIDATION_TOOL_PATTERN.test(record.name)) continue;

    const query = getToolQuery(record);
    if (!SQL_QUERY_PATTERN.test(query)) continue;

    hasDevSqlQuery = true;
    const normalizedQuery = normalizeSql(query);
    const matchesFinalSql = answerSqlStatements.some(sql => normalizedQuery === sql);
    if (matchesFinalSql && !SQL_VALIDATION_FAILURE_PATTERN.test(record.content || "")) {
      hasSuccessfulMatchingQuery = true;
    }
  }

  return { hasDevSqlQuery, hasSuccessfulMatchingQuery };
}

export function buildSqlAuditEvidence(answer: string, toolRecords: ToolContextRecord[] = []) {
  if (answer.includes(DEV_SCHEMA_MISSING_MARKER)) {
    return SQL_AUDIT_DEV_SCHEMA_MISSING;
  }

  const answerSqlStatements = extractSqlStatements(answer);
  const hasSqlStatement = answerSqlStatements.length > 0;
  if (!hasSqlStatement && SQL_NOT_APPLICABLE_CLAIM_PATTERN.test(answer)) {
    return SQL_AUDIT_NOT_APPLICABLE;
  }

  const hasSqlAuditIntent = SQL_INTENT_PATTERN.test(answer) || DEV_SQL_VALIDATION_CLAIM_PATTERN.test(answer);

  if (!hasSqlStatement && !hasSqlAuditIntent) {
    return SQL_AUDIT_NOT_APPLICABLE;
  }

  if (DEV_SQL_VALIDATION_CLAIM_PATTERN.test(answer)) {
    // 命中 dev 校验声明但未提取到 SQL 时，必须按缺少真实工具证据处理。
    const devSqlValidation = analyzeDevSqlValidationToolResults(toolRecords, answerSqlStatements);
    if (devSqlValidation.hasSuccessfulMatchingQuery) {
      return SQL_AUDIT_DEV_VALIDATED;
    }
    if (devSqlValidation.hasDevSqlQuery) {
      return SQL_AUDIT_MISSING_SAME_SQL_TOOL_RESULT;
    }
    return SQL_AUDIT_MISSING_TOOL_RESULT;
  }

  return SQL_AUDIT_MISSING_VALIDATION_PATH;
}

export function isSqlAuditEvidenceBlocking(evidence: string) {
  return SQL_AUDIT_BLOCKING_EVIDENCE.has(evidence);
}

export function applySqlAuditEvidence(todoList: RuntimeTodoList, evidence: string) {
  if (isSqlAuditEvidenceBlocking(evidence)) {
    blockTodoItem(todoList, "sql_correctness_audited", evidence);
  } else {
    completeTodoItem(todoList, "sql_correctness_audited", evidence);
  }
}

export function buildEvidenceAuditEvidence(answer: string, toolResultCount = 0) {
  if (!answer.trim()) {
    return "回答为空，证据审核未通过";
  }

  return `已审核结论证据和查询收敛，toolResults=${toolResultCount}`;
}

function completeAuditItemIfOpen(todoList: RuntimeTodoList, id: string, evidence: string) {
  const item = todoList.items.find(todo => todo.id === id);
  if (!item || item.status === "done" || item.status === "blocked") return;
  completeTodoItem(todoList, id, evidence);
}

export function completeRecoveryAuditItems(todoList: RuntimeTodoList, input: {
  question: string;
  answer: string;
  repoHints?: string[];
  toolResultCount?: number;
  reason: string;
}) {
  const reason = input.reason.trim() || "恢复总结路径";
  completeAuditItemIfOpen(
    todoList,
    "project_scope_audited",
    `${reason}；${buildProjectScopeAuditEvidence(input.question, input.answer, input.repoHints || [])}`,
  );
  completeAuditItemIfOpen(
    todoList,
    "evidence_audited",
    `${reason}；${buildEvidenceAuditEvidence(input.answer, input.toolResultCount || 0)}`,
  );
  completeAuditItemIfOpen(
    todoList,
    "execution_flow_audited",
    `${reason}；恢复回答已基于现有工具证据输出阶段性结论或最小缺口；未继续执行无进展工具循环`,
  );
  completeAuditItemIfOpen(
    todoList,
    "owner_contact_audited",
    `${reason}；未执行 git_author_trace，恢复回答如涉及代码缺陷或配置异常应提示联系对应模块开发人员`,
  );
  completeAuditItemIfOpen(
    todoList,
    "final_format_audited",
    `${reason}；发送前会执行进度折叠和 flow_control 剥离，仅保留最终可见内容`,
  );
}

export function summarizeTodoList(todoList: RuntimeTodoList) {
  return todoList.items
    .map(item => {
      const evidence = item.evidence ? ` (${item.evidence})` : "";
      return `${item.id}=${item.status}${evidence}`;
    })
    .join("; ");
}

function getAuditTodoFailureGuide(item: RuntimeTodoItem) {
  const baseReason = item.status === "blocked"
    ? item.evidence || "模型主动标记该审核项阻塞，但未说明原因"
    : `模型未调用 runtime_todolist_update 将 ${item.id} 标记为 done`;

  if (item.id === "project_scope_audited") {
    return {
      title: "代码包/项目范围一致性审核未完成",
      reason: baseReason,
      next: "需要明确目标 repo、代码包、模块、接口、页面或入口，并说明命中的代码证据与用户指定范围一致；如果不涉及代码范围，也要通过工具标记“不适用”及原因。",
    };
  }

  if (item.id === "sql_correctness_audited") {
    return {
      title: "SQL 正确性审核未完成",
      reason: baseReason,
      next: "如果问题涉及 SQL，需要补充完整只读 SQL 的 dev 执行校验结果；如果 dev 库没有对应表，需要通过目标项目代码反推表名、字段、Mapper/SQL、实体映射或调用链，并明确标记“dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构”。如果不涉及 SQL，也要通过工具标记“不涉及 SQL”。",
    };
  }

  if (item.id === "evidence_audited") {
    return {
      title: "结论证据完整性审核未完成",
      reason: baseReason,
      next: "需要说明核心结论由哪些用户输入、工具结果、代码片段、数据库结果或业务规则支撑，并确认字段语义和查询已经收敛；证据不足时应触发 Human Loop 或说明最小缺口。",
    };
  }

  if (item.id === "execution_flow_audited") {
    return {
      title: "执行链完整性审核未完成",
      reason: baseReason,
      next: "涉及接口链路、缺失日志、未触达下游、下游触达条件、回调、MQ、外部系统推送或状态流转时，需要沿真实执行路径核对入口、分发、前置查询、状态映射、顺序分支门槛、下游发送条件和异常捕获；如果更靠前的短路条件已由代码和已知入参同时满足，应优先落在前置短路点，后续未执行到的租户规模、域名配置、MQ 等条件不得反过来作为主因；需要生产数据确认的门槛必须输出取数验证方式，等待用户验证后再继续下一层。不涉及此类问题时，也要标记不适用及原因。",
    };
  }

  if (item.id === "owner_contact_audited") {
    return {
      title: "开发人员联系建议审核未完成",
      reason: baseReason,
      next: "涉及代码缺陷、配置异常、流程实现、历史逻辑归属或需要推动修复时，需要在建议处理中提示联系相关开发人员；如果当前工具列表存在 git_author_trace，只能基于最终结论实际引用的仓库、文件、方法、代码片段、symbol uid 或接口入口追溯联系人，不得使用最终未引用的候选文件；多个线索命中时，按“与最终结论最相关的修改优先、同等相关时最新修改优先”选择开发人员。若不涉及代码或无需推动开发处理，也要标记不适用及原因。",
    };
  }

  if (item.id === "final_format_audited") {
    return {
      title: "最终输出格式审核未完成",
      reason: baseReason,
      next: "需要完成过程标签和最终结论分离审核：确认阶段性过程已使用 agent_progress 标签承载，最终结论已使用 final_answer 标签承载，且发送给用户前会去除过程标签和过程内容，只保留最终结论。",
    };
  }

  return {
    title: `${item.task}未完成`,
    reason: baseReason,
    next: "需要补充该审核项的完成证据，或通过工具标记 blocked 并说明阻塞原因。",
  };
}

export function buildIncompleteAuditTodoMessage(items: RuntimeTodoItem[]) {
  const details = items.map((item, index) => {
    const guide = getAuditTodoFailureGuide(item);
    return `${index + 1}. ${guide.title}\n原因：${guide.reason}\n下一步：${guide.next}`;
  }).join("\n\n");

  return `审核未完成，当前回答暂不发送最终结论。\n\n${details}`;
}

function hasAuditItem(items: RuntimeTodoItem[], id: string) {
  return items.some(item => item.id === id);
}

export function buildUserFacingAuditFallbackMessage(question: string, items: RuntimeTodoItem[]) {
  const normalizedQuestion = question.trim();
  const prefix = normalizedQuestion
    ? `针对“${normalizedQuestion}”，当前还没有足够证据直接下结论。`
    : "当前还没有足够证据直接下结论。";

  if (hasAuditItem(items, "project_scope_audited") || hasAuditItem(items, "evidence_audited")) {
    return `${prefix}\n\n请补充以下任一信息后我继续查：\n1. 所在系统、项目、页面、菜单路径或接口地址。\n2. 截图中的完整文字、URL、字段名或按钮/表格列名。\n3. 你说的“这里”具体指页面上的哪个字段或区域。`;
  }

  if (hasAuditItem(items, "sql_correctness_audited")) {
    return `${prefix}\n\n当前涉及 SQL 或数据核实时，还缺少 dev 校验结果或表结构证据。请补充目标系统/页面/字段，或确认是否需要我继续按代码反推表名和字段。`;
  }

  return `${prefix}\n\n请补充系统、项目、页面、接口或截图文字，我会基于补充信息继续核实。`;
}

export function buildRuntimeTodoTool(todoList: RuntimeTodoList) {
  return tool(
    async ({ itemId, status, evidence }) => {
      if (status === "done") {
        completeTodoItem(todoList, itemId, evidence);
      } else if (status === "blocked") {
        blockTodoItem(todoList, itemId, evidence);
      } else {
        startTodoItem(todoList, itemId);
      }

      return summarizeTodoList(todoList);
    },
    {
      name: "runtime_todolist_update",
      description: [
        "更新当前回答的运行时 TodoList。",
        "模型必须在最终回答前调用本工具完成审核步骤。",
        "可用 itemId：project_scope_audited（代码包/仓库/项目范围一致性审核）、",
        "sql_correctness_audited（SQL 正确性、dev 校验或 dev 缺表代码反推审核）、",
        "evidence_audited（结论证据完整性、字段语义和查询收敛审核）、",
        "execution_flow_audited（接口链路、缺失日志、下游触达条件、回调、MQ、外部系统推送和状态流转的执行链完整性审核）、",
        "owner_contact_audited（建议处理中的开发人员联系建议审核；git_author_trace 只能基于最终结论实际引用证据追溯联系人，并按相关性优先、最新修改次之选择开发人员）、",
        "final_format_audited（过程标签和最终结论分离审核）。",
        "每次标记 done 必须提供 evidence；没有证据时标记 blocked。",
      ].join(""),
      schema: z.object({
        itemId: z.enum(["project_scope_audited", "sql_correctness_audited", "evidence_audited", "execution_flow_audited", "owner_contact_audited", "final_format_audited"]),
        status: z.enum(["in_progress", "done", "blocked"]),
        evidence: z.string().describe("完成或阻塞该审核项的具体证据；done 时不能为空。"),
      }),
    }
  );
}
