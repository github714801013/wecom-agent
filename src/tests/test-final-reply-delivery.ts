import assert from "node:assert/strict";
import { resolveFinalReplyDelivery } from "../wecom-adapter.js";
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

const blocked = resolveFinalReplyDelivery({
  content: "我会继续核实，这不是最终结论。",
  finalResolution: unresolvedFinal(),
  humanLoopReply: null,
});

assert.equal(blocked.shouldSendFinal, false, "最终闸门未通过且无法转 human loop 时不能发送 final");
assert.equal(blocked.content, "");
assert.match(blocked.reason, /候选仍是阶段性进度/);

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
