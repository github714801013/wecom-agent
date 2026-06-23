import express from "express";
import type { Server } from "node:http";
import { BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createAgentProgressGuard, createAgentProgressLimitError } from "./agent-progress-guard.js";
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
import { buildUserFacingAuditFallbackMessage, type RuntimeTodoItem } from "./runtime-todolist.js";
import { buildToolContextSummary, filterToolResultForCurrentTurn, type ToolContextRecord } from "./tool-context-filter.js";

const DEFAULT_DIAGNOSTIC_PORT = 3010;

type EvaluateCase = "progress" | "tool-context" | "human-loop" | "audit-fallback" | "question-history";

type DiagnosticResult =
  | { case: "progress"; collapsed: string; streamContent: string }
  | { case: "tool-context"; filteredContent: string }
  | { case: "human-loop"; request: ReturnType<typeof detectHumanLoopRequest> }
  | { case: "audit-fallback"; reply: string }
  | { case: "question-history"; question: string; historyCount: number };

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

function parsePositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getMessageType(message: BaseMessage) {
  return (message as any)._getType?.() || message.constructor.name;
}

function appendAnswerContent(current: string, content: unknown) {
  const delta = String(content || "").replace(/\[System: Empty message content sanitised to satisfy protocol\]/g, "");
  if (!delta) return current;
  if (current && delta.startsWith(current)) return delta;
  return current + delta;
}

function sanitizeDiagnosticAnswer(content: string) {
  const withoutEmptyProtocolContent = content.replace(/\[System: Empty message content sanitised to satisfy protocol\]/g, "");
  return extractFlowControl(collapseProgressUpdates(withoutEmptyProtocolContent)).content.trim();
}

function normalizeDiagnosticHistory(input: unknown): ConversationContextItem[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const role = record.role === "assistant" || record.role === "system" ? record.role : "user";
    const content = String(record.content || "").trim();
    return content ? [{ role, content }] : [];
  });
}

export async function runDiagnosticAgentQuestion(input: Record<string, unknown>) {
  const rawQuestion = String(input.question || "").trim();
  if (!rawQuestion) {
    throw new Error("question is required");
  }
  const diagnosticHistory = normalizeDiagnosticHistory(input.history || input.sessionMessages);
  const question = diagnosticHistory.length > 0
    ? buildQuestionWithHistory(diagnosticHistory, rawQuestion)
    : rawQuestion;

  const botName = typeof input.botName === "string" ? input.botName : "";
  const botConfig = config.bots.find(bot => bot.name === botName) || config.bots[0];
  if (!botConfig) {
    throw new Error("No bot config available");
  }

  const maxToolResults = parsePositiveInteger(input.maxToolResults, config.tools.maxAgentToolResultsPerTurn);
  const recursionLimit = parsePositiveInteger(input.recursionLimit, config.llm.recursionLimit);
  const plannerResult = await runPlanner(question);
  const tools = await getAllMcpTools(botConfig);
  const requestedRepoHints = Array.isArray(input.repoHints)
    ? input.repoHints.map(String).filter(Boolean)
    : typeof input.repoHint === "string" && input.repoHint.trim()
      ? [input.repoHint.trim()]
      : [];
  const explicitRepoHints = extractExplicitRepoHints(question, extractMcpProjectCandidates(config.mcpServers));
  const repoHints = requestedRepoHints.length > 0 ? requestedRepoHints : explicitRepoHints;
  const scopedTools = scopeToolsToRepo(tools, repoHints);
  const prelude = plannerResult
    ? await runSearchLoopPrelude({
      userQuestion: question,
      plannerResult,
      tools: scopedTools,
      repoHint: repoHints,
    })
    : "";
  const userContent = [
    prelude,
    "请基于工具证据直接给出最终结论；不要输出阶段性处理话术。",
    question,
  ].filter(Boolean).join("\n\n");
  const agent = await initializeAgent(scopedTools, plannerResult);
  const guard = createAgentProgressGuard({ maxToolResults });
  const stream = await agent.stream({
    messages: [new HumanMessage(userContent)],
  }, {
    recursionLimit,
    streamMode: "messages",
  });

  const toolCallMap = new Map<string, { name: string; args: string; completed: boolean }>();
  const toolRecords: ToolContextRecord[] = [];
  let answer = "";

  try {
    for await (const [message] of stream) {
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
            content: String(toolMsg.content || ""),
          };
          toolRecords.push(record);
          const decision = guard.recordToolResult(record);
          if (decision.shouldStop) {
            throw createAgentProgressLimitError(decision.reason);
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
    if (error?.lc_error_code === "AGENT_TOOL_PROGRESS_LIMIT") {
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
          recoveryReason: error instanceof Error ? error.message : String(error),
          question,
          rawQuestion,
          historyCount: diagnosticHistory.length,
          answer: sanitizeDiagnosticAnswer(ensureRecoverySqlAuditMarker(recoveryResponse.content.toString())),
          toolResultCount: toolRecords.length,
          toolNames: Array.from(new Set(toolRecords.map(record => record.name))),
          repoHints,
          maxToolResults,
          recursionLimit,
          plannerIntent: plannerResult?.intent,
          plannerQueries: plannerResult?.queries,
        };
      } catch (recoveryError: any) {
        return {
          ok: false,
          recovered: false,
          error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          originalError: error instanceof Error ? error.message : String(error),
          errorCode: error?.lc_error_code,
          question,
          rawQuestion,
          historyCount: diagnosticHistory.length,
          answer: sanitizeDiagnosticAnswer(answer),
          toolResultCount: toolRecords.length,
          toolNames: Array.from(new Set(toolRecords.map(record => record.name))),
          repoHints,
          maxToolResults,
          recursionLimit,
          plannerIntent: plannerResult?.intent,
          plannerQueries: plannerResult?.queries,
        };
      }
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error?.lc_error_code,
      question,
      rawQuestion,
      historyCount: diagnosticHistory.length,
      answer: sanitizeDiagnosticAnswer(answer),
      toolResultCount: toolRecords.length,
      toolNames: Array.from(new Set(toolRecords.map(record => record.name))),
      repoHints,
      maxToolResults,
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
    answer: sanitizeDiagnosticAnswer(answer),
    toolResultCount: toolRecords.length,
    toolNames: Array.from(new Set(toolRecords.map(record => record.name))),
    repoHints,
    maxToolResults,
    recursionLimit,
    plannerIntent: plannerResult?.intent,
    plannerQueries: plannerResult?.queries,
  };
}

function normalizeCase(value: unknown): EvaluateCase {
  if (value === "progress" || value === "tool-context" || value === "human-loop" || value === "audit-fallback") {
    return value;
  }
  if (value === "question-history") {
    return value;
  }
  throw new Error("case must be one of: progress, tool-context, human-loop, audit-fallback, question-history");
}

export function startDiagnosticServer() {
  if (process.env.DIAGNOSTIC_ENABLED === "false") {
    return;
  }

  const port = Number(process.env.DIAGNOSTIC_PORT || DEFAULT_DIAGNOSTIC_PORT);
  const host = process.env.DIAGNOSTIC_HOST || "0.0.0.0";
  const app = express();

  app.use(express.json({ limit: "256kb" }));

  app.get("/__debug/status", (_req, res) => {
    res.json({
      ok: true,
      service: "wecom-agent",
      diagnostics: {
        enabled: true,
        port,
      },
      cases: ["progress", "tool-context", "human-loop", "audit-fallback", "question-history", "agent-question"],
    });
  });

  app.get("/__debug/evaluate", (req, res) => {
    try {
      res.json(evaluateDiagnosticCase(normalizeCase(req.query.case), req.query));
    } catch (error: any) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/__debug/evaluate", (req, res) => {
    try {
      res.json(evaluateDiagnosticCase(normalizeCase(req.body?.case), req.body || {}));
    } catch (error: any) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/__debug/ask", async (req, res) => {
    try {
      res.json(await runDiagnosticAgentQuestion(req.body || {}));
    } catch (error: any) {
      res.status(400).json({ ok: false, error: error.message });
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
