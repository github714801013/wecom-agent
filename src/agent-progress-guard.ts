import { parseArgs, type ToolContextRecord } from "./tool-context-filter.js";

export interface AgentProgressGuardOptions {
  maxToolResults?: number;
  maxRepeatedToolCalls?: number;
  maxToolErrors?: number;
}

export type AgentProgressErrorCode = "AGENT_TOOL_PROGRESS_LIMIT" | "AGENT_TOOL_ERROR_LIMIT";

export interface AgentProgressGuardDecision {
  shouldStop: boolean;
  reason: string;
  errorCode?: AgentProgressErrorCode;
}

const DEFAULT_MAX_TOOL_RESULTS = 64;
const DEFAULT_MAX_REPEATED_TOOL_CALLS = 64;
const DEFAULT_MAX_TOOL_ERRORS = 3;
const MAX_TOOL_ERROR_SUMMARY_LENGTH = 180;
const RUNTIME_TODO_TOOL_NAME = "runtime_todolist_update";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, item && typeof item === "object" ? JSON.parse(stableJson(item)) : item]);
  return JSON.stringify(Object.fromEntries(entries));
}

function buildToolSignature(record: ToolContextRecord) {
  return `${record.name}:${stableJson(parseArgs(record.args || ""))}`;
}

function isEvidenceTool(record: ToolContextRecord) {
  return record.name !== RUNTIME_TODO_TOOL_NAME;
}

function summarizeToolError(record: ToolContextRecord) {
  const normalized = record.content
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/((?:authorization|cookie|password|passwd|token|secret)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\s+/gu, " ")
    .replace(/\s*Please fix your mistakes\.?$/iu, "")
    .trim();
  const summary = normalized || "未返回错误详情";
  return `${record.name}: ${summary.length > MAX_TOOL_ERROR_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_TOOL_ERROR_SUMMARY_LENGTH)}...`
    : summary}`;
}

export function createAgentProgressGuard(options: AgentProgressGuardOptions = {}) {
  const maxToolResults = options.maxToolResults ?? DEFAULT_MAX_TOOL_RESULTS;
  const maxRepeatedToolCalls = options.maxRepeatedToolCalls ?? DEFAULT_MAX_REPEATED_TOOL_CALLS;
  const maxToolErrors = Math.max(1, options.maxToolErrors ?? DEFAULT_MAX_TOOL_ERRORS);
  const signatureCounts = new Map<string, number>();
  const failedToolSummaries: string[] = [];
  let evidenceToolResults = 0;
  let toolErrors = 0;

  return {
    recordToolResult(record: ToolContextRecord): AgentProgressGuardDecision {
      if (!isEvidenceTool(record)) {
        return { shouldStop: false, reason: "" };
      }

      evidenceToolResults += 1;

      if (record.status === "error") {
        toolErrors += 1;
        failedToolSummaries.push(summarizeToolError(record));
        if (failedToolSummaries.length > maxToolErrors) {
          failedToolSummaries.shift();
        }
        if (toolErrors >= maxToolErrors) {
          return {
            shouldStop: true,
            reason: `工具查询失败达到上限：${toolErrors}/${maxToolErrors}；最近失败：${failedToolSummaries.join("；")}`,
            errorCode: "AGENT_TOOL_ERROR_LIMIT",
          };
        }
      }

      const signature = buildToolSignature(record);
      const signatureCount = (signatureCounts.get(signature) || 0) + 1;
      signatureCounts.set(signature, signatureCount);

      if (signatureCount > maxRepeatedToolCalls) {
        return {
          shouldStop: true,
          reason: `重复工具调用超过限制：${record.name}`,
          errorCode: "AGENT_TOOL_PROGRESS_LIMIT",
        };
      }

      if (evidenceToolResults >= maxToolResults) {
        return {
          shouldStop: true,
          reason: `工具调用达到上限：${evidenceToolResults}/${maxToolResults}`,
          errorCode: "AGENT_TOOL_PROGRESS_LIMIT",
        };
      }

      return { shouldStop: false, reason: "" };
    },
  };
}

function createAgentLimitError(reason: string, errorCode: AgentProgressErrorCode) {
  const error = new Error(reason);
  (error as Error & { lc_error_code?: AgentProgressErrorCode }).lc_error_code = errorCode;
  return error;
}

export function createAgentProgressLimitError(reason: string) {
  return createAgentLimitError(reason, "AGENT_TOOL_PROGRESS_LIMIT");
}

export function createAgentToolErrorLimitError(reason: string) {
  return createAgentLimitError(reason, "AGENT_TOOL_ERROR_LIMIT");
}

export function buildAgentToolErrorLimitReply(reason: string) {
  const detail = reason.trim();
  return `工具查询失败已达到本轮上限，已停止继续调用，避免反复查询。${detail ? `\n\n${detail}` : ""}\n\n请检查对应 MCP、数据源或权限后重试。`;
}
