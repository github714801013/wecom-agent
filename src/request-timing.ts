export type RequestTerminalStatus = "completed" | "error" | "cancelled" | "ttl_expired";
export type RequestSpeedClass = "normal" | "slow" | "very_slow";

export interface RequestTimingStages {
  sensitivePrecheckMs: number | null;
  mediaProcessingMs: number | null;
  mcpLoadMs: number | null;
  piModelRoundMs: number | null;
  toolCallMs: number | null;
  replyQueueMs: number | null;
  finalSendMs: number | null;
  agentQueueMs: number | null;
  activeAgentRequests: number;
  queuedAgentRequests: number;
  replyActive: number;
  replyQueued: number;
  modelCalls: number;
}

export interface RequestTimingInput extends RequestTimingStages {
  requestId: string;
  botName: string;
  modelName: string;
  toolNames?: string[];
  totalMs: number;
  turns: number;
  terminalStatus: RequestTerminalStatus;
  errorCategory?: string | null;
  rawTrace?: string | undefined;
}

export interface RequestTimingRecord extends RequestTimingInput {
  speedClass: RequestSpeedClass;
}

export function classifyRequestSpeed(totalMs: number): RequestSpeedClass {
  const durationMs = Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : 0;
  if (durationMs >= 600_000) return "very_slow";
  if (durationMs >= 300_000) return "slow";
  return "normal";
}

export function shouldSampleRequest(
  record: Pick<RequestTimingRecord, "speedClass" | "terminalStatus">,
  random = Math.random(),
): boolean {
  if (record.speedClass !== "normal") return true;
  if (record.terminalStatus !== "completed") return true;
  return random < 0.1;
}

export function createRequestTimingRecord(input: RequestTimingInput): RequestTimingRecord {
  return { ...input, speedClass: classifyRequestSpeed(input.totalMs) };
}

export function formatRequestTimingLog(record: RequestTimingRecord): string {
  return `[request timing] ${JSON.stringify(record)}`;
}

export function monotonicNowMs(): number {
  return Math.round(performance.now());
}
