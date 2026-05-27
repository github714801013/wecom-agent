import { strict as assert } from "node:assert";
import { buildFollowupQuestion, buildQuestionWithHistory, detectActiveMessageIntent } from "../interaction-control.js";

assert.equal(detectActiveMessageIntent("kill"), "stop");
assert.equal(detectActiveMessageIntent("停止"), "stop");
assert.equal(detectActiveMessageIntent("@OA智能助手 别查了"), "stop");

assert.equal(detectActiveMessageIntent("继续"), "continue_current");
assert.equal(detectActiveMessageIntent("接着查"), "continue_current");

assert.equal(detectActiveMessageIntent("那国补订单呢"), "replace_with_followup");
assert.equal(detectActiveMessageIntent("换成 C# 项目查这个接口"), "replace_with_followup");

const merged = buildFollowupQuestion("梳理 SaveSubCustomAddressV2 快递方式变更逻辑", "那良品单呢");
assert.match(merged, /原问题：\n梳理 SaveSubCustomAddressV2 快递方式变更逻辑/);
assert.match(merged, /用户追问：\n那良品单呢/);
assert.match(merged, /先整合成同一个问题再继续回答/);

const withHistory = buildQuestionWithHistory(
  [
    { role: "user", content: "梳理 SaveSubCustomAddressV2 快递方式变更逻辑" },
    { role: "assistant", content: "已确认 deliveryMethod=1 到店自取，2 送货上门。" },
  ],
  "那良品单呢",
);
assert.match(withHistory, /历史上下文整合/);
assert.match(withHistory, /相关历史：/);
assert.match(withHistory, /当前问题：\n那良品单呢/);
assert.match(withHistory, /先结合“相关历史”和“当前问题”整合成一个明确问题/);
assert.match(withHistory, /已确认锚点必须优先继承/);
assert.match(withHistory, /不要重新放宽到其它项目、其它技术栈或宽泛业务词/);

const anchoredFollowup = buildQuestionWithHistory(
  [
    { role: "user", content: "核销金额不等于商品的总金额 这个提示在哪个项目" },
    { role: "assistant", content: "项目：oa-stock；入口文件：WuLiuController.java；保存接口：/add-or-update/v1；符号：AddOrUpdateV1。" },
  ],
  "深入梳理这个接口的逻辑, 排查是什么原因导致金额不相等",
);
assert.match(anchoredFollowup, /项目：oa-stock/);
assert.match(anchoredFollowup, /保存接口：\/add-or-update\/v1/);
assert.match(anchoredFollowup, /符号：AddOrUpdateV1/);
assert.match(anchoredFollowup, /已确认锚点必须优先继承/);

console.log("interaction control 验证通过");
