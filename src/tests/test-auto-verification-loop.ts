import assert from "node:assert/strict";
import {
  AUTO_VERIFICATION_HARD_LIMIT_MS,
  runAutoVerificationLoop,
} from "../auto-verification-loop.js";
import type { FinalReplyResolutionResult } from "../runtime-todolist.js";

function unresolved(reason: string): FinalReplyResolutionResult {
  return {
    ready: false,
    action: "continue",
    answer: "现有证据仍不完整。",
    reason,
    source: "unresolved",
    review: { ready: false, action: "continue", reason },
  };
}

function resolved(answer: string): FinalReplyResolutionResult {
  return {
    ready: true,
    action: "send",
    answer,
    reason: "直接证据已闭环",
    source: "candidate",
    review: { ready: true, action: "send", reason: "直接证据已闭环" },
  };
}

const startedAt = 10_000;
let now = startedAt + 60_000;
const observedRounds: Array<{ round: number; correction: boolean }> = [];

const result = await runAutoVerificationLoop({
  startedAt,
  now: () => now,
  async runRound(context) {
    observedRounds.push({ round: context.round, correction: context.correction });

    if (context.round === 1) {
      return {
        content: "已定位入口，仍缺少消费者调用证据。",
        evidenceGaps: ["缺少消费者调用证据"],
        toolRecords: [{
          id: "query-entry",
          name: "query",
          args: JSON.stringify({ query: "SendMaByQuarter 入口" }),
          content: "找到入口调用",
          status: "success",
        }],
      };
    }

    now = startedAt + 61_000;
    return {
      content: "结论：入口和消费者调用链均已由代码证据确认。",
      evidenceGaps: [],
      toolRecords: [{
        id: "query-consumer",
        name: "code_snippet",
        args: JSON.stringify({ filePath: "worker.ts", symbol: "SendMaByQuarter" }),
        content: "找到消费者调用",
        status: "success",
      }],
    };
  },
  async reviewFinal({ content }) {
    return content.startsWith("结论：")
      ? resolved(content)
      : unresolved("缺少消费者调用证据");
  },
});

assert.equal(
  observedRounds.length,
  2,
  "三分钟保护窗口内证据不足时必须实际进入下一轮 Agent 工具执行",
);
assert.deepEqual(observedRounds, [
  { round: 1, correction: false },
  { round: 2, correction: false },
]);
assert.equal(result.exitReason, "resolved");
assert.equal(result.content, "结论：入口和消费者调用链均已由代码证据确认。");
assert.equal(result.rounds, 2);

const noProgressStartedAt = 50_000;
let noProgressNow = noProgressStartedAt + 30_000;
const noProgressContexts: Array<{
  round: number;
  correction: boolean;
  usedToolCalls: string[];
}> = [];

const noProgressResult = await runAutoVerificationLoop({
  startedAt: noProgressStartedAt,
  now: () => noProgressNow,
  async runRound(context) {
    noProgressContexts.push({
      round: context.round,
      correction: context.correction,
      usedToolCalls: context.usedToolCalls.map(call => `${call.name}:${call.args}`),
    });

    if (context.round > 3) {
      noProgressNow = noProgressStartedAt + 180_001;
    }

    return {
      content: "仍在重复查询同一范围。",
      evidenceGaps: ["需要新的消费者调用证据"],
      toolRecords: [
        {
          id: `duplicate-${context.round}`,
          name: "query",
          args: context.round === 1
            ? JSON.stringify({ query: "SendMaByQuarter 入口", repo: "oanew" })
            : JSON.stringify({ repo: "oanew", query: "SendMaByQuarter 入口" }),
          content: "重复返回同一入口",
          status: "success",
        },
        {
          id: `todo-${context.round}`,
          name: "runtime_todolist_update",
          args: JSON.stringify({ itemId: "evidence_audited" }),
          content: "todo updated",
          status: "success",
        },
      ],
    };
  },
  async reviewFinal() {
    return unresolved("需要新的消费者调用证据");
  },
});

assert.deepEqual(
  noProgressContexts.map(context => context.correction),
  [false, false, true],
  "首次重复查询后只允许一轮带纠偏标记的重试",
);
assert.deepEqual(
  noProgressContexts[2]?.usedToolCalls,
  [`query:${JSON.stringify({ query: "SendMaByQuarter 入口", repo: "oanew" })}`],
  "纠偏轮必须获得已使用的工具名和参数",
);
assert.equal(noProgressResult.exitReason, "no-progress");
assert.equal(noProgressResult.rounds, 3);
assert.match(noProgressResult.content, /无法产生新的有效工具查询/);
assert.doesNotMatch(noProgressResult.content, /已自动继续核实/);

async function runAtBoundary(elapsed: number) {
  let round = 0;
  return runAutoVerificationLoop({
    startedAt: 100_000,
    now: () => 100_000 + elapsed,
    async runRound() {
      round += 1;
      return {
        content: round === 1 ? "第一轮仍缺证据。" : "结论：第二轮已完成证据闭环。",
        evidenceGaps: round === 1 ? ["仍缺第二处调用"] : [],
        toolRecords: [{
          id: `boundary-${elapsed}-${round}`,
          name: "query",
          args: JSON.stringify({ query: `boundary-${elapsed}-${round}` }),
          content: `boundary evidence ${round}`,
          status: "success",
        }],
      };
    },
    async reviewFinal({ content }) {
      return content.startsWith("结论：")
        ? resolved(content)
        : unresolved("仍缺第二处调用");
    },
  });
}

const exactBoundary = await runAtBoundary(180_000);
assert.equal(exactBoundary.exitReason, "resolved");
assert.equal(exactBoundary.rounds, 2, "恰好三分钟仍必须允许下一轮核实");

const outsideBoundary = await runAtBoundary(180_001);
assert.equal(outsideBoundary.exitReason, "protection-window-elapsed");
assert.equal(outsideBoundary.rounds, 1, "严格超过三分钟后的下一次证据不足判定应退出");

const hardLimit = await runAtBoundary(480_000);
assert.equal(hardLimit.exitReason, "hard-limit");
assert.equal(hardLimit.rounds, 1, "达到八分钟硬上限后不能再启动下一轮");

let fixedTimerRound = 0;
const elapsedByRound = [60_000, 179_999, 180_001];
const fixedTimerResult = await runAutoVerificationLoop({
  startedAt: 1_000_000,
  now: () => 1_000_000 + (elapsedByRound[fixedTimerRound - 1] ?? 180_001),
  async runRound() {
    fixedTimerRound += 1;
    return {
      content: `第 ${fixedTimerRound} 轮仍缺证据。`,
      evidenceGaps: ["仍缺下游消费者"],
      toolRecords: [{
        id: `fixed-timer-${fixedTimerRound}`,
        name: "query",
        args: JSON.stringify({ query: `new-scope-${fixedTimerRound}` }),
        content: `new evidence ${fixedTimerRound}`,
        status: "success",
      }],
    };
  },
  async reviewFinal() {
    return unresolved("仍缺下游消费者");
  },
});
assert.equal(fixedTimerResult.exitReason, "protection-window-elapsed");
assert.equal(fixedTimerResult.rounds, 3, "续查轮次不能刷新本次提问的计时起点");

const normalizedNameCorrections: boolean[] = [];
const normalizedNameResult = await runAutoVerificationLoop({
  startedAt: 0,
  now: () => 1_000,
  async runRound(context) {
    normalizedNameCorrections.push(context.correction);
    return {
      content: "仍缺少新证据。",
      evidenceGaps: ["需要新的调用点"],
      toolRecords: [{
        id: `normalized-name-${context.round}`,
        name: context.round === 1 ? " query " : "QUERY",
        args: JSON.stringify({ query: "same-call" }),
        content: "same evidence",
        status: "success",
      }],
    };
  },
  async reviewFinal() {
    return unresolved("需要新的调用点");
  },
});
assert.equal(normalizedNameResult.exitReason, "no-progress");
assert.deepEqual(
  normalizedNameCorrections,
  [false, false, true],
  "工具名大小写或首尾空白变化不能伪装成新证据",
);

let continuationBlockedRounds = 0;
const continuationBlockedResult = await runAutoVerificationLoop({
  startedAt: 0,
  now: () => 1_000,
  canContinue: () => false,
  async runRound() {
    continuationBlockedRounds += 1;
    return {
      content: "已基于达到上限前的证据完成恢复总结。",
      evidenceGaps: ["仍有缺口"],
      toolRecords: [{
        id: "guard-limit-evidence",
        name: "query",
        args: "{}",
        content: "last evidence",
        status: "success",
      }],
    };
  },
  async reviewFinal() {
    return unresolved("仍有缺口");
  },
});
assert.equal(continuationBlockedResult.exitReason, "passthrough");
assert.equal(continuationBlockedRounds, 1, "全局工具保护达限后不得再启动续查轮次");

let hardLimitNow = 0;
let hardLimitAbortObserved = false;
let hardLimitReviewCalls = 0;
const hardDeadlineResult = await runAutoVerificationLoop({
  startedAt: 0,
  now: () => hardLimitNow,
  async runRound() {
    hardLimitNow = AUTO_VERIFICATION_HARD_LIMIT_MS - 5;
    return {
      content: "八分钟截止前仍缺少证据。",
      evidenceGaps: ["仍缺证据"],
      toolRecords: [{
        id: "hard-deadline-evidence",
        name: "query",
        args: JSON.stringify({ query: "hard-deadline" }),
        content: "partial evidence",
        status: "success",
      }],
    };
  },
  async reviewFinal({ signal }) {
    hardLimitReviewCalls += 1;
    signal.addEventListener("abort", () => {
      hardLimitAbortObserved = true;
    }, { once: true });
    return new Promise<FinalReplyResolutionResult>(() => {});
  },
});
assert.equal(hardDeadlineResult.exitReason, "hard-limit");
assert.equal(hardLimitReviewCalls, 1);
assert.equal(hardLimitAbortObserved, true, "运行中的最终评审必须在八分钟截止时收到取消信号");

const modelError = unresolved("最终回复模型评审失败：HTTP 429");
modelError.source = "error";
modelError.answer = "最终回复模型评审失败：HTTP 429";
let errorRounds = 0;
const modelErrorResult = await runAutoVerificationLoop({
  startedAt: 0,
  now: () => 1_000,
  async runRound() {
    errorRounds += 1;
    return {
      content: "阶段性候选",
      evidenceGaps: [],
      toolRecords: [{
        id: "error-path-evidence",
        name: "query",
        args: "{}",
        content: "evidence",
        status: "success",
      }],
    };
  },
  async reviewFinal() {
    return modelError;
  },
});
assert.equal(modelErrorResult.exitReason, "passthrough");
assert.equal(errorRounds, 1, "真实模型错误必须立即退出，不进入三分钟续查");

const humanLoopResolution = unresolved("需要用户提供生产环境外部信息");
humanLoopResolution.action = "human_loop";
let humanLoopRounds = 0;
const humanLoopResult = await runAutoVerificationLoop({
  startedAt: 0,
  now: () => 1_000,
  async runRound() {
    humanLoopRounds += 1;
    return {
      content: "需要用户提供生产环境外部信息。",
      evidenceGaps: ["生产环境外部信息"],
      toolRecords: [{
        id: "human-loop-evidence",
        name: "query",
        args: "{}",
        content: "现有工具无法访问该外部信息",
        status: "success",
      }],
    };
  },
  async reviewFinal() {
    return humanLoopResolution;
  },
});
assert.equal(humanLoopResult.exitReason, "passthrough");
assert.equal(humanLoopRounds, 1, "Human Loop 必须立即退出，不等待三分钟");

console.log("auto verification loop 验证通过");
