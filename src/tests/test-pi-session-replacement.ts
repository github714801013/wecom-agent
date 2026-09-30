import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createPiCodingAgentFacade, resetPiCodingAgentSession } from "../pi-coding-agent-runtime.js";

const requests: string[] = [];
let firstRequestReceived!: () => void;
const firstRequest = new Promise<void>(resolve => { firstRequestReceived = resolve; });
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  const content = parsed.messages.at(-1)?.content;
  const prompt = typeof content === "string" ? content : content?.map((item: { text?: string }) => item.text || "").join("");
  requests.push(prompt);
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (prompt === "旧问题") {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
    firstRequestReceived();
    return;
  }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: `${prompt}最终结论` }, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const options = {
  systemPrompt: "会话接管测试",
  model: "fixture",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  apiKey: "fixture-key",
  tools: [],
};
const key = "session-replacement-fixture";
const otherKey = "session-replacement-other";
const watchdog = setTimeout(() => { throw new Error("Pi 接管测试未能在 15 秒内完成"); }, 15_000);
const oldController = new AbortController();
const oldIterator = createPiCodingAgentFacade({ ...options, sessionKey: key })
  .streamPiEvents("旧问题", { signal: oldController.signal, deadlineMs: 30_000 });
const drain = async (facade: ReturnType<typeof createPiCodingAgentFacade>, prompt: string, signal?: AbortSignal) => {
  const events = [];
  for await (const event of facade.streamPiEvents(prompt, { ...(signal ? { signal } : {}), deadlineMs: 30_000 })) events.push(event);
  return events;
};
let newest: Promise<Awaited<ReturnType<typeof drain>> | Error> | undefined;
try {
  // 将旧事件消费者暂停在 yield，真实 SDK 正在执行；新 run 必须等旧订阅及 finally 清理结束。
  await oldIterator.next();
  await firstRequest;
  oldController.abort();
  const queuedController = new AbortController();
  const queued = drain(createPiCodingAgentFacade({ ...options, sessionKey: key }), "过期排队问题", queuedController.signal)
    .catch(error => error as Error);
  queuedController.abort();
  newest = drain(createPiCodingAgentFacade({ ...options, sessionKey: key }), "最新问题")
    .catch(error => error as Error);
  const other = await drain(createPiCodingAgentFacade({ ...options, sessionKey: otherKey }), "另一会话");
  assert.ok(other.some(event => event.type === "agent_end"), "不同会话不能被旧 run 的清理阻塞");
  assert.equal(requests.includes("最新问题"), false, "新 run 必须等待旧 run 解除订阅并完成清理");
  assert.equal(requests.includes("过期排队问题"), false, "被取消的排队消息不得调用模型");
  assert.ok(await queued instanceof Error);
  await oldIterator.return(undefined).catch(() => undefined);
  const result = await newest;
  assert.ok(!(result instanceof Error), `接管不能产生 already processing 或被旧 finally 取消：${result}`);
  const end = result.find(event => event.type === "agent_end");
  assert.ok(end && end.messages.some(message => message.role === "assistant" && message.stopReason === "stop"));
  assert.equal(requests.filter(prompt => prompt === "最新问题").length, 1);
} finally {
  clearTimeout(watchdog);
  oldController.abort();
  await oldIterator.return(undefined).catch(() => undefined);
  await newest;
  resetPiCodingAgentSession(key);
  resetPiCodingAgentSession(otherKey);
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}
console.log("Pi 会话取消接管与不同会话隔离验证通过");
