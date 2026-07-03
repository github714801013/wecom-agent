import assert from "node:assert/strict";
import { buildBlockedFinalHumanLoopRequest, resolveFinalReplyDelivery } from "../wecom-adapter.js";
import type { FinalReplyResolutionResult } from "../runtime-todolist.js";

function unresolvedFinal(reason = "候选仍是阶段性进度"): FinalReplyResolutionResult {
  return {
    ready: false,
    action: "continue",
    answer: "我会继续核实，这不是最终结论。",
    reason,
    source: "unresolved",
    review: { ready: false, action: "continue", reason },
  };
}

const blockedInput = {
  content: "我会继续围绕现有锚点核实 jingdongproductconfig 表中 sku_id 字段、JdProductConfig 实体类和 Mapper 映射。截图里已经能看到 51098VEP 这类含字母的值。",
  finalResolution: unresolvedFinal(),
  humanLoopReply: null,
  userQuestion: "这个是因为哪个字段出问题了",
};
const blocked = resolveFinalReplyDelivery(blockedInput);

assert.equal(blocked.shouldSendFinal, true, "最终闸门未通过且无法转 human loop 时也要发送兜底 final，避免企微停留在处理中");
assert.match(blocked.content, /没有查到足够完整的证据/);
assert.match(blocked.content, /当前阶段性判断/);
assert.match(blocked.content, /sku_id 字段/);
assert.match(blocked.content, /回复“继续”/);
assert.doesNotMatch(blocked.content, /最终回复闸门|候选回答|卡住原因|我会继续/);
assert.match(blocked.reason, /候选仍是阶段性进度/);

const blockedHumanLoop = buildBlockedFinalHumanLoopRequest(blockedInput);
assert.equal(blockedHumanLoop.contextSnapshot.userQuestion, "这个是因为哪个字段出问题了");
assert.match(blockedHumanLoop.question || "", /回复“继续”/);
assert.match(blockedHumanLoop.resumeInstruction, /继续排查/);

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
