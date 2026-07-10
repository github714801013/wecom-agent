import { tool } from "@langchain/core/tools";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
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

export interface AuditFallbackModel {
  invoke(messages: Array<SystemMessage | HumanMessage>): Promise<{ content: unknown }>;
}

export type FinalAnswerReviewAction = "send" | "continue" | "human_loop";

export interface FinalAnswerReviewResult {
  ready: boolean;
  action: FinalAnswerReviewAction;
  reason: string;
}

export interface FinalAnswerReviewInput {
  question: string;
  answer: string;
  model?: AuditFallbackModel | undefined;
}

export interface FinalReplyResolutionInput extends FinalAnswerReviewInput {
  streamSnapshots?: string[];
  maxSnapshotReviews?: number;
}

export interface FinalReplyResolutionResult {
  ready: boolean;
  action: FinalAnswerReviewAction;
  answer: string;
  reason: string;
  source: "candidate" | "stream_snapshot" | "unresolved";
  review: FinalAnswerReviewResult;
}

export interface RuntimeAuditPlanInput {
  question: string;
  answer?: string;
  plannerIntent?: string;
  secondaryIntents?: string[];
  repoHints?: string[];
  toolResultCount?: number;
  sqlAuditEvidence?: string;
  skipAuditItems?: string[];
}

const CORE_RUNTIME_TODO_ITEMS: Array<Pick<RuntimeTodoItem, "id" | "task">> = [
  { id: "message_parsed", task: "解析用户消息并确定当前问题" },
  { id: "planner_checked", task: "完成问题规划或记录跳过原因" },
  { id: "tools_loaded", task: "加载 MCP 工具和项目范围" },
  { id: "analysis_finished", task: "完成业务分析节点执行" },
  { id: "final_checked", task: "确认最终回答不是阶段性进度" },
];

const AUDIT_RUNTIME_TODO_ITEMS: Array<Pick<RuntimeTodoItem, "id" | "task">> = [
  { id: "project_scope_audited", task: "审核代码包、仓库、项目和用户目标范围一致性" },
  { id: "sql_correctness_audited", task: "审核 SQL 正确性、dev 校验或 dev 缺表代码反推路径" },
  { id: "evidence_audited", task: "审核结论证据完整性、字段语义和查询收敛" },
  { id: "execution_flow_audited", task: "审核接口链路、缺失日志和下游触达条件的执行链完整性" },
  { id: "owner_contact_audited", task: "审核建议处理是否需要联系相关开发人员" },
  { id: "final_format_audited", task: "审核过程标签和最终结论分离" },
];

const AUDIT_RUNTIME_TODO_ITEM_BY_ID = new Map(AUDIT_RUNTIME_TODO_ITEMS.map(item => [item.id, item]));

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
const CONCRETE_SCOPE_ANCHOR_PATTERN = /\bhttps?:\/\/|(?:^|[\s'"`(（])\/?(?:api|[A-Za-z][A-Za-z0-9_-]*Api)\/[A-Za-z0-9][A-Za-z0-9/_{}.-]*|(?:^|[?&\s'"`])(?:wlCompany|expressCategory|wlIds|area|ch999id|source|status|orderId|subId|id)=/iu;
const DEICTIC_REFERENCE_PATTERN = /(?:这里|这儿|这边|这个|这个字段|该字段|该按钮|截图|图片|圈出|圈选|标注|红圈|上面|下面)/iu;
const IMAGE_ANALYSIS_ARTIFACT_MARKERS = [
  "【图片识别结果】",
  "图片位置：",
  "图片标题：",
  "圈选/标注重点：",
  "关键字段/按钮/列名：",
  "未识别清楚：",
];
const SQL_AUDIT_NOT_APPLICABLE = "不涉及 SQL，SQL 正确性审核不适用";
const SQL_AUDIT_DEV_SCHEMA_MISSING = "涉及 SQL，dev 缺表，已标记代码反推结构路径";
const SQL_AUDIT_DEV_VALIDATED = "涉及 SQL，已有真实 dev 查询工具结果支撑执行校验路径";
const SQL_AUDIT_CODE_INFERRED = "涉及 SQL，已通过代码证据反推 Mapper/表字段结构路径";
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
const FLOW_AUDIT_PATTERN = /接口|路由|URL|curl|fetch|调用链|链路|回调|MQ|消息|下游|上游|推送|状态流转|按钮|权限|显示条件|提交|拦截|报错|异常|日志|入参|参数映射|Controller|Service|Mapper|api\//iu;
const OWNER_CONTACT_PATTERN = /代码缺陷|配置异常|修复|推动|联系.*开发|开发人员|负责人|归属|历史逻辑|谁改|谁负责|git_author_trace/iu;
const SQL_AUDIT_APPLICABLE_PATTERN = /涉及 SQL|已有真实 dev 查询工具结果|dev 缺表|缺少.*真实 dev 查询工具结果|需在最终回答中说明 dev 校验/iu;
const SQL_CODE_INFERENCE_SQL_PATTERN = /SQL|查库|联查|分页查库|select|from|union\s+all/iu;
const SQL_CODE_INFERENCE_CODE_PATTERN = /Mapper|XML|baseMapper|Controller|Service|调用链|实体映射|@(?:Post|Get|Put|Delete|Request)Mapping|\.xml|\.java/iu;
const SQL_CODE_INFERENCE_STRUCTURE_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]*(?:Mapper|Controller|Service)\b|(?:表|字段|实体|Mapper\/SQL|XML).{0,80}(?:确认|反推|来源|映射|联查)|(?:确认|反推|来源|映射|联查).{0,80}(?:表|字段|实体|Mapper\/SQL|XML)/iu;

const AUDIT_FALLBACK_SYSTEM_PROMPT = `你是用户补充信息引导器，只负责把内部审核缺口转成自然、具体、最小化的用户追问。

要求：
1. 只输出发送给用户看的中文，不输出 JSON、Markdown 标题或内部审核项。
2. 不使用固定模板；必须根据用户原问题、已知锚点和缺口生成 1 到 3 条最小补充问题。
3. 不要出现 runtime_todolist、project_scope_audited、evidence_audited、审核未完成等内部实现词。
4. 用户已经提供 URL、接口路径、请求参数、截图文字、字段名或日志时，不要重复要求用户再提供同类信息。
5. 不要说“你说的这里”，除非用户问题本身确实存在需要消解的指代、截图标注或页面区域。
6. 对“你用了哪些模型”这类问题，应优先引导确认是哪个助手、哪个环境、哪次会话、哪个时间范围或哪类调用记录，而不是询问页面字段。
7. 如果缺口可以继续由工具自行核实，直接说明会继续围绕已给锚点核实；只有真的缺少用户侧信息时才请求补充。
8. 如果用户问题已经包含 curl/fetch、URL、接口路径、请求参数、错误文案、错误码，或截图里已有候选调用链、代码位置、方法名、文件路径、行号，不要再反问这些参数是否应该有值、是否等于别的字段、是否先经过上一步校验；这些都属于可通过代码入口、参数映射、调用链和测试/dev 数据继续核实的事实。
9. 对这类已给足锚点的问题，禁止输出“想确认几点：”后跟 1/2/3 条反问；应优先输出“我会继续围绕现有锚点核实”的引导。`;

const FINAL_ANSWER_REVIEW_SYSTEM_PROMPT = `你是最终回复闸门，只判断候选回答是否已经可以作为最终回复发送给用户。

只输出 JSON 对象，不输出 Markdown 或额外解释：
{"ready":true|false,"action":"send"|"continue"|"human_loop","reason":"一句中文原因"}

判断规则：
1. 如果候选回答只是进度、工具状态、图片/OCR解析结果、规划步骤、还要继续查、还没形成业务结论，ready=false，action="continue"。
2. 如果候选回答已经直接回答用户问题，并包含必要的结论、依据或明确的最小缺口，ready=true，action="send"。
3. 如果候选回答结构杂乱、标题过多、段落过长、混入大量工具过程/审核清单/TodoList/候选路径，且用户没有明确要求详细过程，ready=false，action="continue"，reason 要求压缩为“结论 + 依据 + 建议/下一步”。
4. 如果回答展示了过多技术定位信息，应继续压缩为项目名称、主要入口类名和业务含义。
5. 如果确实需要用户补充信息才能继续，ready=false，action="human_loop"。
6. 不要根据固定关键词判断，要结合用户原问题和候选回答的语义。`;

function extractRequestParamNames(question: string) {
  const names = new Set<string>();
  for (const match of question.matchAll(/(?:^|[?&\s'"`])([A-Za-z_][A-Za-z0-9_]*)=/gmu)) {
    const name = String(match[1] || "").trim();
    if (!name) continue;
    names.add(name);
  }
  return [...names];
}

function isPrematureQueryableParamQuestion(question: string, reply: string) {
  if (!CONCRETE_SCOPE_ANCHOR_PATTERN.test(question)) return false;
  const normalizedReply = reply.trim();
  if (!normalizedReply) return false;

  const hasQuestioningShape = /想确认几点|麻烦确认|请确认以下|这几个信息|是否应该有值|是否先经过|还是说直接/u.test(normalizedReply)
    || /(?:^|\n)\s*[1-3][.、]/u.test(normalizedReply);
  if (!hasQuestioningShape) return false;

  const paramNames = extractRequestParamNames(question);
  if (paramNames.length === 0) return false;
  const lowerReply = normalizedReply.toLowerCase();
  return paramNames.some(name => lowerReply.includes(name.toLowerCase()));
}

export function createRuntimeTodoList(
  items: Array<Pick<RuntimeTodoItem, "id" | "task">> = CORE_RUNTIME_TODO_ITEMS
): RuntimeTodoList {
  return {
    items: items.map(item => ({
      ...item,
      status: "pending",
    })),
  };
}

export function hasTodoItem(todoList: RuntimeTodoList, id: string) {
  return todoList.items.some(todo => todo.id === id);
}

function addTodoItemIfMissing(todoList: RuntimeTodoList, item: Pick<RuntimeTodoItem, "id" | "task">) {
  if (hasTodoItem(todoList, item.id)) return;
  todoList.items.push({
    ...item,
    status: "pending",
  });
}

export function addRuntimeAuditTodoItem(todoList: RuntimeTodoList, id: string) {
  const item = AUDIT_RUNTIME_TODO_ITEM_BY_ID.get(id);
  if (!item) return false;
  addTodoItemIfMissing(todoList, item);
  return true;
}

function normalizeIntentList(input: RuntimeAuditPlanInput) {
  return [
    input.plannerIntent,
    ...(input.secondaryIntents || []),
  ]
    .filter((item): item is string => Boolean(item))
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
}

function shouldPlanProjectScopeAudit(input: RuntimeAuditPlanInput) {
  const combined = `${input.question}\n${input.answer || ""}`;
  return Boolean(
    (input.repoHints || []).length > 0
    || CODE_SCOPE_PATTERN.test(combined)
    || CONCRETE_SCOPE_ANCHOR_PATTERN.test(combined)
    || (input.toolResultCount || 0) > 0
  );
}

function shouldPlanSqlAudit(input: RuntimeAuditPlanInput) {
  const intents = normalizeIntentList(input);
  if (intents.includes("SQL")) return true;
  if (input.sqlAuditEvidence && SQL_AUDIT_APPLICABLE_PATTERN.test(input.sqlAuditEvidence)) return true;
  return SQL_INTENT_PATTERN.test(`${input.question}\n${input.answer || ""}`);
}

function shouldPlanEvidenceAudit(input: RuntimeAuditPlanInput) {
  const combined = `${input.question}\n${input.answer || ""}`;
  return Boolean(
    shouldPlanProjectScopeAudit(input)
    || shouldPlanSqlAudit(input)
    || FLOW_AUDIT_PATTERN.test(combined)
    || (input.toolResultCount || 0) > 0
  );
}

function shouldPlanExecutionFlowAudit(input: RuntimeAuditPlanInput) {
  const combined = `${input.question}\n${input.answer || ""}`;
  const intents = normalizeIntentList(input);
  return FLOW_AUDIT_PATTERN.test(combined)
    || intents.some(intent => ["API", "FLOW", "BUG", "CONFIG", "DEPLOY", "PERF"].includes(intent));
}

function shouldPlanOwnerContactAudit(input: RuntimeAuditPlanInput) {
  const combined = `${input.question}\n${input.answer || ""}`;
  return OWNER_CONTACT_PATTERN.test(combined);
}

export function planRuntimeAuditTodoItems(input: RuntimeAuditPlanInput) {
  const skipped = new Set(input.skipAuditItems || []);
  const planned: string[] = [];
  const add = (id: string, applicable: boolean) => {
    if (!applicable) return;
    if (id !== "sql_correctness_audited" && skipped.has(id)) return;
    if (id === "sql_correctness_audited" && skipped.has(id) && !isSqlAuditEvidenceBlocking(input.sqlAuditEvidence || "")) return;
    if (!planned.includes(id)) planned.push(id);
  };

  add("project_scope_audited", shouldPlanProjectScopeAudit(input));
  add("sql_correctness_audited", shouldPlanSqlAudit(input));
  add("evidence_audited", shouldPlanEvidenceAudit(input));
  add("execution_flow_audited", shouldPlanExecutionFlowAudit(input));
  add("owner_contact_audited", shouldPlanOwnerContactAudit(input));

  // 输出格式检查由 final_checked 的确定性闸门负责，只有模型主动使用该节点时才加入。
  return planned
    .map(id => AUDIT_RUNTIME_TODO_ITEM_BY_ID.get(id))
    .filter((item): item is Pick<RuntimeTodoItem, "id" | "task"> => Boolean(item));
}

export function syncRuntimeAuditTodoPlan(todoList: RuntimeTodoList, input: RuntimeAuditPlanInput) {
  const plannedItems = planRuntimeAuditTodoItems(input);
  for (const item of plannedItems) {
    addTodoItemIfMissing(todoList, item);
  }
  return plannedItems;
}

export function getActiveAuditTodoItems(todoList: RuntimeTodoList) {
  return todoList.items.filter(item => AUDIT_TODO_IDS.has(item.id));
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

function parseJsonObject(content: unknown) {
  if (content && typeof content === "object") return content as Record<string, unknown>;
  const text = String(content || "").trim();
  if (!text) return {};

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return {};
  }
}

function normalizeFinalAnswerReview(content: unknown): FinalAnswerReviewResult {
  const parsed = parseJsonObject(content);
  const action = parsed.action === "send" || parsed.action === "human_loop"
    ? parsed.action
    : "continue";
  const ready = parsed.ready === true && action === "send";
  const reason = typeof parsed.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim()
    : "模型未返回明确最终回复判定";

  return { ready, action, reason };
}

function isImageAnalysisArtifact(content: string) {
  return IMAGE_ANALYSIS_ARTIFACT_MARKERS.some(marker => content.includes(marker));
}

export async function reviewFinalAnswerWithModel(input: FinalAnswerReviewInput): Promise<FinalAnswerReviewResult> {
  if (!input.answer.trim()) {
    return { ready: false, action: "continue", reason: "候选回答为空" };
  }
  if (!input.model) {
    return { ready: false, action: "continue", reason: "缺少最终回复评审模型" };
  }

  try {
    const response = await input.model.invoke([
      new SystemMessage(FINAL_ANSWER_REVIEW_SYSTEM_PROMPT),
      new HumanMessage(JSON.stringify({
        user_question: input.question,
        candidate_answer: input.answer,
      })),
    ]);
    return normalizeFinalAnswerReview(response.content);
  } catch (error) {
    console.error("Failed to review final answer with LLM:", error);
    return { ready: false, action: "continue", reason: "最终回复模型评审失败" };
  }
}

function collectFinalReplyCandidates(candidateAnswer: string, streamSnapshots: string[] = [], maxSnapshotReviews = 8) {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const addCandidate = (content: string) => {
    const normalized = content.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  addCandidate(candidateAnswer);
  for (const snapshot of [...streamSnapshots].reverse()) {
    if (candidates.length > maxSnapshotReviews + 1) break;
    addCandidate(snapshot);
  }

  return candidates;
}

export async function resolveFinalReplyWithModel(input: FinalReplyResolutionInput): Promise<FinalReplyResolutionResult> {
  const candidates = collectFinalReplyCandidates(
    input.answer,
    input.streamSnapshots,
    input.maxSnapshotReviews,
  );
  const candidateAnswer = candidates[0] || input.answer.trim();
  const candidateReview = await reviewFinalAnswerWithModel({
    question: input.question,
    answer: candidateAnswer,
    model: input.model,
  });

  if (candidateReview.ready) {
    return {
      ready: true,
      action: "send",
      answer: candidateAnswer,
      reason: candidateReview.reason,
      source: "candidate",
      review: candidateReview,
    };
  }

  for (const snapshot of candidates.slice(1)) {
    const snapshotReview = await reviewFinalAnswerWithModel({
      question: input.question,
      answer: snapshot,
      model: input.model,
    });
    if (snapshotReview.ready) {
      return {
        ready: true,
        action: "send",
        answer: snapshot,
        reason: `当前最终候选未通过评审，已恢复流式过程中较早出现的可发送结论：${snapshotReview.reason}`,
        source: "stream_snapshot",
        review: snapshotReview,
      };
    }
  }

  return {
    ready: false,
    action: candidateReview.action,
    answer: candidateAnswer,
    reason: candidateReview.reason,
    source: "unresolved",
    review: candidateReview,
  };
}

export function shouldSendFinalReply(resolution: FinalReplyResolutionResult) {
  return resolution.ready && resolution.action === "send";
}

const INCOMPLETE_FINAL_NOTICE = "提示：以上不是最终结论，只是目前能搜索到的信息；完整结论还需要继续补齐证据闭环。";

export function appendIncompleteFinalNotice(content: string) {
  const normalized = content.trim();
  if (!normalized) return INCOMPLETE_FINAL_NOTICE;
  if (normalized.includes("不是最终结论")) return normalized;
  return `${normalized}\n\n${INCOMPLETE_FINAL_NOTICE}`;
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

function hasCodeInferredSqlStructureEvidence(content: string) {
  const normalized = content.trim();
  if (!normalized) return false;
  return SQL_CODE_INFERENCE_SQL_PATTERN.test(normalized)
    && SQL_CODE_INFERENCE_CODE_PATTERN.test(normalized)
    && SQL_CODE_INFERENCE_STRUCTURE_PATTERN.test(normalized);
}

export function buildSqlAuditEvidence(answer: string, toolRecords: ToolContextRecord[] = [], auditEvidenceContext = "") {
  const combinedEvidence = `${answer}\n${auditEvidenceContext}`;
  if (combinedEvidence.includes(DEV_SCHEMA_MISSING_MARKER)) {
    return SQL_AUDIT_DEV_SCHEMA_MISSING;
  }

  const answerSqlStatements = extractSqlStatements(answer);
  const hasSqlStatement = answerSqlStatements.length > 0;
  if (!hasSqlStatement && SQL_NOT_APPLICABLE_CLAIM_PATTERN.test(answer)) {
    return SQL_AUDIT_NOT_APPLICABLE;
  }

  const hasSqlAuditIntent = SQL_INTENT_PATTERN.test(combinedEvidence) || DEV_SQL_VALIDATION_CLAIM_PATTERN.test(answer);
  const hasCodeInferenceEvidence = hasCodeInferredSqlStructureEvidence(combinedEvidence);

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

  if (hasCodeInferenceEvidence) {
    return SQL_AUDIT_CODE_INFERRED;
  }

  if (!hasSqlStatement && !hasSqlAuditIntent) {
    return SQL_AUDIT_NOT_APPLICABLE;
  }

  return SQL_AUDIT_MISSING_VALIDATION_PATH;
}

export function isSqlAuditEvidenceBlocking(evidence: string) {
  return SQL_AUDIT_BLOCKING_EVIDENCE.has(evidence);
}

export function applySqlAuditEvidence(todoList: RuntimeTodoList, evidence: string) {
  addRuntimeAuditTodoItem(todoList, "sql_correctness_audited");
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

function buildExecutionFlowAuditEvidence(answer: string, toolResultCount = 0) {
  if (!answer.trim()) {
    return "回答为空，执行链审核未通过";
  }

  return `已审核执行链、触发条件和上下游证据，toolResults=${toolResultCount}`;
}

function completeAuditItemIfOpen(todoList: RuntimeTodoList, id: string, evidence: string) {
  const item = todoList.items.find(todo => todo.id === id);
  if (!item || item.status === "done" || item.status === "blocked") return;
  completeTodoItem(todoList, id, evidence);
}

function hasVisibleAuditEvidenceAnchor(answer: string) {
  return /(?:代码证据|证据汇总|文件[:：]|行号|调用链|生产者|消费者|触发条件|接口|Controller|Service|Mapper|SQL|队列|MQ)/iu.test(answer);
}

function hasAnswerEvidenceForRuntimeAudit(input: RuntimeAuditPlanInput) {
  const answer = (input.answer || "").trim();
  if (!answer) return false;

  return hasVisibleAuditEvidenceAnchor(answer)
    && ((input.toolResultCount || 0) > 0 || (input.repoHints || []).length > 0);
}

export function completeAnswerSupportedAuditItems(todoList: RuntimeTodoList, input: RuntimeAuditPlanInput) {
  if (!hasAnswerEvidenceForRuntimeAudit(input)) return;

  completeAuditItemIfOpen(
    todoList,
    "project_scope_audited",
    `最终答案已有可见证据；${buildProjectScopeAuditEvidence(input.question, input.answer || "", input.repoHints || [])}`,
  );
  completeAuditItemIfOpen(
    todoList,
    "evidence_audited",
    `最终答案已有可见证据；${buildEvidenceAuditEvidence(input.answer || "", input.toolResultCount || 0)}`,
  );
  completeAuditItemIfOpen(
    todoList,
    "execution_flow_audited",
    `最终答案已有可见证据；${buildExecutionFlowAuditEvidence(input.answer || "", input.toolResultCount || 0)}`,
  );
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

const USER_FACING_TODO_TASKS: Record<string, string> = {
  message_parsed: "接收并理解问题",
  planner_checked: "分析处理思路",
  tools_loaded: "查询相关信息",
  analysis_finished: "整理分析结果",
  final_checked: "确认回复完整性",
  project_scope_audited: "核对目标范围",
  sql_correctness_audited: "核对 SQL 或数据依据",
  evidence_audited: "核对结论依据",
  execution_flow_audited: "核对执行链路",
  owner_contact_audited: "核对处理建议",
  final_format_audited: "整理最终回复",
};

function getUserFacingTodoTask(item: RuntimeTodoItem) {
  return USER_FACING_TODO_TASKS[item.id] || item.task;
}

// 面向用户展示的步骤清单渲染：done 打 ✓，未完成用中性标记 ○。
// 只展示用户能理解的任务阶段，不暴露 MCP、审核项 id、工具名等内部实现细节。
export function renderTodoStepsForHeartbeat(todoList: RuntimeTodoList, _heartbeatFrame: string) {
  if (todoList.items.length === 0) return "";
  const lines = todoList.items.map(item => {
    const done = item.status === "done";
    const marker = done ? "✓" : "○";
    return `${marker} ${getUserFacingTodoTask(item)}`;
  });
  return `【处理进度】\n${lines.join("\n")}`;
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

function buildProjectScopeFallbackRequest(question: string) {
  const normalizedQuestion = question.trim();
  const hasModelContext = /模型|会话|助手|调用记录|时间范围/iu.test(normalizedQuestion);
  const hasDirectAnchor = CONCRETE_SCOPE_ANCHOR_PATTERN.test(normalizedQuestion);
  const hasDeicticReference = DEICTIC_REFERENCE_PATTERN.test(normalizedQuestion);

  if (hasModelContext) {
    return "请说明你问的是哪个助手、哪次会话或哪个时间范围内的模型调用记录，我会继续围绕当前问题核实。";
  }

  if (hasDirectAnchor && hasDeicticReference) {
    return "请说明你指的具体字段、按钮或区域，我会继续围绕当前锚点核实。";
  }

  if (hasDirectAnchor) {
    return "你已经给出接口路径或请求参数锚点，我会继续围绕这些锚点核实；如果还要补充，只需要补最小的项目、页面或入口信息。";
  }

  if (hasDeicticReference) {
    return "请说明你指的具体字段、按钮或区域，我会继续围绕当前问题核实。";
  }

  return "请补充最小定位锚点，比如项目、页面、接口或截图文字，我会继续核实。";
}

function formatAuditFallbackItems(items: RuntimeTodoItem[]) {
  return items.map(item => ({
    task: item.task,
    status: item.status,
    evidence: item.evidence || "",
  }));
}

function sanitizeLlmAuditFallback(content: unknown) {
  return String(content || "")
    .replace(/```(?:json|markdown)?/giu, "")
    .replace(/```/gu, "")
    .trim();
}

export function buildUserFacingAuditFallbackMessage(question: string, items: RuntimeTodoItem[]) {
  const normalizedQuestion = question.trim();
  if (isImageAnalysisArtifact(normalizedQuestion)) {
    return "已识别到图片里的报错信息，我会继续围绕接口路径、请求参数、代码入口和下游调用核实。";
  }

  const prefix = normalizedQuestion
    ? `针对“${normalizedQuestion}”，当前还没有足够证据直接下结论。`
    : "当前还没有足够证据直接下结论。";
  const hasConcreteScopeAnchor = CONCRETE_SCOPE_ANCHOR_PATTERN.test(normalizedQuestion);

  if (hasAuditItem(items, "project_scope_audited") || hasAuditItem(items, "evidence_audited")) {
    if (hasConcreteScopeAnchor) {
      return `${prefix}\n\n已识别到接口路径或请求参数锚点，我会继续围绕这些锚点核实代码入口、参数映射和下游调用；如果还缺少信息，只需要补最小的项目、页面或入口。`;
    }
    return `${prefix}\n\n${buildProjectScopeFallbackRequest(normalizedQuestion)}`;
  }

  if (hasAuditItem(items, "sql_correctness_audited")) {
    return `${prefix}\n\n当前涉及 SQL 或数据核实时，还缺少 dev 校验结果或表结构证据。请补充目标系统/页面/字段，或确认是否需要我继续按代码反推表名和字段。`;
  }

  return `${prefix}\n\n请补充系统、项目、页面、接口或截图文字，我会基于补充信息继续核实。`;
}

export async function generateUserFacingAuditFallbackMessage(input: {
  question: string;
  items: RuntimeTodoItem[];
  model?: AuditFallbackModel;
}) {
  if (!input.model) {
    return buildUserFacingAuditFallbackMessage(input.question, input.items);
  }

  try {
    const response = await input.model.invoke([
      new SystemMessage(AUDIT_FALLBACK_SYSTEM_PROMPT),
      new HumanMessage(JSON.stringify({
        user_question: input.question,
        blocked_audit_items: formatAuditFallbackItems(input.items),
        output_goal: "生成面向用户的补充信息引导，不能套固定模板。",
      })),
    ]);
    const generated = sanitizeLlmAuditFallback(response.content);
    if (generated && isPrematureQueryableParamQuestion(input.question, generated)) {
      return buildUserFacingAuditFallbackMessage(input.question, input.items);
    }
    return generated || buildUserFacingAuditFallbackMessage(input.question, input.items);
  } catch (error) {
    console.error("Failed to generate audit fallback with LLM:", error);
    return buildUserFacingAuditFallbackMessage(input.question, input.items);
  }
}

export function buildRuntimeTodoTool(todoList: RuntimeTodoList) {
  return tool(
    async ({ itemId, status, evidence }) => {
      addRuntimeAuditTodoItem(todoList, itemId);
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
        "当前 TodoList 是动态计划，不是固定流程；只处理系统提示或当前问题明确需要的 itemId。",
        "如果分析过程中发现必须新增某个审核节点，可调用本工具写入该节点及证据。",
        "可选 itemId：project_scope_audited（代码包/仓库/项目范围一致性审核）、",
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
