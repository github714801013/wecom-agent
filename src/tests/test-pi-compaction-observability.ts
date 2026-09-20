import assert from "node:assert/strict";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { createPiCodingAgentFacade, resetPiCodingAgentSession } from "../pi-coding-agent-runtime.js";

const subscribe = AgentSession.prototype.subscribe;
const sendUserMessage = AgentSession.prototype.sendUserMessage;
const abort = AgentSession.prototype.abort;
const waitForIdle = AgentSession.prototype.waitForIdle;
const messages = Object.getOwnPropertyDescriptor(AgentSession.prototype, "messages");
let listener: ((event: any) => void) | undefined;

try {
  AgentSession.prototype.subscribe = function(next) {
    listener = next;
    return () => { listener = undefined; };
  };
  AgentSession.prototype.sendUserMessage = async function() {
    listener?.({ type: "compaction_start", reason: "threshold" });
    listener?.({
      type: "compaction_end",
      reason: "threshold",
      result: { tokensBefore: 80_000, estimatedTokensAfter: 20_000 },
      aborted: false,
      willRetry: false,
    });
    listener?.({ type: "agent_settled" });
  };
  AgentSession.prototype.abort = async function() {};
  AgentSession.prototype.waitForIdle = async function() {};
  Object.defineProperty(AgentSession.prototype, "messages", {
    configurable: true,
    get: () => [{
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "完成" }],
    }],
  });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const facade = createPiCodingAgentFacade({
      systemPrompt: "测试",
      sessionKey: "compaction-observability",
      tools: [],
    });
    for await (const _event of facade.streamPiEvents("问题", { deadlineMs: 1_000 })) {
      // 只通过 facade 公共事件流驱动会话生命周期。
    }
  } finally {
    console.log = originalLog;
  }
  assert.ok(logs.some(line => line.includes('"event":"compaction_start"') && line.includes('"reason":"threshold"')));
  assert.ok(logs.some(line => line.includes('"event":"compaction_end"') && line.includes('"tokensBefore":80000') && line.includes('"estimatedTokensAfter":20000')));
} finally {
  AgentSession.prototype.subscribe = subscribe;
  AgentSession.prototype.sendUserMessage = sendUserMessage;
  AgentSession.prototype.abort = abort;
  AgentSession.prototype.waitForIdle = waitForIdle;
  if (messages) Object.defineProperty(AgentSession.prototype, "messages", messages);
  resetPiCodingAgentSession("compaction-observability");
}

console.log("Pi compaction 安全观测验证通过");
