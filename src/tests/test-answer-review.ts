import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createReviewedAgent, enforceFinalAnswerCompleteness, getConfiguredMaxReviewRounds, parseAnswerReviewResult } from "../graph.js";
import type { AnswerReviewResult } from "../graph.js";

function getText(message: unknown) {
  return String((message as any)?.content ?? "");
}

assert.deepEqual(
  parseAnswerReviewResult(JSON.stringify({
    passed: true,
    status: "passed",
    reason: "证据充分",
    issues: [],
    correction_instruction: "",
  })),
  {
    passed: true,
    status: "passed",
    reason: "证据充分",
    issues: [],
    correction_instruction: "",
  },
);

const invalidReview = parseAnswerReviewResult("not json");
assert.equal(invalidReview.passed, false);
assert.equal(invalidReview.status, "needs_correction");
assert.ok(invalidReview.issues.length > 0);

const progressOnlyReview = enforceFinalAnswerCompleteness(
  {
    passed: true,
    status: "passed",
    reason: "模型误判通过",
    issues: [],
    correction_instruction: "",
  },
  "已读取到移动端支付押金按钮，继续核实中。",
);
assert.equal(progressOnlyReview.passed, false);
assert.equal(progressOnlyReview.status, "needs_correction");
assert.match(progressOnlyReview.reason, /阶段性进度/);

const completeReview = enforceFinalAnswerCompleteness(
  {
    passed: true,
    status: "passed",
    reason: "通过",
    issues: [],
    correction_instruction: "",
  },
  "备用机押金支付支持 alipay 和 weixin，其他支付方式会报支付接口错误。\n\n【定位依据】已核实后端 payport 分支。",
);
assert.equal(completeReview.passed, true);

async function collect(agent: ReturnType<typeof createReviewedAgent>) {
  const outputs: Array<[unknown, any]> = [];
  const stream = await agent.stream({ messages: [new HumanMessage("问题")] }, { streamMode: "messages" });
  for await (const item of stream) {
    outputs.push(item as [unknown, any]);
  }
  return outputs;
}

let passCalls = 0;
let passReviewCalls = 0;
const passAgent = createReviewedAgent({
  async *stream() {
    passCalls += 1;
    yield [new AIMessage("已验证结论"), {}];
  },
}, {
  maxReviewRounds: 2,
  reviewer: async (): Promise<AnswerReviewResult> => {
    passReviewCalls += 1;
    return {
      passed: true,
      status: "passed",
      reason: "证据充分",
      issues: [],
      correction_instruction: "",
    };
  },
});

const passOutputs = await collect(passAgent);
assert.equal(passCalls, 1);
assert.equal(passReviewCalls, 1);
assert.equal(passOutputs.length, 1);
assert.equal(getText(passOutputs[0]![0]), "已验证结论");

const originalReviewRounds = process.env.ANSWER_REVIEW_MAX_ROUNDS;
delete process.env.ANSWER_REVIEW_MAX_ROUNDS;
assert.equal(getConfiguredMaxReviewRounds(), 5, "未配置时默认应允许 5 轮自主查证");
let defaultRoundCalls = 0;
const defaultRoundAgent = createReviewedAgent({
  async *stream() {
    defaultRoundCalls += 1;
    yield [new AIMessage(`默认第 ${defaultRoundCalls} 轮`), {}];
  },
}, {
  reviewer: async (): Promise<AnswerReviewResult> => defaultRoundCalls < 5
    ? {
        passed: false,
        status: "needs_correction",
        reason: "仍有可自主核实路径",
        issues: ["代码调用链尚未查完"],
        correction_instruction: "继续使用现有工具补齐证据",
      }
    : {
        passed: true,
        status: "passed",
        reason: "第五轮证据闭环",
        issues: [],
        correction_instruction: "",
      },
});
const defaultRoundOutputs = await collect(defaultRoundAgent);
assert.equal(defaultRoundCalls, 5, "默认配置不得在第 2 轮提前结束自主查证");
assert.equal(getText(defaultRoundOutputs[defaultRoundOutputs.length - 1]![0]), "默认第 5 轮");
if (originalReviewRounds === undefined) {
  delete process.env.ANSWER_REVIEW_MAX_ROUNDS;
} else {
  process.env.ANSWER_REVIEW_MAX_ROUNDS = originalReviewRounds;
}

let correctionCalls = 0;
let reviewCalls = 0;
const correctionAgent = createReviewedAgent({
  async *stream() {
    correctionCalls += 1;
    yield [new AIMessage(correctionCalls === 1 ? "可能是 A" : "已核实接口逻辑，结论是 B"), {}];
  },
}, {
  maxReviewRounds: 2,
  reviewer: async (): Promise<AnswerReviewResult> => {
    reviewCalls += 1;
    return reviewCalls === 1
      ? {
          passed: false,
          status: "needs_correction",
          reason: "结论缺少证据",
          issues: ["使用了可能性表达"],
          correction_instruction: "带着接口锚点继续核实后给出确定结论",
        }
      : {
          passed: true,
          status: "passed",
          reason: "通过",
          issues: [],
          correction_instruction: "",
        };
  },
});

const correctionOutputs = await collect(correctionAgent);
assert.equal(correctionCalls, 2);
assert.equal(reviewCalls, 2);
assert.equal(getText(correctionOutputs[0]![0]), "可能是 A");
const correctionReset = correctionOutputs.find(([, metadata]) => metadata?.answerReview?.resetContent);
assert.ok(correctionReset, "自动纠正轮开始前必须通知企微覆盖上一版内容");
assert.equal(correctionReset?.[1]?.answerReview?.progress, true);
assert.match(getText(correctionReset?.[0]), /自动补查/);
assert.equal(getText(correctionOutputs[correctionOutputs.length - 1]![0]), "已核实接口逻辑，结论是 B");
assert.equal(
  correctionOutputs.some(([message], index) => index !== correctionOutputs.indexOf(correctionReset!) && getText(message).includes("审核未通过")),
  false,
  "审核详情只能作为下一轮内部输入，不得混入普通回答流",
);

let maxRoundCalls = 0;
const maxRoundAgent = createReviewedAgent({
  async *stream() {
    maxRoundCalls += 1;
    yield [new AIMessage(`第 ${maxRoundCalls} 版回答`), {}];
  },
}, {
  maxReviewRounds: 2,
  reviewer: async (): Promise<AnswerReviewResult> => ({
    passed: false,
    status: "needs_correction",
    reason: "仍缺少 SQL dev 验证证据",
    issues: ["SQL 未验证"],
    correction_instruction: "补充 dev SQL 验证证据",
  }),
});

const maxRoundOutputs = await collect(maxRoundAgent);
assert.equal(maxRoundCalls, 2, "最大审核轮次为 2 时最多执行两轮业务 Agent");
assert.ok(maxRoundOutputs.length > 0);
assert.equal(getText(maxRoundOutputs[maxRoundOutputs.length - 1]![0]), "第 2 版回答");
assert.equal(
  maxRoundOutputs.filter(([, metadata]) => metadata?.answerReview?.resetContent).length,
  1,
  "达到最大轮次后不得继续发起第三轮纠正",
);

let humanLoopCalls = 0;
let humanLoopReviewCalls = 0;
const humanLoopAgent = createReviewedAgent({
  async *stream() {
    humanLoopCalls += 1;
    yield [new AIMessage("需要生产库实际查询结果才能确认。"), {}];
  },
}, {
  maxReviewRounds: 3,
  reviewer: async (): Promise<AnswerReviewResult> => {
    humanLoopReviewCalls += 1;
    return {
      passed: false,
      status: "needs_human_input",
      reason: "缺少只能由用户提供的生产数据",
      issues: ["生产数据不可自主访问"],
      correction_instruction: "请用户提供查询结果",
    };
  },
});

const humanLoopOutputs = await collect(humanLoopAgent);
assert.equal(humanLoopCalls, 1);
assert.equal(humanLoopReviewCalls, 1);
assert.equal(humanLoopOutputs.filter(([, metadata]) => metadata?.answerReview?.resetContent).length, 0);
assert.equal(getText(humanLoopOutputs[humanLoopOutputs.length - 1]![0]), "需要生产库实际查询结果才能确认。");

let timeoutReviewCalls = 0;
let timeoutNow = 0;
const timeoutAgent = createReviewedAgent({
  async *stream() {
    timeoutNow = 301000;
    yield [new AIMessage("耗时较长但已有业务结论"), {}];
  },
}, {
  reviewDeadlineMs: 300000,
  now: () => timeoutNow,
  reviewer: async (): Promise<AnswerReviewResult> => {
    timeoutReviewCalls += 1;
    throw new Error("answer review should be skipped after deadline");
  },
});

const timeoutOutputs = await collect(timeoutAgent);
assert.equal(timeoutReviewCalls, 0);
assert.equal(timeoutOutputs.length, 1);
assert.equal(getText(timeoutOutputs[0]![0]), "耗时较长但已有业务结论");

console.log("answer review 合并业务节点验证通过");
