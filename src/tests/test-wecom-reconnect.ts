import assert from "node:assert/strict";
import {
  getReconnectExhaustedDelayMs,
  getReconnectExhaustedWatchdogMs,
  isWsReconnectExhaustedError,
} from "../wecom-adapter.js";

assert.equal(
  isWsReconnectExhaustedError({ code: "WS_RECONNECT_EXHAUSTED" }),
  true,
  "should detect SDK reconnect exhausted by error code",
);

assert.equal(
  isWsReconnectExhaustedError({ name: "WSReconnectExhaustedError" }),
  true,
  "should detect SDK reconnect exhausted by error name",
);

assert.equal(
  isWsReconnectExhaustedError(new Error("Max reconnect attempts exceeded (10)")),
  true,
  "should detect SDK reconnect exhausted by message",
);

assert.equal(
  isWsReconnectExhaustedError(new Error("temporary network error")),
  false,
  "ordinary websocket errors should not trigger exhausted reconnect handling",
);

assert.equal(getReconnectExhaustedDelayMs("3000"), 3000);
assert.equal(getReconnectExhaustedDelayMs("999"), 5000, "delay below 1s should fallback to default");
assert.equal(getReconnectExhaustedDelayMs("invalid"), 5000, "invalid delay should fallback to default");
assert.equal(getReconnectExhaustedWatchdogMs("30000"), 30000);
assert.equal(getReconnectExhaustedWatchdogMs("9999"), 60000, "watchdog below 10s should fallback to default");

console.log("wecom reconnect exhausted 验证通过");
