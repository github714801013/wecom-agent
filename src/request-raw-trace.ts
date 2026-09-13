import type { ToolContextRecord } from "./tool-context-filter.js";

export const REQUEST_RAW_LOG_ENABLED_ENV = "REQUEST_RAW_LOG_ENABLED";

const MAX_RAW_INPUT_LENGTH = 16_000;
const MAX_RAW_ERROR_LENGTH = 4_000;
const MAX_RAW_TOOL_ARGS_LENGTH = 16_000;
const MAX_RAW_TOOL_RESULT_LENGTH = 32_000;
const MAX_RAW_TOOL_RECORDS = 32;
const MAX_RAW_TRACE_LENGTH = 256_000;

const SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/giu,
  /(["']?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^"'\r\n,;}\]]+/giu,
  /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|cookie|secret|token|private[_-]?key|privatekey|webhook[_-]?(?:signature|secret|token|key)|signature|sign)["']?\s*[:=]\s*["']?)([^"'\s,;{}\[\]]+)/giu,
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|cookie|secret|token|signature)=)([^&\s]+)/giu,
  /((?:bearer|basic)\s+)([A-Za-z0-9._~+/=-]+)/giu,
  /((?:(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp)|https?):\/\/[^:\s/]+:)([^@\s]+)(@)/giu,
];

const TRUNCATION_MARKER = "…[已截断]";
const REDACTION_PLACEHOLDER = "__RAW_LOG_REDACTED_VALUE__";

export function isRequestRawLoggingEnabled(value = process.env[REQUEST_RAW_LOG_ENABLED_ENV]) {
  return value === "true";
}

export function redactSensitiveValues(value: string) {
  const redacted = SENSITIVE_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (...matches) => {
      const matched = String(matches[0] ?? "");
      if (/^-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/iu.test(matched)) {
        return REDACTION_PLACEHOLDER;
      }
      const prefix = String(matches[1] ?? "");
      const suffix = matches[3] === "@" ? "@" : "";
      return `${prefix}${REDACTION_PLACEHOLDER}${suffix}`;
    }),
    value,
  );
  return redacted.split(REDACTION_PLACEHOLDER).join("[已脱敏]");
}

function truncateRawValue(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "[无法序列化]";
  const source = value.length > maxLength ? value.slice(0, maxLength) : value;
  const redacted = redactSensitiveValues(source);
  if (value.length <= maxLength && redacted.length <= maxLength) return redacted;
  const contentLength = Math.max(0, maxLength - TRUNCATION_MARKER.length);
  return `${redacted.slice(0, contentLength)}${TRUNCATION_MARKER}`;
}

export function buildRequestRawTrace(
  input: {
    userInput?: string;
    error?: string;
    toolRecords?: readonly ToolContextRecord[];
  },
  enabled = isRequestRawLoggingEnabled(),
) {
  if (!enabled) return undefined;

  const lines = [
    `[用户原文]\n${truncateRawValue(input.userInput || "", MAX_RAW_INPUT_LENGTH)}`,
  ];

  if (input.error) {
    lines.push(`[错误原文]\n${truncateRawValue(input.error, MAX_RAW_ERROR_LENGTH)}`);
  }

  for (const record of (input.toolRecords || []).slice(0, MAX_RAW_TOOL_RECORDS)) {
    lines.push([
      `[工具名称] ${record.name}`,
      `[工具参数]\n${truncateRawValue(record.args, MAX_RAW_TOOL_ARGS_LENGTH)}`,
      `[工具返回]\n${truncateRawValue(record.content, MAX_RAW_TOOL_RESULT_LENGTH)}`,
    ].join("\n"));
  }

  const trace = lines.join("\n\n");
  if (trace.length <= MAX_RAW_TRACE_LENGTH) return trace;
  const contentLength = Math.max(0, MAX_RAW_TRACE_LENGTH - TRUNCATION_MARKER.length);
  return `${trace.slice(0, contentLength)}${TRUNCATION_MARKER}`;
}
