import { strict as assert } from "node:assert";
import {
  isStreamExpired,
  isWeComStreamExpiredError,
  STREAM_EXPIRED_MESSAGE,
  STREAM_SAFE_TTL_MS,
} from "../stream-ttl.js";

assert.equal(
  isStreamExpired(0, STREAM_SAFE_TTL_MS - 1),
  false,
  "stream should remain active before the safe TTL",
);

assert.equal(
  isStreamExpired(0, STREAM_SAFE_TTL_MS),
  true,
  "stream should expire exactly at the safe TTL boundary",
);

assert.equal(
  isStreamExpired(1000, 1000 + STREAM_SAFE_TTL_MS),
  true,
  "stream should expire relative to its own start time",
);

assert.equal(
  isWeComStreamExpiredError(new Error("errmsg: 'stream message update expired (>10 minutes)', more info e=846608")),
  true,
  "WeCom stream expired SDK errors should be detected",
);

assert.match(
  STREAM_EXPIRED_MESSAGE,
  /继续/,
  "expired message should tell the user how to resume",
);

console.log("stream ttl 验证通过");
