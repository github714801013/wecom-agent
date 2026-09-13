import assert from "node:assert/strict";
import {
  classifyRequestSpeed,
  createRequestTimingRecord,
  shouldSampleRequest,
} from "../request-timing.js";

assert.equal(classifyRequestSpeed(299_999), "normal");
assert.equal(classifyRequestSpeed(300_000), "slow");
assert.equal(classifyRequestSpeed(599_999), "slow");
assert.equal(classifyRequestSpeed(600_000), "very_slow");
assert.equal(classifyRequestSpeed(Number.NaN), "normal");
assert.equal(classifyRequestSpeed(-1), "normal");

const input = {
  requestId: "request-1",
  botName: "bot",
  modelName: "model",
  totalMs: 300_000,
  turns: 1,
  terminalStatus: "completed" as const,
  sensitivePrecheckMs: null,
  mediaProcessingMs: null,
  mcpLoadMs: 10,
  piModelRoundMs: 20,
  toolCallMs: null,
  replyQueueMs: null,
  finalSendMs: null,
  agentQueueMs: null,
  activeAgentRequests: 1,
  queuedAgentRequests: 0,
  replyActive: 0,
  replyQueued: 0,
  modelCalls: 1,
};
const record = createRequestTimingRecord(input);
assert.equal(record.speedClass, "slow");
assert.equal(shouldSampleRequest(record, 0.99), true);
assert.equal(shouldSampleRequest({ ...record, speedClass: "normal" }, 0.1), false);
assert.equal(shouldSampleRequest({ ...record, speedClass: "normal" }, 0.09), true);
assert.equal(shouldSampleRequest({ ...record, terminalStatus: "error", speedClass: "normal" }, 0.99), true);
