export const STREAM_SAFE_TTL_MS = 9 * 60 * 1000;

export const STREAM_EXPIRED_MESSAGE =
  "本次分析已接近企业微信 10 分钟流式窗口限制，已暂停在安全窗口内。请回复「继续」我会带着当前上下文接着处理。";

export function isStreamExpired(startedAt: number, now = Date.now(), ttlMs = STREAM_SAFE_TTL_MS) {
  return now - startedAt >= ttlMs;
}

export function isWeComStreamExpiredError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("stream message update expired") || message.includes("846608");
}
