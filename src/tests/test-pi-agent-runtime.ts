import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createPiAgentFacade,
  createPiMcpPluginTools,
  formatPiLifecycleLog,
  sanitizeLifecycleError,
  summarizeContentBlocks,
} from "../pi-agent-runtime.js";

const summary = summarizeContentBlocks([
  { type: "text", text: "最终结论" },
  { type: "thinking", thinking: "内部推理" },
  { type: "toolCall", id: "secret-call-id", name: "query", arguments: { sql: "select secret" } },
]);
assert.deepEqual(summary, {
  count: 3,
  blocks: [
    { type: "text", length: 4 },
    { type: "thinking", length: 4 },
    { type: "toolCall", length: 0 },
  ],
  textLength: 4,
});
assert.doesNotMatch(JSON.stringify(summary), /最终结论|内部推理|secret-call-id|select secret/);
assert.equal(summarizeContentBlocks(null).count, 0);

const safeError = sanitizeLifecycleError(new Error("request failed"));
assert.ok(safeError && safeError.length <= 160);
assert.doesNotMatch(safeError, /secret|abc123/);
const credentialLifecycleError = sanitizeLifecycleError("Authorization: Bearer live-token api_key=secret-value");
assert.ok(credentialLifecycleError);
assert.doesNotMatch(
  credentialLifecycleError,
  /live-token|secret-value/,
  "Pi 生命周期错误日志不得暴露凭据",
);
assert.equal(sanitizeLifecycleError({ message: "should not leak" }), null);
assert.match(formatPiLifecycleLog({ event: "turn_end", content: summary }), /^\[Pi lifecycle\] /);
assert.doesNotThrow(() => JSON.parse(formatPiLifecycleLog({ event: "turn_end" }).replace(/^\[Pi lifecycle\] /, "")));

const calls: unknown[] = [];
const [tool] = createPiMcpPluginTools([
  {
    name: "query",
    description: "查询测试数据",
    schema: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
    },
    invoke: async (args: unknown, context: unknown) => {
      calls.push({ args, context });
      return { rows: [{ id: 1 }] };
    },
  },
]);

assert.ok(tool);
assert.equal(tool.name, "query");
assert.equal((tool.parameters as { type?: string }).type, "object");
const result = await tool.execute("call-1", { sql: "select 1" });
assert.equal(result.details.toolCallId, "call-1");
const textContent = result.content[0];
assert.ok(textContent && textContent.type === "text");
assert.match(textContent.text, /rows/);
assert.deepEqual(calls[0] && {
  args: (calls[0] as { args: unknown }).args,
  toolCallId: (calls[0] as { context: { toolCallId: string } }).context.toolCallId,
}, {
  args: { sql: "select 1" },
  toolCallId: "call-1",
});

const explicitErrorTools = createPiMcpPluginTools([{
  name: "query",
  description: "显式错误结果",
  schema: { type: "object", properties: {} },
  invoke: async () => ({ isError: true, message: "upstream query failed api_key=secret-value" }),
}]);
assert.ok(explicitErrorTools[0]);
await assert.rejects(
  () => explicitErrorTools[0]!.execute("explicit-error", {}),
  /Pi 工具返回错误：upstream query failed api_key=\[已脱敏\]/,
  "显式错误结果必须进入 Pi 错误语义",
);

const rejectedErrorTools = createPiMcpPluginTools([{
  name: "query",
  description: "拒绝错误结果",
  schema: { type: "object", properties: {} },
  invoke: async () => {
    throw new Error("Authorization: Bearer live-token api_key=secret-value");
  },
}]);
assert.ok(rejectedErrorTools[0]);
await assert.rejects(
  () => rejectedErrorTools[0]!.execute("rejected-error", {}),
  error => error instanceof Error
    && /Pi 工具执行失败/.test(error.message)
    && !/live-token|secret-value/.test(error.message),
  "拒绝错误不得将凭据送入 Pi 错误结果",
);

const retainedHostTools = createPiMcpPluginTools([{
  name: "runtime_todolist_update",
  description: "独立流程工具",
  schema: { type: "object", properties: {} },
  invoke: async () => "ok",
}]);
assert.equal(retainedHostTools.length, 1, "通用 Pi 适配器不得影响独立流程的 Todo 工具");

const controller = new AbortController();
controller.abort();
await assert.rejects(
  () => tool.execute("call-2", { sql: "select 2" }, controller.signal),
  /取消/,
);
assert.equal(calls.length, 1, "已取消工具不得开始执行");

let slowToolSignal: AbortSignal | undefined;
const slowTools = createPiMcpPluginTools([
  {
    name: "slow_query",
    description: "慢查询",
    schema: { type: "object", properties: {} },
    invoke: async (_args: unknown, context: { signal?: AbortSignal }) => {
      slowToolSignal = context.signal;
      return new Promise(resolve => setTimeout(() => resolve("late"), 100));
    },
  },
], { toolTimeoutMs: 1 });
assert.ok(slowTools[0]);
await assert.rejects(() => slowTools[0]!.execute("call-3", {}), /超时/);
assert.equal(slowToolSignal?.aborted, true, "工具超时必须中止下游调用");

const agentPrototype = Agent.prototype as {
  prompt: (input: unknown) => Promise<void>;
  abort: () => void;
  waitForIdle: () => Promise<void>;
};
const originalPrompt = agentPrototype.prompt;
const originalAbort = agentPrototype.abort;
const originalWaitForIdle = agentPrototype.waitForIdle;
let promptCalls = 0;

try {
  agentPrototype.prompt = async () => {
    promptCalls += 1;
  };
  agentPrototype.abort = () => {};
  agentPrototype.waitForIdle = async () => {};

  const eventAbortController = new AbortController();
  const eventFacade = createPiAgentFacade({ systemPrompt: "测试", tools: [] });
  const eventNext = eventFacade.streamPiEvents("问题", { signal: eventAbortController.signal }).next();
  eventAbortController.abort();
  await assert.rejects(eventNext, /取消/);

  const streamAbortController = new AbortController();
  const streamFacade = createPiAgentFacade({ systemPrompt: "测试", tools: [] });
  const streamNext = streamFacade.stream(
    { messages: [new HumanMessage("问题")] },
    { signal: streamAbortController.signal },
  ).next();
  streamAbortController.abort();
  await assert.rejects(streamNext, /取消/);

  assert.equal(promptCalls, 0, "取消发生在微任务执行前时不得启动 Pi prompt");
} finally {
  agentPrototype.prompt = originalPrompt;
  agentPrototype.abort = originalAbort;
  agentPrototype.waitForIdle = originalWaitForIdle;
}

const lifecycleAgentPrototype = Agent.prototype as {
  prompt: (input: unknown) => Promise<void>;
  abort: () => void;
  waitForIdle: () => Promise<void>;
  subscribe: (listener: (event: any) => void) => () => void;
};
const lifecycleOriginalPrompt = lifecycleAgentPrototype.prompt;
const lifecycleOriginalAbort = lifecycleAgentPrototype.abort;
const lifecycleOriginalWaitForIdle = lifecycleAgentPrototype.waitForIdle;
const lifecycleOriginalSubscribe = lifecycleAgentPrototype.subscribe;
let lifecycleListener: ((event: any) => void) | undefined;
let emitDelayedTerminal = true;
let resolveIdle: (() => void) | undefined;
const idleAfterTerminalEvent = new Promise<void>(resolve => {
  resolveIdle = resolve;
});

try {
  lifecycleAgentPrototype.subscribe = listener => {
    lifecycleListener = listener;
    return () => {};
  };
  lifecycleAgentPrototype.prompt = async () => {
    if (!emitDelayedTerminal) return;
    setTimeout(() => {
      lifecycleListener?.({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "延后终态" }] }],
      });
      resolveIdle?.();
    }, 0);
  };
  lifecycleAgentPrototype.abort = () => {};
  lifecycleAgentPrototype.waitForIdle = async () => idleAfterTerminalEvent;

  const delayedTerminalFacade = createPiAgentFacade({ systemPrompt: "测试", tools: [] });
  const lifecycleEvents: unknown[] = [];
  for await (const event of delayedTerminalFacade.streamPiEvents("问题")) {
    lifecycleEvents.push(event);
  }
  assert.equal(lifecycleEvents.length, 1, "prompt 结算后到达的 agent_end 不得被丢弃");

  emitDelayedTerminal = false;
  resolveIdle?.();
  const noTerminalFacade = createPiAgentFacade({ systemPrompt: "测试", tools: [] });
  const noTerminalEvents: unknown[] = [];
  for await (const event of noTerminalFacade.streamPiEvents("没有终态", { deadlineMs: 5 })) {
    noTerminalEvents.push(event);
  }
  assert.equal(noTerminalEvents.length, 0, "没有 agent_end 时应由有限超时结束，而不是永久等待");

  emitDelayedTerminal = true;
  const delayedStreamFacade = createPiAgentFacade({ systemPrompt: "测试", tools: [] });
  const delayedStreamMessages: unknown[] = [];
  for await (const [message] of delayedStreamFacade.stream({ messages: [new HumanMessage("问题")] })) {
    delayedStreamMessages.push(message);
  }
  assert.equal(delayedStreamMessages.length, 1, "stream prompt 结算后到达的 agent_end 不得被丢弃");
} finally {
  lifecycleAgentPrototype.prompt = lifecycleOriginalPrompt;
  lifecycleAgentPrototype.abort = lifecycleOriginalAbort;
  lifecycleAgentPrototype.waitForIdle = lifecycleOriginalWaitForIdle;
  lifecycleAgentPrototype.subscribe = lifecycleOriginalSubscribe;
}

console.log("Pi MCP plugin tests passed");
