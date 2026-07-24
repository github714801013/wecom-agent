const SENSITIVE_ERROR_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/giu,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|cookie|secret)\s*[:=]\s*)['"]?[^'"\s,;]+/giu,
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)=)[^&\s]+/giu,
];

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : String(error);
  } catch {
    return String(error);
  }
}

export function sanitizeErrorMessage(message: string): string {
  return SENSITIVE_ERROR_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "$1[已脱敏]"),
    message,
  ).trim();
}

export function buildUserFacingErrorReply(error: unknown, prefix = "处理请求时发生异常"): string {
  const detail = sanitizeErrorMessage(getErrorMessage(error));
  return `${prefix}：${detail || "未知异常"}`;
}

export function buildDiagnosticErrorFields(error: unknown) {
  return {
    error: sanitizeErrorMessage(getErrorMessage(error)),
    answer: buildUserFacingErrorReply(error),
  };
}
