import assert from "node:assert/strict";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { BotConfig } from "../config.js";
import { STREAM_EXPIRED_MESSAGE, STREAM_SAFE_TTL_MS } from "../stream-ttl.js";
import { startBot } from "../wecom-adapter.js";

type Listener = (...args: any[]) => void | Promise<void>;

class FakeWsClient {
  readonly listeners = new Map<string, Listener>();
  readonly replies: Array<{ msgid: string; streamId: string; content: string; final: boolean }> = [];
  readonly blockedMessageIds = new Set<string>();
  connectCalls = 0;
  disconnectCalls = 0;

  on(event: string, listener: Listener) {
    this.listeners.set(event, listener);
    return this;
  }

  connect() {
    this.connectCalls += 1;
    return this;
  }

  disconnect() {
    this.disconnectCalls += 1;
  }

  async replyStreamWithCard(frame: any, streamId: string, content: string, final = false) {
    this.replies.push({ msgid: frame.body.msgid, streamId, content, final });
    if (this.blockedMessageIds.has(frame.body.msgid) && !final) {
      return new Promise(() => {});
    }
    if (frame.body.msgid === "request-a") {
      throw new Error("Reply ack timeout (5000ms) for reqId: request-a");
    }
    return { errcode: 0 };
  }

  async emitMessage(frame: any) {
    const listener = this.listeners.get("message");
    if (!listener) throw new Error("消息处理器未注册");
    await listener(frame);
  }
}

const botConfig: BotConfig = {
  name: "ack-isolation-test",
  botId: "test-bot",
  secret: "test-secret",
  wsUrl: "ws://test.invalid",
  mcpHeaders: {},
};
const client = new FakeWsClient();
await startBot(botConfig, client as unknown as WSClient);

await Promise.all([
  client.emitMessage({
    headers: { req_id: "request-a" },
    body: {
      msgid: "request-a",
      msgtype: "text",
      text: { content: "stop" },
      chattype: "single",
      from: { userid: "user-a" },
    },
  }),
  client.emitMessage({
    headers: { req_id: "request-b" },
    body: {
      msgid: "request-b",
      msgtype: "text",
      text: { content: "stop" },
      chattype: "single",
      from: { userid: "user-b" },
    },
  }),
]);

assert.equal(client.disconnectCalls, 0, "单个 ACK 超时不得断开共享 WebSocket");
assert.equal(client.connectCalls, 1, "单个 ACK 超时不得触发共享连接重连");
assert.equal(
  client.replies.some(reply => reply.msgid === "request-b" && reply.final),
  true,
  "另一个请求必须继续完成回复",
);

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const ttlTimers = new Set<{ cancelled: boolean }>();

try {
  globalThis.setTimeout = ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
    if (typeof timeout === "number" && timeout >= STREAM_SAFE_TTL_MS - 1_000) {
      const timer = { cancelled: false };
      ttlTimers.add(timer);
      queueMicrotask(() => {
        if (!timer.cancelled) handler(...args);
      });
      return timer as unknown as ReturnType<typeof setTimeout>;
    }
    return (originalSetTimeout as any)(handler, timeout, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => {
    if (ttlTimers.has(timer as { cancelled: boolean })) {
      (timer as { cancelled: boolean }).cancelled = true;
      return;
    }
    return (originalClearTimeout as any)(timer);
  }) as typeof clearTimeout;

  const ttlClient = new FakeWsClient();
  ttlClient.blockedMessageIds.add("ttl-request");
  await startBot({ ...botConfig, name: "ttl-handoff-test" }, ttlClient as unknown as WSClient);
  await ttlClient.emitMessage({
    headers: { req_id: "ttl-request" },
    body: {
      msgid: "ttl-request",
      msgtype: "text",
      text: { content: "分析这个问题" },
      chattype: "single",
      from: { userid: "ttl-user" },
    },
  });
  assert.equal(
    ttlClient.replies.some(reply => reply.final && reply.content === STREAM_EXPIRED_MESSAGE),
    true,
    "pre-stream TTL 必须独立发起暂停终态",
  );
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

console.log("WeCom ACK 隔离验证通过");
