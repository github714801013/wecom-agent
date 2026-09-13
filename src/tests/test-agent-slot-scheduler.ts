import assert from "node:assert/strict";
import {
  AgentSlotCancelledError,
  createAgentSlotScheduler,
} from "../agent-slot-scheduler.js";

const scheduler = createAgentSlotScheduler(1);
let release!: () => void;
const first = await scheduler.acquire();
assert.equal(scheduler.activeCount, 1);
const secondPromise = scheduler.acquire();
assert.equal(scheduler.queuedCount, 1);
release = first.release;
release();
const second = await secondPromise;
assert.equal(scheduler.activeCount, 1);
second.release();
second.release();
assert.equal(scheduler.activeCount, 0);

const cancellationScheduler = createAgentSlotScheduler(1);
const held = await cancellationScheduler.acquire();
const controller = new AbortController();
const cancelled = cancellationScheduler.acquire(controller.signal);
controller.abort();
await assert.rejects(cancelled, error => error instanceof AgentSlotCancelledError);
assert.equal(cancellationScheduler.queuedCount, 0);
held.release();

assert.throws(() => createAgentSlotScheduler(0), /正整数/);
console.log("Agent 并发槽位验证通过");
