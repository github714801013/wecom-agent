import type { FinalReplyResolutionResult } from "./runtime-todolist.js";
import type { ToolContextRecord } from "./tool-context-filter.js";
import { buildToolSignature, isEvidenceTool } from "./agent-progress-guard.js";

export const AUTO_VERIFICATION_PROTECTION_WINDOW_MS = 3 * 60 * 1000;
export const AUTO_VERIFICATION_HARD_LIMIT_MS = 8 * 60 * 1000;
export const AUTO_VERIFICATION_NO_PROGRESS_REPLY = [
  "无法产生新的有效工具查询，已停止继续调用，避免重复检索。",
  "",
  "当前证据缺口仍未补齐；如能提供新的代码范围、接口、日志或数据锚点，可基于现有上下文继续核对。",
].join("\n");

export interface AutoVerificationToolCall {
  name: string;
  args: string;
}

export interface AutoVerificationRoundContext {
  round: number;
  correction: boolean;
  accumulatedToolRecords: readonly ToolContextRecord[];
  evidenceGaps: readonly string[];
  usedToolCalls: readonly AutoVerificationToolCall[];
  signal: AbortSignal;
}

export interface AutoVerificationRoundResult {
  content: string;
  evidenceGaps: string[];
  toolRecords: ToolContextRecord[];
}

export interface AutoVerificationReviewInput extends AutoVerificationRoundResult {
  round: number;
  accumulatedToolRecords: readonly ToolContextRecord[];
  signal: AbortSignal;
}

export type AutoVerificationExitReason =
  | "resolved"
  | "passthrough"
  | "protection-window-elapsed"
  | "hard-limit"
  | "no-progress";

export interface AutoVerificationLoopResult {
  content: string;
  finalResolution: FinalReplyResolutionResult;
  exitReason: AutoVerificationExitReason;
  rounds: number;
  toolRecords: ToolContextRecord[];
  evidenceGaps: string[];
}

export interface AutoVerificationLoopOptions {
  startedAt: number;
  now: () => number;
  runRound: (context: AutoVerificationRoundContext) => Promise<AutoVerificationRoundResult>;
  reviewFinal: (input: AutoVerificationReviewInput) => Promise<FinalReplyResolutionResult>;
  canContinue?: () => boolean;
}

export interface AutoVerificationContinuationPromptInput {
  question: string;
  candidate: string;
  evidenceGaps: readonly string[];
  usedToolCalls: readonly AutoVerificationToolCall[];
  accumulatedEvidenceSummary: string;
  correction: boolean;
}

function truncatePromptValue(value: string, maxLength: number) {
  const normalized = value.trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

export function buildAutoVerificationContinuationPrompt(
  input: AutoVerificationContinuationPromptInput,
) {
  const evidenceGaps = input.evidenceGaps.length > 0
    ? input.evidenceGaps.map(item => `- ${item}`).join("\n")
    : "- 最终评审认为当前候选仍缺少直接证据，请从评审原因和候选回答中定位缺口。";
  const usedToolCalls = input.usedToolCalls.length > 0
    ? input.usedToolCalls.slice(-64).map(call =>
      `- ${call.name} ${truncatePromptValue(call.args, 600)}`
    ).join("\n")
    : "- 无";
  const correctionInstruction = input.correction
    ? "上一轮没有产生新的有效证据。这是唯一一次强制纠偏：必须改变查询范围或参数，禁止重复下列已用调用。"
    : "当前最终候选证据不足。继续调用工具补齐缺口，至少产生一个此前未使用相同工具名和参数的新证据结果。";

  return [
    "系统提示：【自动续查轮次】",
    correctionInstruction,
    "runtime_todolist_update 不计为证据；仅整理已有内容也不计为新证据。",
    "",
    "用户问题：",
    truncatePromptValue(input.question, 6000),
    "",
    "当前候选回答：",
    truncatePromptValue(input.candidate, 12000),
    "",
    "剩余证据缺口：",
    evidenceGaps,
    "",
    "已使用的工具调用（禁止原样重复）：",
    usedToolCalls,
    "",
    "累计工具证据摘要：",
    truncatePromptValue(input.accumulatedEvidenceSummary, 16000) || "无",
    "",
    "完成新查询后直接输出更新后的完整候选答案，不要输出内部续查协议或解释计时规则。",
  ].join("\n");
}

function getNewEvidenceSignature(record: ToolContextRecord) {
  if (!isEvidenceTool(record) || record.status === "error") {
    return null;
  }
  return buildToolSignature(record);
}

function buildResult(
  content: string,
  finalResolution: FinalReplyResolutionResult,
  exitReason: AutoVerificationExitReason,
  rounds: number,
  toolRecords: ToolContextRecord[],
  evidenceGaps: string[],
): AutoVerificationLoopResult {
  return {
    content,
    finalResolution,
    exitReason,
    rounds,
    toolRecords,
    evidenceGaps,
  };
}

const AUTO_VERIFICATION_HARD_LIMIT_REASON = "自动续查已达到八分钟硬上限";

type HardDeadlineResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

function buildHardLimitResolution(content: string): FinalReplyResolutionResult {
  return {
    ready: false,
    action: "continue",
    answer: content,
    reason: AUTO_VERIFICATION_HARD_LIMIT_REASON,
    source: "unresolved",
    review: {
      ready: false,
      action: "continue",
      reason: AUTO_VERIFICATION_HARD_LIMIT_REASON,
    },
  };
}

async function runBeforeHardLimit<T>(
  options: AutoVerificationLoopOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<HardDeadlineResult<T>> {
  const remaining = AUTO_VERIFICATION_HARD_LIMIT_MS - (options.now() - options.startedAt);
  if (remaining <= 0) {
    return { timedOut: true };
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const operationResult = operation(controller.signal).then(
    value => ({ kind: "value" as const, value }),
    error => ({ kind: "error" as const, error }),
  );
  const timeoutResult = new Promise<{ kind: "timeout" }>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, remaining);
  });

  try {
    const result = await Promise.race([operationResult, timeoutResult]);
    if (result.kind === "timeout") {
      return { timedOut: true };
    }
    if (result.kind === "error") {
      throw result.error;
    }
    return { timedOut: false, value: result.value };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function runAutoVerificationLoop(
  options: AutoVerificationLoopOptions,
): Promise<AutoVerificationLoopResult> {
  const accumulatedToolRecords: ToolContextRecord[] = [];
  const usedToolCalls = new Map<string, AutoVerificationToolCall>();
  let evidenceGaps: string[] = [];
  let round = 0;
  let correction = false;
  let latestRoundResult: AutoVerificationRoundResult = {
    content: "",
    evidenceGaps: [],
    toolRecords: [],
  };
  let latestFinalResolution: FinalReplyResolutionResult | undefined;

  const buildHardLimitResult = () => {
    const finalResolution = latestFinalResolution
      ?? buildHardLimitResolution(latestRoundResult.content);
    const hardLimitGaps = evidenceGaps.includes(AUTO_VERIFICATION_HARD_LIMIT_REASON)
      ? evidenceGaps
      : [...evidenceGaps, AUTO_VERIFICATION_HARD_LIMIT_REASON];
    return buildResult(
      latestRoundResult.content,
      finalResolution,
      "hard-limit",
      round,
      accumulatedToolRecords,
      hardLimitGaps,
    );
  };

  while (true) {
    round += 1;
    const roundOutcome = await runBeforeHardLimit(options, signal => options.runRound({
      round,
      correction,
      accumulatedToolRecords,
      evidenceGaps,
      usedToolCalls: [...usedToolCalls.values()],
      signal,
    }));
    if (roundOutcome.timedOut) {
      return buildHardLimitResult();
    }

    const roundResult = roundOutcome.value;
    latestRoundResult = roundResult;
    let hasNewEvidence = false;
    for (const record of roundResult.toolRecords) {
      const signature = getNewEvidenceSignature(record);
      if (!signature || usedToolCalls.has(signature)) continue;
      usedToolCalls.set(signature, { name: record.name, args: record.args });
      hasNewEvidence = true;
    }

    accumulatedToolRecords.push(...roundResult.toolRecords);
    evidenceGaps = [...roundResult.evidenceGaps];

    if (options.now() - options.startedAt >= AUTO_VERIFICATION_HARD_LIMIT_MS) {
      return buildHardLimitResult();
    }

    const reviewOutcome = await runBeforeHardLimit(options, signal => options.reviewFinal({
      ...roundResult,
      round,
      accumulatedToolRecords,
      signal,
    }));
    if (reviewOutcome.timedOut) {
      return buildHardLimitResult();
    }

    const finalResolution = reviewOutcome.value;
    latestFinalResolution = finalResolution;
    if (options.now() - options.startedAt >= AUTO_VERIFICATION_HARD_LIMIT_MS) {
      return buildHardLimitResult();
    }

    if (finalResolution.ready) {
      return buildResult(
        finalResolution.answer,
        finalResolution,
        "resolved",
        round,
        accumulatedToolRecords,
        evidenceGaps,
      );
    }

    if (finalResolution.source !== "unresolved" || finalResolution.action !== "continue") {
      return buildResult(
        roundResult.content,
        finalResolution,
        "passthrough",
        round,
        accumulatedToolRecords,
        evidenceGaps,
      );
    }

    const reviewGap = finalResolution.reason.trim();
    if (reviewGap && !evidenceGaps.includes(reviewGap)) {
      evidenceGaps = [...evidenceGaps, reviewGap];
    }

    if (options.canContinue && !options.canContinue()) {
      return buildResult(
        roundResult.content,
        finalResolution,
        "passthrough",
        round,
        accumulatedToolRecords,
        evidenceGaps,
      );
    }

    const elapsed = options.now() - options.startedAt;
    if (elapsed > AUTO_VERIFICATION_PROTECTION_WINDOW_MS) {
      return buildResult(
        roundResult.content,
        finalResolution,
        "protection-window-elapsed",
        round,
        accumulatedToolRecords,
        evidenceGaps,
      );
    }

    if (!hasNewEvidence) {
      if (correction) {
        return buildResult(
          AUTO_VERIFICATION_NO_PROGRESS_REPLY,
          finalResolution,
          "no-progress",
          round,
          accumulatedToolRecords,
          evidenceGaps,
        );
      }
      correction = true;
      continue;
    }

    correction = false;
  }
}
