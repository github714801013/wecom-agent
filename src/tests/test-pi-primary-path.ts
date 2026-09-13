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
console.log("Pi 主执行路径去 Todo 验证通过");
