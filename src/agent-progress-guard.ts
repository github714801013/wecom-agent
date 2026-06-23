import { parseArgs, type ToolContextRecord } from "./tool-context-filter.js";

export interface AgentProgressGuardOptions {
  maxToolResults?: number;
  maxRepeatedToolCalls?: number;
}

export interface AgentProgressGuardDecision {
  shouldStop: boolean;
  reason: string;
}

const DEFAULT_MAX_TOOL_RESULTS = 64;
const DEFAULT_MAX_REPEATED_TOOL_CALLS = 64;
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

export function createAgentProgressGuard(options: AgentProgressGuardOptions = {}) {
  const maxToolResults = options.maxToolResults ?? DEFAULT_MAX_TOOL_RESULTS;
  const maxRepeatedToolCalls = options.maxRepeatedToolCalls ?? DEFAULT_MAX_REPEATED_TOOL_CALLS;
  const signatureCounts = new Map<string, number>();
  let evidenceToolResults = 0;

  return {
    recordToolResult(record: ToolContextRecord): AgentProgressGuardDecision {
      if (!isEvidenceTool(record)) {
        return { shouldStop: false, reason: "" };
      }

      evidenceToolResults += 1;
      const signature = buildToolSignature(record);
      const signatureCount = (signatureCounts.get(signature) || 0) + 1;
      signatureCounts.set(signature, signatureCount);

      if (signatureCount > maxRepeatedToolCalls) {
        return {
          shouldStop: true,
          reason: `重复工具调用超过限制：${record.name}`,
        };
      }

      if (evidenceToolResults >= maxToolResults) {
        return {
          shouldStop: true,
          reason: `工具调用达到上限：${evidenceToolResults}/${maxToolResults}`,
        };
      }

      return { shouldStop: false, reason: "" };
    },
  };
}

export function createAgentProgressLimitError(reason: string) {
  const error = new Error(reason);
  (error as Error & { lc_error_code?: string }).lc_error_code = "AGENT_TOOL_PROGRESS_LIMIT";
  return error;
}
