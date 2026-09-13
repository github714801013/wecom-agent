import express from "express";
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getMissingPriorityAnswerAnchors, repairAnswerForMissingPriorityAnchors } from "./answer-anchor-guard.js";
import { config } from "./config.js";
import {
  extractExplicitRepoHints,
  extractMcpProjectCandidates,
  getBaseModel,
  getBusinessPrompt,
  initializeAgent,
  runPlanner,
  runSearchLoopPrelude,
  scopeToolsToRepo,
} from "./graph.js";
import { extractFlowControl } from "./flow-control.js";
import { detectHumanLoopRequest } from "./human-loop.js";
import { buildQuestionWithHistory, type ConversationContextItem } from "./interaction-control.js";
import { getAllMcpTools } from "./mcp-client.js";
import { buildProgressStreamContent, collapseProgressUpdates } from "./progress-updates.js";
import { buildProgressLimitRecoverySystemPrompt, ensureRecoverySqlAuditMarker } from "./recovery-synthesis.js";
import {
  buildUserFacingAuditFallbackMessage,
  generateUserFacingAuditFallbackMessage,
  resolveFinalReplyWithModel,
  type RuntimeTodoItem,
} from "./runtime-todolist.js";
import { buildToolContextSummary, filterToolResultForCurrentTurn, type ToolContextRecord } from "./tool-context-filter.js";
import { stringifyModelContent } from "./model-content.js";
import { buildDiagnosticErrorFields, buildUserFacingErrorReply, getErrorMessage, sanitizeErrorMessage } from "./error-response.js";
import {
  buildDirectEvidenceFastPathInstruction,
  buildDirectEvidenceRuntimeInstruction,
  hasDirectEvidenceAnchors,
  shouldUseDirectEvidenceFastPath,
} from "./direct-evidence.js";

const DEFAULT_DIAGNOSTIC_PORT = 3010;
const DIAGNOSTIC_TOKEN_HEADER = "x-diagnostic-token";
const MAX_DIAGNOSTIC_RECURSION_LIMIT = 64;
const MAX_DIAGNOSTIC_QUESTION_LENGTH = 8_000;
const MAX_DIAGNOSTIC_HISTORY_ITEMS = 20;
const MAX_DIAGNOSTIC_HISTORY_ITEM_LENGTH = 8_000;
const MAX_DIAGNOSTIC_REPO_HINTS = 20;
const MAX_DIAGNOSTIC_REPO_HINT_LENGTH = 200;
const MAX_DIAGNOSTIC_IN_FLIGHT = 2;
const MAX_DIAGNOSTIC_REQUESTS_PER_MINUTE = 20;
const MAX_DIAGNOSTIC_TOOL_RESULTS = 64;
const MAX_DIAGNOSTIC_DURATION_MS = 120_000;

const DIAGNOSTIC_TOKEN_PLACEHOLDER = "replace_with_a_dedicated_diagnostic_token";
const MIN_DIAGNOSTIC_TOKEN_LENGTH = 32;

function isUsableDiagnosticToken(token: string | undefined): token is string {
  return Boolean(token && token !== DIAGNOSTIC_TOKEN_PLACEHOLDER && token.length >= MIN_DIAGNOSTIC_TOKEN_LENGTH);
}

export function isDiagnosticServerEnabled(
  enabled = process.env.DIAGNOSTIC_ENABLED,
  accessToken = process.env.DIAGNOSTIC_TOKEN,
) {
  return enabled === "true" && isUsableDiagnosticToken(accessToken);
}

export function isDiagnosticRequestAuthorized(
  providedToken: string | undefined,
  accessToken = process.env.DIAGNOSTIC_TOKEN,
) {
  if (!providedToken || !isUsableDiagnosticToken(accessToken)) return false;
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(accessToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function parseDiagnosticRecursionLimit(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return Math.min(fallback, MAX_DIAGNOSTIC_RECURSION_LIMIT);
  return Math.min(parsed, MAX_DIAGNOSTIC_RECURSION_LIMIT);
}

function validateDiagnosticInput(input: Record<string, unknown>) {
  const question = typeof input.question === "string" ? input.question : "";
  if (question.length > MAX_DIAGNOSTIC_QUESTION_LENGTH) {
    throw new Error("question exceeds diagnostic length limit");
  }
  const history = input.history || input.sessionMessages;
  if (Array.isArray(history)) {
    if (history.length > MAX_DIAGNOSTIC_HISTORY_ITEMS) {
      throw new Error("history exceeds diagnostic item limit");
    }
    for (const item of history) {
      if (!item || typeof item !== "object") continue;
      const content = (item as Record<string, unknown>).content;
      if (stringifyModelContent(content).length > MAX_DIAGNOSTIC_HISTORY_ITEM_LENGTH) {
        throw new Error("history item exceeds diagnostic length limit");
      }
    }
  }
  const repoHints = input.repoHints;
  if (Array.isArray(repoHints)) {
    if (repoHints.length > MAX_DIAGNOSTIC_REPO_HINTS) {
      throw new Error("repoHints exceeds diagnostic item limit");
    }
    if (repoHints.some(item => String(item).length > MAX_DIAGNOSTIC_REPO_HINT_LENGTH)) {
      throw new Error("repoHint exceeds diagnostic length limit");
    }
  }
}

function validateDiagnosticEvaluateInput(input: Record<string, unknown>) {
  validateDiagnosticInput(input);
  for (const key of ["content", "args", "candidateAnswer", "answer", "llmReply", "question"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > MAX_DIAGNOSTIC_HISTORY_ITEM_LENGTH) {
      throw new Error(`${key} exceeds diagnostic length limit`);
    }
  }
  for (const key of ["itemIds", "llmReplies", "streamSnapshots"]) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    if (value.length > MAX_DIAGNOSTIC_HISTORY_ITEMS) {
      throw new Error(`${key} exceeds diagnostic item limit`);
    }
    if (value.some(item => String(item).length > MAX_DIAGNOSTIC_HISTORY_ITEM_LENGTH)) {
      throw new Error(`${key} item exceeds diagnostic length limit`);
    }
  }
}

type EvaluateCase = "progress" | "tool-context" | "human-loop" | "audit-fallback" | "question-history" | "final-gate";

type DiagnosticResult =
  | { case: "progress"; collapsed: string; streamContent: string }
  | { case: "tool-context"; filteredContent: string }
  | { case: "human-loop"; request: ReturnType<typeof detectHumanLoopRequest> }
  | { case: "audit-fallback"; reply: string }
  | { case: "question-history"; question: string; historyCount: number }
  | { case: "final-gate"; ready: boolean; action: string; source: string; answer: string; reason: string };

export function evaluateDiagnosticCase(caseName: "progress", input: Record<string, unknown>): Extract<DiagnosticResult, { case: "progress" }>;
export function evaluateDiagnosticCase(caseName: "tool-context", input: Record<string, unknown>): Extract<DiagnosticResult, { case: "tool-context" }>;
export function evaluateDiagnosticCase(caseName: "human-loop", input: Record<string, unknown>): Extract<DiagnosticResult, { case: "human-loop" }>;
export function evaluateDiagnosticCase(caseName: "audit-fallback", input: Record<string, unknown>): Extract<DiagnosticResult, { case: "audit-fallback" }>;
export function evaluateDiagnosticCase(caseName: "question-history", input: Record<string, unknown>): Extract<DiagnosticResult, { case: "question-history" }>;
export function evaluateDiagnosticCase(caseName: EvaluateCase, input: Record<string, unknown>): DiagnosticResult;
export function evaluateDiagnosticCase(caseName: EvaluateCase, input: Record<string, unknown>): DiagnosticResult {
  if (caseName === "progress") {
    const content = String(input.content || "");
    const activeCall = input.activeCall ? String(input.activeCall) : "";
    const activeCalls = activeCall ? [activeCall] : [];
    return {
      case: caseName,
      collapsed: collapseProgressUpdates(content),
      streamContent: buildProgressStreamContent(content, activeCalls),
    };
  }

  if (caseName === "tool-context") {
    const record: ToolContextRecord = {
      id: String(input.id || "diagnostic-tool-call"),
      name: String(input.name || "query"),
      args: String(input.args || "{}"),
      content: String(input.content || ""),
    };
    return {
      case: caseName,
      filteredContent: filterToolResultForCurrentTurn(record),
    };
  }

  if (caseName === "human-loop") {
    const content = String(input.content || "");
    return {
      case: caseName,
      request: detectHumanLoopRequest(content),
    };
  }

  if (caseName === "audit-fallback") {
    const question = String(input.question || "");
    const itemIds = Array.isArray(input.itemIds) && input.itemIds.length > 0
      ? input.itemIds.map(String)
      : ["project_scope_audited", "evidence_audited"];
    const items: RuntimeTodoItem[] = itemIds.map(id => ({
      id,
      task: id,
      status: "blocked",
      evidence: "debug audit fallback",
    }));
    return {
      case: caseName,
      reply: buildUserFacingAuditFallbackMessage(question, items),
    };
  }

  if (caseName === "question-history") {
    const question = String(input.question || "");
    const history = normalizeDiagnosticHistory(input.history || input.sessionMessages);
    return {
      case: caseName,
      question: history.length > 0 ? buildQuestionWithHistory(history, question) : question,
      historyCount: history.length,
    };
  }

  throw new Error(`Unsupported diagnostic case: ${caseName}`);
}

function normalizeDiagnosticStringArray(input: unknown) {
  if (Array.isArray(input)) {
    return input.map(String).filter(item => item.trim());
  }
  if (typeof input === "string" && input.trim()) {
    return [input];
  }
  return [];
}

function buildDiagnosticAuditFallbackItems(input: Record<string, unknown>) {
  const itemIds = Array.isArray(input.itemIds) && input.itemIds.length > 0
    ? input.itemIds.map(String)
    : ["project_scope_audited", "evidence_audited"];
  return itemIds.map(id => ({
    id,
    task: id,
    status: "blocked" as const,
    evidence: "debug audit fallback",
  }));
}

async function evaluateDiagnosticCaseAsync(caseName: EvaluateCase, input: Record<string, unknown>): Promise<DiagnosticResult> {
  validateDiagnosticEvaluateInput(input);
  if (caseName === "final-gate") {
    const llmReplies = normalizeDiagnosticStringArray(input.llmReplies);
    let replyIndex = 0;
    const model = {
      async invoke() {
        const content = llmReplies[replyIndex] || input.llmReply || JSON.stringify({
          ready: false,
          action: "continue",
          reason: "debug default non-final",
        });
        replyIndex += 1;
        return { content };
      },
    };
    const result = await resolveFinalReplyWithModel({
      question: String(input.question || ""),
      answer: String(input.candidateAnswer || input.answer || ""),
      streamSnapshots: normalizeDiagnosticStringArray(input.streamSnapshots),
      model,
    });
    return {
      case: "final-gate",
      ready: result.ready,
      action: result.action,
      source: result.source,
      answer: result.answer,
      reason: result.reason,
    };
  }

  if (caseName !== "audit-fallback" || (!input.useLlm && typeof input.llmReply !== "string")) {
    return evaluateDiagnosticCase(caseName, input);
  }

  const question = String(input.question || "");
  const items = buildDiagnosticAuditFallbackItems(input);
  const model = typeof input.llmReply === "string"
    ? {
      async invoke() {
        return { content: stringifyModelContent(input.llmReply) };
      },
    }
    : await getBaseModel();

  return {
    case: "audit-fallback",
    reply: await generateUserFacingAuditFallbackMessage({ question, items, model }),
  };
}

function getMessageType(message: BaseMessage) {
  return (message as any)._getType?.() || message.constructor.name;
}

function appendAnswerContent(current: string, content: unknown) {
  const delta = stringifyModelContent(content).replace(/\[System: Empty message content sanitised to satisfy protocol\]/g, "");
  if (!delta) return current;
  if (current && delta.startsWith(current)) return delta;
  return current + delta;
}

function sanitizeDiagnosticAnswer(content: string) {
  const withoutEmptyProtocolContent = content.replace(/\[System: Empty message content sanitised to satisfy protocol\]/g, "");
  return extractFlowControl(collapseProgressUpdates(withoutEmptyProtocolContent)).content.trim();
}

function buildDiagnosticFailureAnswer(answer: string, error: unknown, recoveryError?: unknown) {
  const details = [
    buildUserFacingErrorReply(error),
    recoveryError === undefined ? "" : buildUserFacingErrorReply(recoveryError, "恢复处理时发生异常"),
  ].filter(Boolean).join("\n\n");
  const content = sanitizeDiagnosticAnswer(answer);
  return content ? `${content}\n\n${details}` : details;
}

async function repairDiagnosticAnswerIfNeeded(question: string, answer: string) {
  if (getMissingPriorityAnswerAnchors(question, answer).length === 0) return answer;
  const baseModel = await getBaseModel();
  return sanitizeDiagnosticAnswer(await repairAnswerForMissingPriorityAnchors({
    model: baseModel,
    questionWithHistory: question,
    answer,
  }));
}

function normalizeDiagnosticHistory(input: unknown): ConversationContextItem[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const role = record.role === "assistant" || record.role === "system" ? record.role : "user";
    const content = stringifyModelContent(record.content).trim();
    return content ? [{ role, content }] : [];
  });
}

export async function runDiagnosticAgentQuestion(input: Record<string, unknown>) {
  validateDiagnosticInput(input);
  const diagnosticStartedAt = performance.now();
  const assertDiagnosticDeadline = () => {
    if (performance.now() - diagnosticStartedAt > MAX_DIAGNOSTIC_DURATION_MS) {
      throw new Error("diagnostic request timed out");
    }
  };
  const rawQuestion = String(input.question || "").trim();
  if (!rawQuestion) {
    throw new Error("question is required");
  }
  const diagnosticHistory = normalizeDiagnosticHistory(input.history || input.sessionMessages);
  const question = diagnosticHistory.length > 0
    ? buildQuestionWithHistory(diagnosticHistory, rawQuestion)
    : rawQuestion;

  const botName = typeof input.botName === "string" ? input.botName : "";
  const diagnosticBotName = process.env.DIAGNOSTIC_BOT_NAME?.trim() || config.bots[0]?.name;
  const botConfig = config.bots.find(bot => bot.name === diagnosticBotName);
  if (!botConfig) {
    throw new Error("No diagnostic bot config available");
  }
  if (botName && botName !== botConfig.name) {
    throw new Error("diagnostic bot selection is not allowed");
  }

  const recursionLimit = parseDiagnosticRecursionLimit(input.recursionLimit, config.llm.recursionLimit);
  const configuredRepoHints = (process.env.DIAGNOSTIC_REPO_HINTS || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  const explicitRepoHints = extractExplicitRepoHints(question, extractMcpProjectCandidates(config.mcpServers));
  const repoHints = configuredRepoHints.length > 0 ? configuredRepoHints : explicitRepoHints;
  assertDiagnosticDeadline();
  const plannerResult = await runPlanner(question);
  assertDiagnosticDeadline();
  if (shouldUseDirectEvidenceFastPath(question)) {
    const businessPrompt = await getBusinessPrompt(plannerResult);
    const baseModel = await getBaseModel();
    const response = await baseModel.invoke([
      new SystemMessage(`${businessPrompt}\n\n${buildDirectEvidenceFastPathInstruction()}`),
      new HumanMessage(question),
    ]);
    assertDiagnosticDeadline();
    return {
      ok: true,
      question,
      rawQuestion,
      historyCount: diagnosticHistory.length,
      answer: sanitizeDiagnosticAnswer(stringifyModelContent(response.content)),
      toolResultCount: 0,
      toolNames: [],
      repoHints,
      recursionLimit,
      plannerIntent: plannerResult?.intent,
      plannerQueries: plannerResult?.queries,
    };
  }
  const tools = await getAllMcpTools(botConfig);
  assertDiagnosticDeadline();
  const scopedTools = scopeToolsToRepo(tools, repoHints);
  const prelude = plannerResult
    && !hasDirectEvidenceAnchors(question)
    ? await runSearchLoopPrelude({
      userQuestion: question,
      plannerResult,
      tools: scopedTools,
      repoHint: repoHints,
    })
    : "";
  assertDiagnosticDeadline();
  const userContent = [
    prelude,
    hasDirectEvidenceAnchors(question) ? buildDirectEvidenceRuntimeInstruction() : "",
    "请基于工具证据直接给出最终结论；不要输出阶段性处理话术。",
    question,
  ].filter(Boolean).join("\n\n");
  const agent = await initializeAgent(scopedTools, plannerResult);
  const stream = await agent.stream({
    messages: [new HumanMessage(userContent)],
  }, {
    recursionLimit,
    streamMode: "messages",
    deadlineMs: MAX_DIAGNOSTIC_DURATION_MS,
  });

  const toolCallMap = new Map<string, { name: string; args: string; completed: boolean }>();
  const toolRecords: ToolContextRecord[] = [];
  let answer = "";

  try {
    for await (const [message] of stream) {
      assertDiagnosticDeadline();
      const msg = message as BaseMessage;
      const type = getMessageType(msg);

      if (type === "tool" || type === "ToolMessage") {
        const toolMsg = msg as any;
        const id = toolMsg.tool_call_id;
        const entry = toolCallMap.get(id);
        if (entry) {
          entry.completed = true;
          const record: ToolContextRecord = {
            id,
            name: entry.name || "unknown_tool",
            args: entry.args,
            content: stringifyModelContent(toolMsg.content),
          };
          toolRecords.push(record);
          if (toolRecords.length > MAX_DIAGNOSTIC_TOOL_RESULTS) {
            throw new Error("diagnostic tool result limit reached");
          }
        }
        continue;
      }

      if (type === "ai" || type === "AIMessage" || type === "AIMessageChunk") {
        const aiMsg = msg as any;
        if (Array.isArray(aiMsg.tool_call_chunks) && aiMsg.tool_call_chunks.length > 0) {
          for (const chunk of aiMsg.tool_call_chunks) {
            const id = chunk.id;
            if (!id) continue;
            if (!toolCallMap.has(id)) {
              toolCallMap.set(id, { name: "", args: "", completed: false });
            }
            const entry = toolCallMap.get(id)!;
            if (chunk.name) entry.name = chunk.name;
            if (chunk.args) entry.args += chunk.args;
          }
          continue;
        }

        if (Array.isArray(aiMsg.tool_calls) && aiMsg.tool_calls.length > 0) {
          for (const tool of aiMsg.tool_calls) {
            if (!tool.name) continue;
            const id = tool.id || `${tool.name}-${toolCallMap.size + 1}`;
            toolCallMap.set(id, {
              name: tool.name,
              args: JSON.stringify(tool.args || {}),
              completed: false,
            });
          }
          continue;
        }

        answer = appendAnswerContent(answer, aiMsg.content);
      }
    }
  } catch (error: any) {
    if (
      error?.lc_error_code === "AGENT_TOOL_PROGRESS_LIMIT"
      || error?.lc_error_code === "GRAPH_RECURSION_LIMIT"
      || error?.message?.includes("Recursion limit")
    ) {
      try {
        const baseModel = await getBaseModel();
        const businessPrompt = await getBusinessPrompt(plannerResult);
        const toolContextSummary = buildToolContextSummary(toolRecords);
        const recoveryResponse = await baseModel.invoke([
          new SystemMessage(buildProgressLimitRecoverySystemPrompt(businessPrompt)),
          new HumanMessage([
            `用户问题：${question}`,
            answer ? `已有阶段性回答：\n${answer}` : "",
            toolContextSummary || "",
          ].filter(Boolean).join("\n\n")),
        ]);
        return {
          ok: true,
          recovered: true,
          recoveryReason: sanitizeErrorMessage(getErrorMessage(error)),
          question,
          rawQuestion,
          historyCount: diagnosticHistory.length,
          answer: await repairDiagnosticAnswerIfNeeded(question, sanitizeDiagnosticAnswer(ensureRecoverySqlAuditMarker(stringifyModelContent(recoveryResponse.content)))),
          toolResultCount: toolRecords.length,
          toolNames: Array.from(new Set(toolRecords.map(record => record.name))),
          repoHints,
          recursionLimit,
          plannerIntent: plannerResult?.intent,
          plannerQueries: plannerResult?.queries,
        };
      } catch (recoveryError: any) {
        return {
          ok: false,
          recovered: false,
          ...buildDiagnosticErrorFields(error),
          originalError: sanitizeErrorMessage(getErrorMessage(error)),
          recoveryError: sanitizeErrorMessage(getErrorMessage(recoveryError)),
          errorCode: error?.lc_error_code,
          question,
          rawQuestion,
          historyCount: diagnosticHistory.length,
          answer: buildDiagnosticFailureAnswer(answer, error, recoveryError),
          toolResultCount: toolRecords.length,
          toolNames: Array.from(new Set(toolRecords.map(record => record.name))),
          repoHints,
          recursionLimit,
          plannerIntent: plannerResult?.intent,
          plannerQueries: plannerResult?.queries,
        };
      }
    }

    return {
      ok: false,
      ...buildDiagnosticErrorFields(error),
      errorCode: error?.lc_error_code,
      question,
      rawQuestion,
      historyCount: diagnosticHistory.length,
      answer: buildDiagnosticFailureAnswer(answer, error),
      toolResultCount: toolRecords.length,
      toolNames: Array.from(new Set(toolRecords.map(record => record.name))),
      repoHints,
      recursionLimit,
      plannerIntent: plannerResult?.intent,
      plannerQueries: plannerResult?.queries,
    };
  }

  return {
    ok: true,
    question,
    rawQuestion,
    historyCount: diagnosticHistory.length,
    answer: await repairDiagnosticAnswerIfNeeded(question, sanitizeDiagnosticAnswer(answer)),
    toolResultCount: toolRecords.length,
    toolNames: Array.from(new Set(toolRecords.map(record => record.name))),
    repoHints,
    recursionLimit,
    plannerIntent: plannerResult?.intent,
    plannerQueries: plannerResult?.queries,
  };
}

function normalizeCase(value: unknown): EvaluateCase {
  if (value === "progress" || value === "tool-context" || value === "human-loop" || value === "audit-fallback") {
    return value;
  }
  if (value === "question-history" || value === "final-gate") {
    return value;
  }
  throw new Error("case must be one of: progress, tool-context, human-loop, audit-fallback, question-history, final-gate");
}

export function startDiagnosticServer() {
  if (!isDiagnosticServerEnabled()) {
    if (process.env.DIAGNOSTIC_ENABLED === "true") {
      console.error("[diagnostic] DIAGNOSTIC_ENABLED=true requires DIAGNOSTIC_TOKEN; diagnostic server remains disabled.");
    }
    return;
  }

  const port = Number(process.env.DIAGNOSTIC_PORT || DEFAULT_DIAGNOSTIC_PORT);
  const host = process.env.DIAGNOSTIC_HOST || "127.0.0.1";
  const app = express();
  const rateWindows = new Map<string, { startedAt: number; count: number }>();
  let activeDiagnosticRequests = 0;
  const withDiagnosticCapacity = async <T>(work: () => Promise<T>) => {
    if (activeDiagnosticRequests >= MAX_DIAGNOSTIC_IN_FLIGHT) {
      throw new Error("diagnostic capacity exhausted");
    }
    activeDiagnosticRequests += 1;
    try {
      return await work();
    } finally {
      activeDiagnosticRequests -= 1;
    }
  };

  app.use("/__debug", (req, res, next) => {
    if (!isDiagnosticRequestAuthorized(req.get(DIAGNOSTIC_TOKEN_HEADER))) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    next();
  });
  app.use("/__debug", (req, res, next) => {
    const now = Date.now();
    for (const [key, entry] of rateWindows) {
      if (now - entry.startedAt >= 60_000) rateWindows.delete(key);
    }
    const clientKey = req.ip || "unknown";
    const current = rateWindows.get(clientKey);
    const window = !current || now - current.startedAt >= 60_000
      ? { startedAt: now, count: 0 }
      : current;
    if (window.count >= MAX_DIAGNOSTIC_REQUESTS_PER_MINUTE) {
      res.status(429).json({ ok: false, error: "rate_limited" });
      return;
    }
    rateWindows.set(clientKey, { ...window, count: window.count + 1 });
    next();
  });
  app.use(express.json({ limit: "256kb" }));

  app.get("/__debug/status", (_req, res) => {
    res.json({
      ok: true,
      service: "wecom-agent",
      diagnostics: {
        enabled: true,
        port,
      },
      cases: ["progress", "tool-context", "human-loop", "audit-fallback", "question-history", "final-gate", "agent-question"],
    });
  });

  app.get("/__debug/evaluate", async (req, res) => {
    try {
      res.json(await withDiagnosticCapacity(() => evaluateDiagnosticCaseAsync(normalizeCase(req.query.case), req.query)));
    } catch (error) {
      console.error("[diagnostic] Evaluate request failed:", sanitizeErrorMessage(getErrorMessage(error)));
      res.status(400).json({ ok: false, error: "diagnostic_evaluation_failed" });
    }
  });

  app.post("/__debug/evaluate", async (req, res) => {
    try {
      res.json(await withDiagnosticCapacity(() => evaluateDiagnosticCaseAsync(normalizeCase(req.body?.case), req.body || {})));
    } catch (error) {
      console.error("[diagnostic] Evaluate request failed:", sanitizeErrorMessage(getErrorMessage(error)));
      res.status(400).json({ ok: false, error: "diagnostic_evaluation_failed" });
    }
  });

  app.post("/__debug/ask", async (req, res) => {
    try {
      res.json(await withDiagnosticCapacity(() => runDiagnosticAgentQuestion(req.body || {})));
    } catch (error) {
      if (error instanceof Error && error.message === "diagnostic capacity exhausted") {
        res.status(429).json({ ok: false, error: "diagnostic_capacity_exhausted" });
        return;
      }
      console.error("[diagnostic] Agent request failed:", sanitizeErrorMessage(getErrorMessage(error)));
      res.status(400).json({ ok: false, error: "diagnostic_agent_failed" });
    }
  });

  return app.listen(port, host, () => {
    console.log(`[diagnostic] Listening on ${host}:${port}`);
  });
}

export function stopDiagnosticServer(server: Server | undefined) {
  return new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
