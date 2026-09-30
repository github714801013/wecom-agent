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

const imageClient = new ConcurrentWsClient();
let releaseOld!: () => void;
let releaseImage!: () => void;
let imageDownloading!: () => void;
let oldModelStarted!: () => void;
const oldStarted = new Promise<void>(resolve => { oldModelStarted = resolve; });
const downloadStarted = new Promise<void>(resolve => { imageDownloading = resolve; });
const oldPending = new Promise<void>(resolve => { releaseOld = resolve; });
const imagePending = new Promise<void>(resolve => { releaseImage = resolve; });
let oldSignal: AbortSignal | undefined;
const imagePrompts: string[] = [];
const downloadableClient = Object.assign(imageClient, {
  async downloadFile() {
    imageDownloading();
    await imagePending;
    return { buffer: Buffer.from("fixture-image") };
  },
});
await startBot({ ...bot, name: "image-owner-test" }, downloadableClient as unknown as WSClient, {
  judgeSensitiveRequestByModel: async () => ({ blocked: false, category: null, matchedCredentialTypes: [] }),
  getAllMcpTools: async () => [],
  initializeAgent: async () => ({
    async *streamPiEvents(prompt: string, options: { signal: AbortSignal }) {
      imagePrompts.push(prompt);
      yield { type: "turn_start" };
      if (imagePrompts.length === 1) {
        oldSignal = options.signal;
        oldModelStarted();
        await oldPending;
        throw new Error("旧请求迟到失败");
      }
      yield {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "最新图片最终答案" }] }],
      };
    },
  } as any),
} as any);
const imageFrame = (msgid: string, msgtype: string, payload: object) => ({
  headers: { req_id: msgid },
  body: { msgid, msgtype, chattype: "single", from: { userid: "image-owner-user" }, ...payload },
});
const oldRequest = imageClient.emitMessage(imageFrame("image-old", "text", { text: { content: "为什么这张单不能核销" } }));
await oldStarted;
const latestImage = imageClient.emitMessage(imageFrame("image-latest", "image", { image: { url: "https://fixture.invalid/image.jpg" } }));
try {
  await downloadStarted;
  assert.equal(oldSignal?.aborted, true, "纯图片必须在下载/识别完成前立即取消旧模型");
} finally {
  releaseOld();
  releaseImage();
  await Promise.all([oldRequest, latestImage]);
}
assert.equal(imageClient.replies.some(reply => reply.final && reply.content.includes("本次分析暂时失败")), false, "旧任务取消不得发送失败回复");
assert.equal(imageClient.replies.filter(reply => reply.final && reply.content.includes("最新图片最终答案")).length, 1);
assert.ok(imagePrompts[1]?.includes("为什么这张单不能核销"), "最新图片请求必须获得被替换的文字问题");

const chainClient = new ConcurrentWsClient();
let chainOldStarted!: () => void;
let chainImageStarted!: () => void;
let releaseChainOld!: () => void;
let releaseChainImage!: () => void;
const chainOldReady = new Promise<void>(resolve => { chainOldStarted = resolve; });
const chainImageReady = new Promise<void>(resolve => { chainImageStarted = resolve; });
const chainOldPending = new Promise<void>(resolve => { releaseChainOld = resolve; });
const chainImagePending = new Promise<void>(resolve => { releaseChainImage = resolve; });
const chainPrompts: string[] = [];
await startBot({ ...bot, name: "chain-owner-test" }, Object.assign(chainClient, {
  async downloadFile() {
    chainImageStarted();
    await chainImagePending;
    return { buffer: Buffer.from("fixture-image") };
  },
}) as unknown as WSClient, {
  judgeSensitiveRequestByModel: async () => ({ blocked: false, category: null, matchedCredentialTypes: [] }),
  getAllMcpTools: async () => [],
  initializeAgent: async () => ({
    async *streamPiEvents(prompt: string) {
      chainPrompts.push(prompt);
      yield { type: "turn_start" };
      if (chainPrompts.length === 1) {
        chainOldStarted();
        await chainOldPending;
      }
      yield {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "连续接管最终答案" }] }],
      };
    },
  } as any),
} as any);
const chainFrame = (msgid: string, msgtype: string, payload: object) => ({
  headers: { req_id: msgid },
  body: { msgid, msgtype, chattype: "single", from: { userid: "chain-owner-user" }, ...payload },
});
const chainA = chainClient.emitMessage(chainFrame("chain-a", "text", { text: { content: "核销总金额为何不一致" } }));
await chainOldReady;
const chainB = chainClient.emitMessage(chainFrame("chain-b", "mixed", {
  mixed: { msg_item: [{ msgtype: "text", text: { content: "看红框中的金额" } }, { msgtype: "image", image: { url: "https://fixture.invalid/pending.jpg" } }] },
}));
await chainImageReady;
const chainCFrame = chainFrame("chain-c", "text", { text: { content: "只检查深圳门店" } });
const chainC = chainClient.emitMessage(chainCFrame);
await chainClient.emitMessage(chainCFrame);
releaseChainOld();
releaseChainImage();
await Promise.all([chainA, chainB, chainC]);
assert.equal(chainClient.replies.filter(reply => reply.final && reply.content.includes("连续接管最终答案")).length, 1, "A→B→C 只允许最后一个 owner 交付");
assert.ok(chainPrompts[1]?.includes("核销总金额为何不一致"), "B 尚未解析就被 C 替换时，A 的问题仍需传给 C");
assert.ok(chainPrompts[1]?.includes("看红框中的金额"), "不得丢失 B 提供的补充文字");
assert.ok(chainPrompts[1]?.includes("只检查深圳门店"));

const evidenceClient = new ConcurrentWsClient();
const evidencePrompts: string[] = [];
const releases: Array<() => void> = [];
const ready: Array<() => void> = [];
const stageReady = Array.from({ length: 2 }, (_, index) => new Promise<void>(resolve => { ready[index] = resolve; }));
await startBot({ ...bot, name: "evidence-owner-test" }, evidenceClient as unknown as WSClient, {
  judgeSensitiveRequestByModel: async () => ({ blocked: false, category: null, matchedCredentialTypes: [] }),
  getAllMcpTools: async () => [],
  initializeAgent: async () => ({
    async *streamPiEvents(prompt: string) {
      const index = evidencePrompts.length;
      evidencePrompts.push(prompt);
      yield { type: "turn_start" };
      if (index < 2) {
        yield { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: index === 0 ? "A已确认收款字段" : "B已确认门店范围" } };
        yield { type: "tool_execution_end", toolCallId: `evidence-${index}`, toolName: "read_query", isError: false, result: { content: [{ type: "text", text: index === 0 ? "A工具收款证据" : "B工具门店证据" }] } };
        ready[index]?.();
        await new Promise<void>(resolve => { releases[index] = resolve; });
      }
      yield { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "证据接管最终结论" }] }] };
    },
  } as any),
} as any);
const evidenceFrame = (msgid: string, content: string) => ({
  headers: { req_id: msgid },
  body: { msgid, msgtype: "text", text: { content }, chattype: "single", from: { userid: "evidence-user" } },
});
const evidenceA = evidenceClient.emitMessage(evidenceFrame("evidence-a", "核对收款字段"));
await stageReady[0];
const evidenceB = evidenceClient.emitMessage(evidenceFrame("evidence-b", "加上门店范围"));
await stageReady[1];
const evidenceC = evidenceClient.emitMessage(evidenceFrame("evidence-c", "给最终核对结果"));
releases.forEach(release => release());
await Promise.all([evidenceA, evidenceB, evidenceC]);
for (const evidence of ["A已确认收款字段", "B已确认门店范围", "A工具收款证据", "B工具门店证据"]) {
  assert.ok(evidencePrompts[2]?.includes(evidence), `C 必须同时保留 A/B 的已确认上下文：${evidence}`);
}
assert.equal(evidenceClient.replies.filter(reply => reply.final && reply.content.includes("证据接管最终结论")).length, 1);

console.log("同一会话仅回复最新消息验证通过");
