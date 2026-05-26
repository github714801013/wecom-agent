export type HumanLoopReason =
  | "clarification_required"
  | "prod_sql_required"
  | "risk_confirmation_required";

export interface HumanLoopContextSnapshot {
  userQuestion: string;
  currentPlan?: string;
  knownFacts: string[];
  missingFacts: string[];
}

export interface HumanLoopRequest {
  reason: HumanLoopReason;
  question?: string;
  sql?: string;
  expectedResultFormat?: string;
  resumeInstruction: string;
  contextSnapshot: HumanLoopContextSnapshot;
}

export interface StoredHumanLoopRequest extends HumanLoopRequest {
  createdAt: number;
  expiresAt: number;
  originalMessageId: string;
  resumeCount: number;
}

const HUMAN_LOOP_TTL_MS = 30 * 60 * 1000;
const SAFE_SQL_START = /^(select|show|explain)\b/i;
const UNSAFE_SQL_KEYWORDS = /\b(update|delete|insert|truncate|drop|alter|create|replace|grant|revoke|merge|call)\b/i;

function normalizeHumanLoop(raw: any): HumanLoopRequest | null {
  const source = raw?.human_loop ?? raw?.humanLoop ?? raw;
  if (!source || typeof source !== "object") return null;

  const reason = source.reason;
  if (!["clarification_required", "prod_sql_required", "risk_confirmation_required"].includes(reason)) {
    return null;
  }

  const context = source.context_snapshot ?? source.contextSnapshot;
  if (!context || typeof context !== "object" || typeof context.user_question !== "string") {
    return null;
  }

  const request: HumanLoopRequest = {
    reason,
    resumeInstruction: String(source.resume_instruction ?? source.resumeInstruction ?? ""),
    contextSnapshot: {
      userQuestion: context.user_question ?? context.userQuestion,
      knownFacts: Array.isArray(context.known_facts ?? context.knownFacts)
        ? (context.known_facts ?? context.knownFacts).map(String)
        : [],
      missingFacts: Array.isArray(context.missing_facts ?? context.missingFacts)
        ? (context.missing_facts ?? context.missingFacts).map(String)
        : [],
    },
  };

  const currentPlan = context.current_plan ?? context.currentPlan;
  if (typeof currentPlan === "string" && currentPlan.trim()) {
    request.contextSnapshot.currentPlan = currentPlan.trim();
  }

  const question = source.question;
  if (typeof question === "string" && question.trim()) {
    request.question = question.trim();
  }

  const sql = source.sql;
  if (typeof sql === "string" && sql.trim()) {
    request.sql = sql.trim();
  }

  const expectedResultFormat = source.expected_result_format ?? source.expectedResultFormat;
  if (typeof expectedResultFormat === "string" && expectedResultFormat.trim()) {
    request.expectedResultFormat = expectedResultFormat.trim();
  }

  if (!request.resumeInstruction.trim()) return null;
  if (request.reason === "clarification_required" && !request.question) return null;
  if (request.reason === "prod_sql_required" && (!request.sql || !isSafeReadOnlySql(request.sql))) return null;

  return request;
}

function parseJsonCandidate(candidate: string): HumanLoopRequest | null {
  try {
    return normalizeHumanLoop(JSON.parse(candidate));
  } catch {
    return null;
  }
}

export function detectHumanLoopRequest(text: string): HumanLoopRequest | null {
  const trimmed = text.trim();
  if (!trimmed.includes("human_loop") && !trimmed.includes("humanLoop")) return null;

  const fencedJson = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]) {
    const request = parseJsonCandidate(fencedJson[1]);
    if (request) return request;
  }

  const jsonObject = trimmed.match(/\{[\s\S]*\}/);
  return jsonObject?.[0] ? parseJsonCandidate(jsonObject[0]) : null;
}

export function isSafeReadOnlySql(sql: string) {
  const normalized = sql.trim().replace(/;+\s*$/g, "");
  return SAFE_SQL_START.test(normalized) && !UNSAFE_SQL_KEYWORDS.test(normalized);
}

export function toStoredHumanLoopRequest(
  request: HumanLoopRequest,
  originalMessageId: string,
  now = Date.now(),
): StoredHumanLoopRequest {
  return {
    ...request,
    createdAt: now,
    expiresAt: now + HUMAN_LOOP_TTL_MS,
    originalMessageId,
    resumeCount: 0,
  };
}

export function buildHumanLoopReply(request: HumanLoopRequest) {
  if (request.reason === "prod_sql_required") {
    const expected = request.expectedResultFormat
      ? `\n\n需要你返回：\n${request.expectedResultFormat}`
      : "\n\n需要你返回：查询结果、执行时间；如果结果为空，请同时确认查询条件是否正确。";

    return `我无法直接查询生产库。请在生产只读环境执行下面 SQL，并把结果粘贴回来，我会基于结果继续分析。\n\nSQL:\n\`\`\`sql\n${request.sql}\n\`\`\`${expected}`;
  }

  if (request.reason === "risk_confirmation_required") {
    return request.question || "当前操作存在风险，请确认是否继续。";
  }

  return request.question || "当前信息不足，请补充关键数据后我再继续处理。";
}

export function buildHumanLoopResumeContent(request: HumanLoopRequest, resumeInput: string) {
  const knownFacts = request.contextSnapshot.knownFacts.map(item => `- ${item}`).join("\n") || "- 无";
  const missingFacts = request.contextSnapshot.missingFacts.map(item => `- ${item}`).join("\n") || "- 无";

  return `【Human Loop 恢复】
原始问题：
${request.contextSnapshot.userQuestion}

暂停原因：
${request.reason}

已知事实：
${knownFacts}

原缺失信息：
${missingFacts}

恢复指令：
${request.resumeInstruction}

用户本次补充：
${resumeInput}`;
}

export function isHumanLoopExpired(request: StoredHumanLoopRequest, now = Date.now()) {
  return now > request.expiresAt;
}

export function isAmbiguousNewTopicWhilePending(text: string) {
  const normalized = text.trim();
  if (!normalized) return false;
  if (normalized.includes("\n") || normalized.includes("\t") || normalized.includes(",")) return false;
  if (/^(结果|查询结果|执行结果|补充|环境|订单号|单号|id|ID|状态|时间|是|不是|生产|测试|dev|prod)[:：\s]/.test(normalized)) {
    return false;
  }
  return /^(帮我|查|查询|分析|排查|看下|看看|为什么|哪里|如何|怎么|给我)/.test(normalized)
    || /[？?]$/.test(normalized);
}
