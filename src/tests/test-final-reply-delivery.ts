import assert from "node:assert/strict";
import { buildBlockedFinalHumanLoopRequest, resolveFinalReplyDelivery } from "../wecom-adapter.js";
import { resolveFinalReplyWithModel, reviewFinalAnswerWithModel } from "../runtime-todolist.js";
import type { FinalReplyResolutionResult } from "../runtime-todolist.js";

function unresolvedFinal(
  reason = "候选仍是阶段性进度",
  action: "continue" | "human_loop" = "continue",
): FinalReplyResolutionResult {
  return {
    ready: false,
    action,
    answer: "我会继续核实，这不是最终结论。",
    reason,
    source: "unresolved",
    review: { ready: false, action, reason },
  };
}

const blockedInput = {
  content: "我会继续围绕现有锚点核实 jingdongproductconfig 表中 sku_id 字段、JdProductConfig 实体类和 Mapper 映射。截图里已经能看到 51098VEP 这类含字母的值。",
  finalResolution: unresolvedFinal(),
  humanLoopReply: null,
  userQuestion: "这个是因为哪个字段出问题了",
};
const blocked = resolveFinalReplyDelivery(blockedInput);

assert.equal(blocked.shouldSendFinal, true, "自动续查达到本轮上限后仍要发送有界兜底，避免企微停留在处理中");
assert.match(blocked.content, /已自动继续核实/);
assert.match(blocked.content, /当前已确认的线索/);
assert.match(blocked.content, /sku_id 字段/);
assert.doesNotMatch(blocked.content, /回复“继续”|回复继续/);
assert.doesNotMatch(blocked.content, /最终回复闸门|候选回答|卡住原因|我会继续/);
assert.match(blocked.reason, /候选仍是阶段性进度/);

const modelErrorReview = await reviewFinalAnswerWithModel({
  question: "模型异常时应返回什么？",
  answer: "阶段性候选回答",
  model: {
    async invoke() {
      throw new Error("HTTP 429 model_cooldown api_key=secret-value");
    },
  },
});
assert.match(
  (modelErrorReview as { errorMessage?: string }).errorMessage || "",
  /最终回复模型评审失败：HTTP 429 model_cooldown/,
  "模型评审异常必须保留脱敏后的真实异常",
);
assert.doesNotMatch(
  (modelErrorReview as { errorMessage?: string }).errorMessage || "",
  /secret-value/,
  "模型评审异常中的敏感信息必须脱敏",
);

const modelErrorResolution = await resolveFinalReplyWithModel({
  question: "模型异常时不应伪装成证据不足",
  answer: "阶段性候选回答",
  streamSnapshots: ["更早的阶段性快照"],
  model: {
    async invoke() {
      throw new Error("HTTP 429 model_cooldown");
    },
  },
});
assert.equal(modelErrorResolution.source, "error");
const modelErrorDelivery = resolveFinalReplyDelivery({
  content: modelErrorResolution.answer,
  finalResolution: modelErrorResolution,
  humanLoopReply: null,
});
assert.equal(modelErrorDelivery.source, "error");
assert.match(modelErrorDelivery.content, /最终回复模型评审失败：HTTP 429 model_cooldown/);
assert.doesNotMatch(modelErrorDelivery.content, /已自动继续核实/);

const humanLoopInput = {
  ...blockedInput,
  content: "需要生产库查询 jingdongproductconfig 表的真实列类型后才能确认。",
  finalResolution: unresolvedFinal("缺少只能由用户提供的生产数据", "human_loop"),
};
const blockedHumanLoop = buildBlockedFinalHumanLoopRequest(humanLoopInput);
assert.equal(blockedHumanLoop.contextSnapshot.userQuestion, "这个是因为哪个字段出问题了");
assert.match(blockedHumanLoop.question || "", /需要你补充/);
assert.doesNotMatch(blockedHumanLoop.question || "", /回复“继续”|回复继续/);
assert.match(blockedHumanLoop.resumeInstruction, /补充缺失信息/);

const sendable = resolveFinalReplyDelivery({
  content: "阶段性候选",
  finalResolution: {
    ready: true,
    action: "send",
    answer: "结论：已完成证据闭环。",
    reason: "可发送",
    source: "candidate",
    review: { ready: true, action: "send", reason: "可发送" },
  },
  humanLoopReply: null,
});

assert.equal(sendable.shouldSendFinal, true);
assert.equal(sendable.content, "结论：已完成证据闭环。");

const humanLoop = resolveFinalReplyDelivery({
  content: "需要补充接口名称",
  finalResolution: unresolvedFinal("需要用户补充"),
  humanLoopReply: "请补充接口名称。",
});

assert.equal(humanLoop.shouldSendFinal, true, "转 human loop 的回复可以作为 final 暂停当前轮次");
assert.equal(humanLoop.content, "请补充接口名称。");

console.log("final reply delivery 验证通过");
