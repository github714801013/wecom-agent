import assert from "node:assert/strict";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { BotConfig } from "../config.js";
import { startBot } from "../wecom-adapter.js";

type Listener = (...args: any[]) => void | Promise<void>;

class ConcurrentWsClient {
  readonly listeners = new Map<string, Listener>();
  readonly replies: Array<{ streamId: string; content: string; final: boolean }> = [];

  on(event: string, listener: Listener) {
    this.listeners.set(event, listener);
    return this;
  }

  connect() { return this; }

  async replyStreamWithCard(_frame: unknown, streamId: string, content: string, final = false) {
    this.replies.push({ streamId, content, final });
    return { errcode: 0 };
  }

  async replyStream(_frame: unknown, streamId: string, content: string, final = false) {
    this.replies.push({ streamId, content, final });
    return { errcode: 0 };
  }

  async replyStreamNonBlocking(_frame: unknown, streamId: string, content: string, final = false) {
    this.replies.push({ streamId, content, final });
    return { errcode: 0 };
  }

  emitMessage(frame: unknown) {
    const listener = this.listeners.get("message");
    if (!listener) throw new Error("消息处理器未注册");
    return Promise.resolve(listener(frame));
  }
}

const bot: BotConfig = {
  name: "latest-owner-test",
  botId: "latest-owner",
  secret: "test-secret",
  wsUrl: "ws://test.invalid",
  mcpHeaders: {},
};
const client = new ConcurrentWsClient();
const prompts: string[] = [];
let invocation = 0;
await startBot(bot, client as unknown as WSClient, {
  judgeSensitiveRequestByModel: async () => ({ blocked: false, category: null, matchedCredentialTypes: [] }),
  getAllMcpTools: async () => [],
  initializeAgent: async () => ({
    async *streamPiEvents(prompt: string) {
      prompts.push(prompt);
      invocation += 1;
      const current = invocation;
      yield { type: "turn_start" };
      if (current === 1) {
        yield { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "旧请求已确认入口。" } };
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      yield {
        type: "agent_end",
        messages: [{
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: current === 1 ? "旧请求最终答案" : "最新消息最终答案" }],
        }],
      };
    },
  } as any),
} as any);

const first = client.emitMessage({
  headers: { req_id: "old-request" },
  body: {
    msgid: "old-message",
    msgtype: "text",
    text: { content: "定位订单锁单原因" },
    chattype: "single",
    from: { userid: "same-user" },
  },
});
await new Promise(resolve => setTimeout(resolve, 20));
const second = client.emitMessage({
  headers: { req_id: "new-request" },
  body: {
    msgid: "new-message",
    msgtype: "text",
    text: { content: "给我 SQL" },
    chattype: "single",
    from: { userid: "same-user" },
  },
});
await Promise.all([first, second]);

const finalReplies = client.replies.filter(reply => reply.final);
assert.equal(finalReplies.some(reply => reply.content.includes("旧请求最终答案")), false, "被替换请求不得发送迟到最终答案");
assert.equal(finalReplies.filter(reply => reply.content.includes("最新消息最终答案")).length, 1, "只允许最新消息发送一个最终答案");
assert.ok(prompts[1]?.includes("被替换的在途请求"), "最新 Agent 必须看到旧在途请求上下文");
assert.ok(prompts[1]?.includes("定位订单锁单原因"));
assert.ok(prompts[1]?.includes("给我 SQL"));
assert.ok(prompts[1]?.includes("自行判断"), "相关性必须由 Agent 判断");

console.log("同一会话仅回复最新消息验证通过");
