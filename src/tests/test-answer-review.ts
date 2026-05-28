import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createReviewedAgent, enforceFinalAnswerCompleteness, parseAnswerReviewResult } from "../graph.js";
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
const passAgent = createReviewedAgent({
  async *stream() {
    passCalls += 1;
    yield [new AIMessage("已验证结论"), {}];
  },
}, {
  maxReviewRounds: 2,
  reviewer: async (): Promise<AnswerReviewResult> => ({
    passed: true,
    status: "passed",
    reason: "通过",
    issues: [],
    correction_instruction: "",
  }),
});

const passOutputs = await collect(passAgent);
assert.equal(passCalls, 1);
assert.equal(passOutputs.length, 1);
assert.equal(getText(passOutputs[0]![0]), "已验证结论");
assert.equal((passOutputs[0]![1] as any).answerReview.final, true);

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
assert.equal(reviewCalls, 1);
assert.equal(correctionOutputs.length, 2);
assert.equal(getText(correctionOutputs[0]![0]), "正在补齐回答依据，继续核实中。");
assert.equal((correctionOutputs[0]![1] as any).answerReview.resetContent, true);
assert.equal(getText(correctionOutputs[1]![0]), "已核实接口逻辑，结论是 B");
assert.equal((correctionOutputs[1]![1] as any).answerReview.final, true);
assert.equal(
  correctionOutputs.some(([message]) => getText(message) === "可能是 A"),
  false,
  "failed draft answer should not be streamed before review passes",
);
assert.equal(
  correctionOutputs.some(([message]) => getText(message).includes("审核未通过") || getText(message).includes("审核发现")),
  false,
  "review result text should not be visible to users",
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
assert.equal(maxRoundCalls, 2);
assert.ok(maxRoundOutputs.length > 0);
assert.equal(getText(maxRoundOutputs[maxRoundOutputs.length - 1]![0]), "第 2 版回答");
assert.equal(
  maxRoundOutputs.some(([message]) => getText(message).includes("审核未通过")),
  false,
  "final result should come from business node after one correction",
);

console.log("answer review 循环审核验证通过");
