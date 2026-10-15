import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { HumanMessage } from "@langchain/core/messages";
import { createPiCodingAgentFacade, resetPiCodingAgentSession } from "../pi-coding-agent-runtime.js";

const requests: Array<{ tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string; content?: unknown }> }> = [];
let toolCalls = 0;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body || "{}");
  requests.push(parsed);
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (requests.length === 1) {
    res.write(`data: ${JSON.stringify({
      id: "one",
      model: "fixture",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "fixture_tool", arguments: JSON.stringify({ value: 1 }) } }],
        },
        finish_reason: "tool_calls",
      }],
    })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({
      id: "two",
      model: "fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: "最终结论" }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: "two",
      model: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
    })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const options = {
  systemPrompt: "只可使用已注册工具",
  model: "fixture",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  apiKey: "fixture-key",
  contextWindow: 128_000,
  sessionKey: "native-session-fixture",
  tools: [{
    name: "fixture_tool",
    description: "fixture",
    schema: { type: "object", properties: { value: { type: "number" } } },
    invoke: async () => {
      toolCalls += 1;
      return "repo=fixture file=src/a.ts line=1 evidence=ok";
    },
  }],
};

const facade = createPiCodingAgentFacade(options);
const events = [];
for await (const event of facade.streamPiEvents(
  "测试工具调用",
  { deadlineMs: 30_000 },
  [new HumanMessage("已有历史上下文")],
)) events.push(event);
assert.equal(toolCalls, 1, "Pi 原生 AgentSession 必须执行现有 MCP direct tool");
const end = events.find(event => event.type === "agent_end");
assert.ok(end && end.messages.some(message => message.role === "assistant" && message.stopReason === "stop"));
const firstTools = requests[0]?.tools?.map(tool => tool.function?.name) || [];
assert.deepEqual(firstTools, ["fixture_tool"], "模型只能看到白名单 direct tool");
assert.equal(requests.length, 2, "工具轮次后应继续模型并正常完成");
assert.ok(
  requests[0]?.messages?.some(message => message.role === "user" && String(message.content).includes("已有历史上下文")),
  "已有会话上下文必须进入升级后 SDK 的 canonical SessionManager 投影",
);

resetPiCodingAgentSession(options.sessionKey);
server.close();
await once(server, "close");

// 连续瞬态连接失败后，主路径必须在同一会话内重试并完成。
let retryServerRequestCount = 0;
const retryServer = http.createServer((_req, res) => {
  retryServerRequestCount += 1;
  if (retryServerRequestCount <= 3) {
    _req.socket.destroy();
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({
    id: "retry-success",
    model: "fixture",
    choices: [{ delta: { role: "assistant", content: "重试后完成" }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: "retry-success",
    model: "fixture",
    choices: [{ delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  res.end("data: [DONE]\n\n");
});
retryServer.listen(0, "127.0.0.1");
await once(retryServer, "listening");
const retryAddress = retryServer.address();
assert.ok(retryAddress && typeof retryAddress === "object");
const retryFacade = createPiCodingAgentFacade({
  systemPrompt: "只可使用已注册工具",
  model: "fixture",
  baseUrl: `http://127.0.0.1:${retryAddress.port}/v1`,
  apiKey: "fixture-key",
  contextWindow: 128_000,
  sessionKey: "native-session-retry-fixture",
  tools: [],
});
const retryEvents = [];
let retryError: unknown;
try {
  for await (const event of retryFacade.streamPiEvents("测试瞬态连接重试", { deadlineMs: 30_000 })) {
    retryEvents.push(event);
  }
} catch (error) {
  retryError = error;
}
assert.equal(retryError, undefined, "瞬态连接失败重试后应完成同一轮模型调用");
assert.equal(retryServerRequestCount, 4, "最多 3 次重试后应使用第 4 次请求完成");
assert.equal(
  retryEvents.filter(event => event.type === "agent_end").length,
  1,
  "重试过程不得向 facade 暴露中间失败终态",
);
assert.ok(
  retryEvents.some(event => event.type === "agent_end" && event.messages.some(message => message.role === "assistant" && message.stopReason === "stop")),
  "重试成功后必须保留 agent_end(stop) 终态",
);
resetPiCodingAgentSession("native-session-retry-fixture");
retryServer.close();
await once(retryServer, "close");

let exhaustedRequestCount = 0;
const exhaustedServer = http.createServer((_req, res) => {
  exhaustedRequestCount += 1;
  _req.socket.destroy();
});
exhaustedServer.listen(0, "127.0.0.1");
await once(exhaustedServer, "listening");
const exhaustedAddress = exhaustedServer.address();
assert.ok(exhaustedAddress && typeof exhaustedAddress === "object");
const exhaustedFacade = createPiCodingAgentFacade({
  systemPrompt: "只可使用已注册工具",
  model: "fixture",
  baseUrl: `http://127.0.0.1:${exhaustedAddress.port}/v1`,
  apiKey: "fixture-key",
  contextWindow: 128_000,
  sessionKey: "native-session-exhausted-fixture",
  tools: [],
});
const exhaustedEvents = [];
for await (const event of exhaustedFacade.streamPiEvents("测试重试耗尽", { deadlineMs: 30_000 })) {
  exhaustedEvents.push(event);
}
assert.equal(exhaustedRequestCount, 4, "持续瞬态失败时最多允许首次请求加 3 次重试");
assert.ok(
  exhaustedEvents.some(event => event.type === "agent_end" && event.messages.some(message => message.role === "assistant" && message.stopReason === "error")),
  "重试耗尽后必须保留 error 终态供现有失败处理路径消费",
);
resetPiCodingAgentSession("native-session-exhausted-fixture");
exhaustedServer.close();
await once(exhaustedServer, "close");

let deadlineRequestCount = 0;
let resolveDeadlineFailureRequest: (() => void) | undefined;
const deadlineFailureReceived = new Promise<void>(resolve => { resolveDeadlineFailureRequest = resolve; });
const deadlineServer = http.createServer((_req, res) => {
  deadlineRequestCount += 1;
  if (deadlineRequestCount > 1) {
    resolveDeadlineFailureRequest?.();
    _req.socket.destroy();
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({
    id: "deadline-warmup",
    model: "fixture",
    choices: [{ delta: { role: "assistant", content: "预热完成" }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: "deadline-warmup",
    model: "fixture",
    choices: [{ delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  res.end("data: [DONE]\n\n");
});
deadlineServer.listen(0, "127.0.0.1");
await once(deadlineServer, "listening");
const deadlineAddress = deadlineServer.address();
assert.ok(deadlineAddress && typeof deadlineAddress === "object");
const deadlineFacade = createPiCodingAgentFacade({
  systemPrompt: "只可使用已注册工具",
  model: "fixture",
  baseUrl: `http://127.0.0.1:${deadlineAddress.port}/v1`,
  apiKey: "fixture-key",
  contextWindow: 128_000,
  sessionKey: "native-session-deadline-fixture",
  tools: [],
});
for await (const _event of deadlineFacade.streamPiEvents("预热复用会话", { deadlineMs: 30_000 })) {}
assert.equal(deadlineRequestCount, 1, "截止时间探针必须先完成会话预热");
const deadlineMs = 700;
const deadlineStartedAt = Date.now();
const deadlineRun = (async () => {
  for await (const _event of deadlineFacade.streamPiEvents("退避中达到截止时间", { deadlineMs })) {}
})();
const failureReached = await Promise.race([
  deadlineFailureReceived.then(() => true),
  new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
]);
assert.equal(failureReached, true, "预热后的首次瞬态失败必须在请求截止时间前到达退避探针");
assert.ok(Date.now() - deadlineStartedAt < deadlineMs, "首次失败必须先于请求截止时间");
await deadlineRun;
assert.equal(deadlineRequestCount, 2, "请求截止时间在首次失败退避期间到达后不得发起重试");
resetPiCodingAgentSession("native-session-deadline-fixture");
deadlineServer.close();
await once(deadlineServer, "close");

let invalidRequestCount = 0;
const invalidRequestServer = http.createServer((_req, res) => {
  invalidRequestCount += 1;
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({
    error: { message: "invalid request", type: "invalid_request_error", code: "invalid_request_error" },
  }));
});
invalidRequestServer.listen(0, "127.0.0.1");
await once(invalidRequestServer, "listening");
const invalidRequestAddress = invalidRequestServer.address();
assert.ok(invalidRequestAddress && typeof invalidRequestAddress === "object");
const invalidRequestFacade = createPiCodingAgentFacade({
  systemPrompt: "只可使用已注册工具",
  model: "fixture",
  baseUrl: `http://127.0.0.1:${invalidRequestAddress.port}/v1`,
  apiKey: "fixture-key",
  contextWindow: 128_000,
  sessionKey: "native-session-invalid-request-fixture",
  tools: [],
});
for await (const _event of invalidRequestFacade.streamPiEvents("测试不可重试错误", { deadlineMs: 30_000 })) {}
assert.equal(invalidRequestCount, 1, "确定性 400 错误不得进行瞬态错误重试");
resetPiCodingAgentSession("native-session-invalid-request-fixture");
invalidRequestServer.close();
await once(invalidRequestServer, "close");
console.log("Pi 原生 AgentSession 主路径验证通过");
