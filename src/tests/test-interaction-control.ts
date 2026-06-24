import { strict as assert } from "node:assert";
import {
  buildFollowupQuestion,
  buildQuestionWithHistory,
  detectActiveMessageIntent,
  extractConfirmedAnchorsFromHistory,
} from "../interaction-control.js";

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

const longHistoricalEvidence = [
  { role: "user" as const, content: "保护膜详情，点立即购买提示已超过复购时间，帮我看后端接口" },
  {
    role: "system" as const,
    content: `【本轮工具上下文摘要】 有效工具证据: ${"无关摘要 ".repeat(90)}
code_snippet repo=oa-api filePath=oaapi-service/src/main/java/com/jiuji/oaapi/service/impl/SubServiceImpl.java method=checkYearPackageRepurchase`,
  },
  {
    role: "assistant" as const,
    content: `已读取 checkYearPackageRepurchase 和 getYearPackageInfo 源码，但这两个方法分别处理复购提醒和商品匹配，并非"已超过复购时间"提示的直接来源。
${"已读取候选文件，继续核实中。".repeat(60)}
第二次检索命中了关键线索：oa-after 仓库 SmallproFilmCardServiceImpl.java 中的 repurchaseBuyTime（743行）和 repurchaseBuyExpireMsg（760行），提示文案为“贴膜 年包服务 1年2次 已超过复购时间！”。`,
  },
];
const confirmedAnchors = extractConfirmedAnchorsFromHistory(longHistoricalEvidence);
assert.ok(confirmedAnchors.includes("oa-after"));
assert.ok(confirmedAnchors.includes("oa-api"));
assert.ok(confirmedAnchors.includes("SmallproFilmCardServiceImpl.java"));
assert.ok(confirmedAnchors.includes("SubServiceImpl.java"));
assert.ok(confirmedAnchors.includes("repurchaseBuyTime"));
assert.ok(confirmedAnchors.includes("repurchaseBuyExpireMsg"));
assert.ok(confirmedAnchors.some(anchor => anchor.includes("已超过复购时间")));

const filmFollowup = buildQuestionWithHistory(longHistoricalEvidence, "点 立即购买按钮 提示的 重点看这个后端接口");
assert.match(filmFollowup, /已确认锚点清单/);
assert.match(filmFollowup, /优先锚点/);
assert.match(filmFollowup, /旁证\/已排除锚点/);
assert.match(filmFollowup, /SmallproFilmCardServiceImpl\.java/);
assert.match(filmFollowup, /repurchaseBuyTime/);
assert.match(filmFollowup, /repurchaseBuyExpireMsg/);
assert.match(filmFollowup, /已超过复购时间/);
assert.match(filmFollowup, /历史里标记为“关键线索、确切来源、直接来源、重点看”的内容视为本轮有效证据/);
assert.match(filmFollowup, /不得作为主结论/);

const wuliuCurlQuestion = `curl 'https://oawcf2.ch999.cn/kcApi/doSendWuLiu' \\
 -H 'Content-Type: application/x-www-form-urlencoded' \\
 --data-raw 'wlcount=1&pwd=B9BA924BFCBFDA49850372CA35FDC100&area=YNws3&ch999id=2761&wlCompany=shunfeng&nextAreaId=0&boxNumber=&expressCategory=&parcelValue=&wlIds=42836554&wlNum=&clientNo=' \\
 --compressed`;
const wuliuFollowup = buildQuestionWithHistory(
  [
    { role: "user", content: wuliuCurlQuestion },
    { role: "assistant", content: "已确认接口路径和请求参数，需要继续查 doSendWuLiu 的默认顺丰产品类型。" },
  ],
  "这个提交顺丰物流单，默认是标快还是特快",
);
const wuliuAnchors = extractConfirmedAnchorsFromHistory([
  { role: "user", content: wuliuCurlQuestion },
  { role: "assistant", content: "已确认接口路径 https://oawcf2.ch999.cn/kcApi/doSendWuLiu 和参数 wlCompany=shunfeng、expressCategory=。" },
]);
assert.ok(
  wuliuAnchors.includes("https://oawcf2.ch999.cn/kcApi/doSendWuLiu"),
  "curl 完整 URL 必须进入强锚点",
);
assert.ok(
  wuliuAnchors.includes("/kcApi/doSendWuLiu") || wuliuAnchors.includes("kcApi/doSendWuLiu"),
  "curl URL 路径必须进入强锚点",
);
assert.ok(wuliuAnchors.includes("wlCompany=shunfeng"), "关键 form 参数 wlCompany 必须进入强锚点");
assert.ok(wuliuAnchors.includes("expressCategory="), "空值 form 参数 expressCategory 必须进入强锚点");
assert.ok(wuliuAnchors.includes("wlIds=42836554"), "物流单 ID 参数必须进入强锚点");
assert.ok(!wuliuAnchors.some(anchor => anchor.startsWith("pwd=")), "敏感参数 pwd 不应进入强锚点");
assert.match(wuliuFollowup, /kcApi\/doSendWuLiu/);
assert.match(wuliuFollowup, /wlCompany=shunfeng/);
assert.match(wuliuFollowup, /expressCategory=/);

console.log("interaction control 验证通过");
