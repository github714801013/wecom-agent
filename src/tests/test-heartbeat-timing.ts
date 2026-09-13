import { buildIntermediateStreamContent, buildThinkingHeartbeatContent, formatElapsedDuration } from "../progress-updates.js";

// 1. 心跳用时后缀必须保留
const heartbeatLine = buildThinkingHeartbeatContent("", [], Date.now(), Date.now() - 90 * 1000);
const passed = buildIntermediateStreamContent(heartbeatLine);
if (!passed.includes("已用时")) {
  throw new Error(`心跳用时丢失: input=${JSON.stringify(heartbeatLine)} output=${JSON.stringify(passed)}`);
}
console.log("PASS: 心跳用时后缀保留 →", passed);

// 2. formatElapsedDuration 格式
const s90 = formatElapsedDuration(0, 90 * 1000);
if (s90 !== "1分30秒") throw new Error(`期望 1分30秒 实际 ${s90}`);
const s30 = formatElapsedDuration(0, 30 * 1000);
if (s30 !== "30秒") throw new Error(`期望 30秒 实际 ${s30}`);
const s60 = formatElapsedDuration(0, 60 * 1000);
if (s60 !== "1分") throw new Error(`期望 1分 实际 ${s60}`);
console.log("PASS: formatElapsedDuration →", s90, s30, s60);

// 3. 无 frame 的模型中间内容仍正常加 frame
const plain = buildIntermediateStreamContent("已经找到订单服务入口，正在确认调用链。");
if (!/^[◐◓◑◒] /.test(plain)) {
  throw new Error(`普通内容处理异常: ${JSON.stringify(plain)}`);
}
console.log("PASS: 普通内容仍加处理帧 →", plain);

console.log("全部验证通过");
