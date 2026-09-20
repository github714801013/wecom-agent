import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createPiCodingAgentFacade, resetPiCodingAgentSession } from "../pi-coding-agent-runtime.js";

const requests: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
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
for await (const event of facade.streamPiEvents("测试工具调用", { deadlineMs: 30_000 })) events.push(event);
assert.equal(toolCalls, 1, "Pi 原生 AgentSession 必须执行现有 MCP direct tool");
const end = events.find(event => event.type === "agent_end");
assert.ok(end && end.messages.some(message => message.role === "assistant" && message.stopReason === "stop"));
const firstTools = requests[0]?.tools?.map(tool => tool.function?.name) || [];
assert.deepEqual(firstTools, ["fixture_tool"], "模型只能看到白名单 direct tool");
assert.equal(requests.length, 2, "工具轮次后应继续模型并正常完成");

resetPiCodingAgentSession(options.sessionKey);
server.close();
await once(server, "close");
console.log("Pi 原生 AgentSession 主路径验证通过");
