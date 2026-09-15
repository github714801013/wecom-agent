import assert from "node:assert/strict";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { BotConfig } from "../config.js";
import {
  buildPrimaryPiAgentTools,
  extractPiAgentEndContent,
  startBot,
} from "../wecom-adapter.js";

const tools = buildPrimaryPiAgentTools(
  [
    { name: "query", invoke: async () => "ok" },
    { name: "runtime_todolist_update", invoke: async () => "should not be registered" },
  ],
  { name: "original_question_get" },
  { name: "session_memory_graph_query" },
  { name: "tool_result_file_read" },
);
assert.deepEqual(
  tools.map(tool => tool.name),
  ["query", "original_question_get", "session_memory_graph_query", "tool_result_file_read"],
  "主 Pi 工具集合不得注入运行时 Todo 工具",
);
assert.equal(
  tools.some(tool => tool.name === "runtime_todolist_update"),
  false,
);

assert.equal(
  extractPiAgentEndContent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已完成结论" }] }],
  } as any),
  "已完成结论",
  "有效 agent_end(stop) 应直接提供最终内容",
);
assert.equal(
  extractPiAgentEndContent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "阶段性内容" }] }],
  } as any),
  "",
  "非 stop agent_end 不得作为正常最终内容",
);
assert.equal(
  extractPiAgentEndContent({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop", content: [] }],
  } as any),
  "",
  "空 assistant 内容不得作为正常最终内容",
);
for (const stopReason of ["error", "aborted"]) {
  assert.equal(
    extractPiAgentEndContent({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason, content: [{ type: "text", text: "错误或取消文本" }] }],
    } as any),
    "",
    `${stopReason} 生命周期不得作为正常最终内容`,
  );
}

type Listener = (...args: any[]) => void | Promise<void>;

class FakeWsClient {
  readonly listeners = new Map<string, Listener>();
  readonly replies: Array<{ content: string; final: boolean }> = [];

  on(event: string, listener: Listener) {
    this.listeners.set(event, listener);
    return this;
  }

  connect() {
    return this;
  }

  async replyStreamWithCard(_frame: unknown, _streamId: string, content: string, final = false) {
    this.replies.push({ content, final });
    return { errcode: 0 };
  }

  async replyStream(_frame: unknown, _streamId: string, content: string, final = false) {
    this.replies.push({ content, final });
    return { errcode: 0 };
  }

  async replyStreamNonBlocking(_frame: unknown, _streamId: string, content: string, final = false) {
    this.replies.push({ content, final });
    return { errcode: 0 };
  }

  async emitMessage(frame: unknown) {
    const listener = this.listeners.get("message");
    if (!listener) throw new Error("消息处理器未注册");
    await listener(frame);
  }
}

const integrationBot: BotConfig = {
  name: "pi-primary-path-test",
  botId: "pi-primary-path-bot",
  secret: "test-secret",
  wsUrl: "ws://test.invalid",
  mcpHeaders: {},
};
const client = new FakeWsClient();
let registeredTools: Array<{ name?: string }> = [];
let agentInvocation = 0;
await startBot(integrationBot, client as unknown as WSClient, {
  judgeSensitiveRequestByModel: async () => ({ blocked: false, category: null, matchedCredentialTypes: [] }),
  getAllMcpTools: async () => [{ name: "query", invoke: async () => "unused" }],
  initializeAgent: async (tools: any[]) => {
    registeredTools = tools;
    agentInvocation += 1;
    const stopReason = agentInvocation === 1 || agentInvocation === 3 ? "stop" : "toolUse";
    const text = agentInvocation === 3
      ? "<final_answer></final_answer>"
      : stopReason === "stop" ? "Pi 已完成最终结论" : "阶段性内容";
    return {
      async *streamPiEvents() {
        yield {
          type: "turn_start",
        };
        yield {
          type: "agent_end",
          messages: [{
            role: "assistant",
            stopReason,
            content: [{ type: "text", text }],
          }],
        };
      },
    } as any;
  },
} as any);
await client.emitMessage({
  headers: { req_id: "pi-primary-path-request" },
  body: {
    msgid: "pi-primary-path-request",
    msgtype: "text",
    text: { content: "请分析当前逻辑" },
    chattype: "single",
    from: { userid: "pi-primary-path-user" },
  },
});
assert.equal(
  registeredTools.some(tool => tool.name === "runtime_todolist_update"),
  false,
  "主请求不得向 Pi 注册 runtime Todo 工具",
);
assert.equal(
  client.replies.some(reply => reply.final && reply.content.includes("Pi 已完成最终结论")),
  true,
  "有效 agent_end(stop) 应直接发送最终回复",
);
const primaryFinalReply = client.replies.find(reply => reply.final && reply.content.includes("Pi 已完成最终结论"));
assert.match(primaryFinalReply?.content || "", /本次耗时/, "最终回复必须给出本次实际耗时");
const finalReplyCount = client.replies.filter(reply => reply.final).length;
await client.emitMessage({
  headers: { req_id: "pi-primary-path-invalid" },
  body: {
    msgid: "pi-primary-path-invalid",
    msgtype: "text",
    text: { content: "继续分析" },
    chattype: "single",
    from: { userid: "pi-primary-path-invalid-user" },
  },
});
assert.equal(
  client.replies.some(reply => reply.final && reply.content.includes("阶段性内容")),
  false,
  "非 stop 生命周期文本不得作为正常最终回复",
);
assert.equal(
  client.replies.filter(reply => reply.final).length > finalReplyCount,
  true,
  "无效生命周期必须走明确错误终态而非静默结束",
);
const protocolOnlyFinalReplyCount = client.replies.filter(reply => reply.final).length;
await client.emitMessage({
  headers: { req_id: "pi-primary-path-protocol-only" },
  body: {
    msgid: "pi-primary-path-protocol-only",
    msgtype: "text",
    text: { content: "继续分析协议内容" },
    chattype: "single",
    from: { userid: "pi-primary-path-protocol-user" },
  },
});
assert.equal(
  client.replies.some(reply => reply.final && reply.content === "<final_answer></final_answer>"),
  false,
  "协议清理后为空的 agent_end 不得作为正常最终回复发送",
);
assert.ok(
  client.replies.filter(reply => reply.final).length > protocolOnlyFinalReplyCount,
  "协议清理后为空必须走明确错误终态",
);

// 时间预算耗尽：必须交付已确认要点，而不是只回一张失败卡片
const timeoutBot: BotConfig = {
  name: "pi-timeout-path-test",
  botId: "pi-timeout-path-bot",
  secret: "test-secret",
  wsUrl: "ws://test.invalid",
  mcpHeaders: {},
};
const timeoutClient = new FakeWsClient();
await startBot(timeoutBot, timeoutClient as unknown as WSClient, {
  judgeSensitiveRequestByModel: async () => ({ blocked: false, category: null, matchedCredentialTypes: [] }),
  getAllMcpTools: async () => [{ name: "query", invoke: async () => "unused" }],
  requestTimeoutMs: 60,
  initializeAgent: async () => ({
    async *streamPiEvents() {
      yield { type: "turn_start" };
      yield {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "已确认：入口在 subCheckOp。" },
      };
      // 模拟模型持续检索直到时间上限，始终不产生 agent_end
      await new Promise(resolve => setTimeout(resolve, 120));
      yield {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "仍在核实下游分支。" },
      };
    },
  } as any),
} as any);
await timeoutClient.emitMessage({
  headers: { req_id: "pi-timeout-request" },
  body: {
    msgid: "pi-timeout-request",
    msgtype: "text",
    text: { content: "超时降级验证" },
    chattype: "single",
    from: { userid: "pi-timeout-user" },
  },
});
const timeoutFinalReplies = timeoutClient.replies.filter(reply => reply.final);
assert.equal(timeoutFinalReplies.length > 0, true, "时间上限到达后必须发出终态回复");
const timeoutAnswer = timeoutFinalReplies.map(reply => reply.content).join("\n");
assert.match(timeoutAnswer, /已确认：入口在 subCheckOp/, "超时必须交付已产生的部分结论");
assert.match(timeoutAnswer, /时间上限|超时/, "超时降级回复必须显式标注原因");

// 截止中止后 SDK 若补发 agent_end(aborted)，同样必须走降级交付而不是静默结束
const abortedBot: BotConfig = {
  name: "pi-aborted-path-test",
  botId: "pi-aborted-path-bot",
  secret: "test-secret",
  wsUrl: "ws://test.invalid",
  mcpHeaders: {},
};
const abortedClient = new FakeWsClient();
await startBot(abortedBot, abortedClient as unknown as WSClient, {
  judgeSensitiveRequestByModel: async () => ({ blocked: false, category: null, matchedCredentialTypes: [] }),
  getAllMcpTools: async () => [{ name: "query", invoke: async () => "unused" }],
  requestTimeoutMs: 50,
  initializeAgent: async () => ({
    async *streamPiEvents() {
      yield { type: "turn_start" };
      yield {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "已确认：字段改为 1 即可放开限制。" },
      };
      await new Promise(resolve => setTimeout(resolve, 110));
      yield {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
      };
    },
  } as any),
} as any);
await abortedClient.emitMessage({
  headers: { req_id: "pi-aborted-request" },
  body: {
    msgid: "pi-aborted-request",
    msgtype: "text",
    text: { content: "截止中止降级验证" },
    chattype: "single",
    from: { userid: "pi-aborted-user" },
  },
});
const abortedAnswer = abortedClient.replies.filter(reply => reply.final).map(reply => reply.content).join("\n");
assert.match(abortedAnswer, /已确认：字段改为 1 即可放开限制/, "截止中止补发 agent_end(aborted) 时不得静默丢弃成果");
assert.match(abortedAnswer, /时间上限/, "截止中止的降级回复必须标注时间上限");

// 边界：到时间上限但没有任何部分文本时，只发超时说明，不得伪造结论
const emptyPartialBot: BotConfig = {
  name: "pi-empty-partial-test",
  botId: "pi-empty-partial-bot",
  secret: "test-secret",
  wsUrl: "ws://test.invalid",
  mcpHeaders: {},
};
const emptyPartialClient = new FakeWsClient();
await startBot(emptyPartialBot, emptyPartialClient as unknown as WSClient, {
  judgeSensitiveRequestByModel: async () => ({ blocked: false, category: null, matchedCredentialTypes: [] }),
  getAllMcpTools: async () => [{ name: "query", invoke: async () => "unused" }],
  requestTimeoutMs: 40,
  initializeAgent: async () => ({
    async *streamPiEvents() {
      yield { type: "turn_start" };
      await new Promise(resolve => setTimeout(resolve, 90));
    },
  } as any),
} as any);
await emptyPartialClient.emitMessage({
  headers: { req_id: "pi-empty-partial-request" },
  body: {
    msgid: "pi-empty-partial-request",
    msgtype: "text",
    text: { content: "空部分文本边界验证" },
    chattype: "single",
    from: { userid: "pi-empty-partial-user" },
  },
});
const emptyPartialAnswer = emptyPartialClient.replies.filter(reply => reply.final).map(reply => reply.content).join("\n");
assert.match(emptyPartialAnswer, /时间上限/, "无部分文本时仍必须发出超时说明");
assert.doesNotMatch(emptyPartialAnswer, /已确认的部分结论/, "无部分文本时不得声称已有结论");

console.log("Pi 主执行路径去 Todo 验证通过");
