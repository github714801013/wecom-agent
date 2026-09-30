import assert from "node:assert/strict";
import { createReplyScheduler } from "../reply-scheduler.js";

const scheduler = createReplyScheduler(1);
const events: string[] = [];
let releaseFirst!: () => void;
const first = scheduler.schedule(async () => {
  events.push("first-start");
  await new Promise<void>(resolve => { releaseFirst = resolve; });
  events.push("first-end");
  return "first";
}, "progress");

const progress = scheduler.schedule(async () => {
  events.push("progress");
  return "progress";
}, "progress");
const final = scheduler.schedule(async () => {
  events.push("final");
  return "final";
}, "final");

assert.equal(scheduler.activeCount, 1);
assert.equal(scheduler.queuedCount, 2);
await new Promise<void>(resolve => queueMicrotask(resolve));
releaseFirst();
assert.equal(await first, "first");
assert.equal(await final, "final");
assert.equal(await progress, "progress");
assert.deepEqual(events, ["first-start", "first-end", "final", "progress"]);
await new Promise<void>(resolve => setImmediate(resolve));
assert.equal(scheduler.activeCount, 0);
assert.equal(scheduler.queuedCount, 0);

const latestScheduler = createReplyScheduler(1);
let releaseBusy!: () => void;
const busy = latestScheduler.schedule(async () => {
  await new Promise<void>(resolve => { releaseBusy = resolve; });
  return "busy";
});
const stale = latestScheduler.scheduleLatest("stream-a", async () => "stale");
const latest = latestScheduler.scheduleLatest("stream-a", async () => "latest");
await new Promise<void>(resolve => queueMicrotask(resolve));
releaseBusy();
assert.equal(await busy, "busy");
assert.equal(await stale, undefined);
assert.equal(await latest, "latest");

let cancelledJobRan = false;
const cancelled = await latestScheduler.scheduleIf(
  () => false,
  async () => {
    cancelledJobRan = true;
    return "cancelled";
  },
  "final",
);
assert.equal(cancelled, undefined);
assert.equal(cancelledJobRan, false);

const queuedCancellationScheduler = createReplyScheduler(1);
let releaseQueued!: () => void;
const active = queuedCancellationScheduler.schedule(async () => {
  await new Promise<void>(resolve => { releaseQueued = resolve; });
  return "active";
});
let shouldDeliver = true;
let staleFinalRan = false;
const staleFinal = queuedCancellationScheduler.scheduleIf(
  () => shouldDeliver,
  async () => {
    staleFinalRan = true;
    return "stale-final";
  },
  "final",
);
await new Promise<void>(resolve => queueMicrotask(resolve));
shouldDeliver = false;
releaseQueued();
assert.equal(await active, "active");
assert.equal(await staleFinal, undefined);
assert.equal(staleFinalRan, false);

const rejectionScheduler = createReplyScheduler(1);
const rejected = rejectionScheduler.schedule(async () => {
  throw new Error("send failed");
});
const afterReject = rejectionScheduler.schedule(async () => "after");
await assert.rejects(rejected, /send failed/);
assert.equal(await afterReject, "after");

// 出队检查后、真正调用发送函数前，owner 可能已被下一条消息替换。
const executionBoundaryScheduler = createReplyScheduler(1);
let ownsReply = true;
let staleSendRan = false;
const boundaryReply = executionBoundaryScheduler.scheduleIf(
  () => ownsReply,
  async () => {
    staleSendRan = true;
    return "stale";
  },
);
ownsReply = false;
assert.equal(await boundaryReply, undefined, "实际发送前必须再次确认 owner");
assert.equal(staleSendRan, false, "被替换消息不得穿过微任务边界发送");
assert.equal(await executionBoundaryScheduler.schedule(async () => "latest"), "latest");

console.log("回复调度器验证通过");
