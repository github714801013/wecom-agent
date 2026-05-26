import { strict as assert } from "node:assert";
import { StreamIdleTimeoutError, withIdleTimeout } from "../stream-timeout.js";

async function* delayedValues() {
  yield "first";
  await new Promise(resolve => setTimeout(resolve, 80));
  yield "second";
}

const received: string[] = [];
try {
  for await (const item of withIdleTimeout(delayedValues(), 20, () => ["query"])) {
    received.push(item);
  }
  assert.fail("idle stream should timeout before second value");
} catch (error) {
  assert.ok(error instanceof StreamIdleTimeoutError, "should throw StreamIdleTimeoutError");
  assert.deepEqual(received, ["first"], "should keep values emitted before idle timeout");
  assert.deepEqual((error as StreamIdleTimeoutError).activeCalls, ["query"], "should capture active calls at timeout");
}

console.log("stream timeout 验证通过");
