import { stringifyModelContent } from "./model-content.js";
import { isLikelyIrrelevantToolResult } from "./tool-context-filter.js";
import { buildStoredToolResultPlaceholder, MAX_STORED_TOOL_RESULT_LENGTH, MAX_TOOL_RESULT_CONTENT_LENGTH, storeToolResult } from "./tool-result-store.js";

export const PI_TOOL_RESULT_THRESHOLD = 8_000;
const MAX_EVIDENCE_SUMMARY_LENGTH = 6_000;
const MAX_EVIDENCE_MATCHES = 8;
const MAX_EVIDENCE_TEXT_LENGTH = 300;
const MAX_REFERENCE_PREVIEW_SOURCE_LENGTH = 600;
const MAX_PROJECT_SUMMARY_ITEMS = 32;
const MAX_STRUCTURED_PARSE_LENGTH = 256_000;
const MAX_EVIDENCE_SCAN_LENGTH = MAX_STORED_TOOL_RESULT_LENGTH;
const MAX_EVIDENCE_NODES = 2_000;
const MAX_EVIDENCE_CANDIDATES = MAX_EVIDENCE_MATCHES * 8;
const MAX_SERIALIZED_RESULT_DEPTH = 24;
const MAX_SERIALIZED_RESULT_NODES = 4_000;
const MAX_SERIALIZED_STRING_LENGTH = 100_000;
const SERIALIZATION_TRUNCATION_MARKER = "[工具结果序列化已受控截断]";
const LIST_REPOS_TOOL_NAME_PATTERN = /(?:^|[_-])list[_-]?repos$/iu;

interface EvidenceMatch {
  repo?: string;
  file?: string;
  line?: number;
  endLine?: number;
  evidence?: string;
}

interface CollectedEvidenceMatch extends EvidenceMatch {
  priority: number;
  order: number;
}

type JsonRecord = Record<string, unknown>;
type StoredToolResult = ReturnType<typeof storeToolResult>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(record: JsonRecord, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(record: JsonRecord, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d+$/u.test(value.trim())) return Number(value.trim());
  }
  return undefined;
}

function firstJsonValueEnd(text: string, start: number) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // MCP 常在 JSON 之后追加 markdown 页脚或提示行；截取首个完整 JSON 值重试。
  }
  const start = trimmed.search(/[[{]/u);
  if (start < 0) return undefined;
  const end = firstJsonValueEnd(trimmed, start);
  if (end < 0) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

interface BoundedSerializedValue {
  text: string;
  truncated: boolean;
}

function boundedJsonStringify(value: unknown): BoundedSerializedValue {
  const seen = new WeakSet<object>();
  const marker = JSON.stringify(SERIALIZATION_TRUNCATION_MARKER);
  let nodes = 0;

  const serializeString = (input: string, budget: number): BoundedSerializedValue => {
    if (input.length <= MAX_SERIALIZED_STRING_LENGTH) {
      const full = JSON.stringify(input);
      if (full.length <= budget) return { text: full, truncated: false };
    }

    let length = Math.max(0, Math.min(
      input.length,
      MAX_SERIALIZED_STRING_LENGTH,
      budget - marker.length - 4,
    ));
    while (length > 0) {
      const candidate = JSON.stringify(`${input.slice(0, length)}…`);
      if (candidate.length <= budget) return { text: candidate, truncated: true };
      length = Math.floor(length * 0.8);
    }
    return marker.length <= budget
      ? { text: marker, truncated: true }
      : { text: "null", truncated: true };
  };

  const serialize = (current: unknown, depth: number, budget: number): BoundedSerializedValue => {
    if (budget < 2) return { text: "null", truncated: true };
    if (current === null) return { text: "null", truncated: false };
    if (typeof current === "string") return serializeString(current, budget);
    if (typeof current === "number" || typeof current === "boolean") {
      const text = JSON.stringify(current);
      return text.length <= budget ? { text, truncated: false } : { text: "null", truncated: true };
    }
    if (typeof current !== "object") return { text: "null", truncated: true };
    if (depth >= MAX_SERIALIZED_RESULT_DEPTH || nodes >= MAX_SERIALIZED_RESULT_NODES) {
      return marker.length <= budget
        ? { text: marker, truncated: true }
        : { text: "null", truncated: true };
    }
    if (seen.has(current)) return { text: marker, truncated: true };

    nodes += 1;
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const parts: string[] = [];
        let used = 2;
        let truncated = false;
        for (let index = 0; index < current.length; index += 1) {
          const separatorLength = parts.length > 0 ? 1 : 0;
          const childBudget = budget - used - separatorLength - 1;
          if (childBudget <= 0) {
            truncated = true;
            break;
          }
          const child = serialize(current[index], depth + 1, childBudget);
          if (used + separatorLength + child.text.length + 1 > budget) {
            truncated = true;
            break;
          }
          parts.push(child.text);
          used += separatorLength + child.text.length;
          if (child.truncated) {
            truncated = true;
            break;
          }
        }
        if (truncated) {
          const separatorLength = parts.length > 0 ? 1 : 0;
          if (used + separatorLength + marker.length + 1 <= budget) {
            parts.push(marker);
          } else if (parts.length === 0) {
            return marker.length + 2 <= budget
              ? { text: `[${marker}]`, truncated: true }
              : { text: "null", truncated: true };
          }
        }
        return { text: `[${parts.join(",")}]`, truncated };
      }

      const entries: string[] = [];
      let used = 2;
      let truncated = false;
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        const safeKey = key.length > 512 ? `${key.slice(0, 511)}…` : key;
        const keyText = JSON.stringify(safeKey);
        const separatorLength = entries.length > 0 ? 1 : 0;
        const childBudget = budget - used - separatorLength - keyText.length - 2;
        if (childBudget <= 0) {
          truncated = true;
          break;
        }
        let child: BoundedSerializedValue;
        try {
          child = serialize((current as Record<string, unknown>)[key], depth + 1, childBudget);
        } catch {
          truncated = true;
          break;
        }
        const entry = `${keyText}:${child.text}`;
        if (used + separatorLength + entry.length + 1 > budget) {
          truncated = true;
          break;
        }
        entries.push(entry);
        used += separatorLength + entry.length;
        if (child.truncated) {
          truncated = true;
          break;
        }
      }
      if (truncated) {
        const markerEntry = `${JSON.stringify("__truncated__")}:${marker}`;
        const separatorLength = entries.length > 0 ? 1 : 0;
        if (used + separatorLength + markerEntry.length + 1 <= budget) {
          entries.push(markerEntry);
        } else if (entries.length === 0) {
          return marker.length + 2 <= budget
            ? { text: `{${markerEntry}}`, truncated: true }
            : { text: "null", truncated: true };
        }
      }
      return { text: `{${entries.join(",")}}`, truncated };
    } finally {
      seen.delete(current);
    }
  };

  return serialize(value, 0, MAX_STORED_TOOL_RESULT_LENGTH);
}

function boundPlainTextResult(input: string): BoundedSerializedValue {
  if (input.length <= MAX_STORED_TOOL_RESULT_LENGTH) return { text: input, truncated: false };
  return {
    text: `${input.slice(0, MAX_STORED_TOOL_RESULT_LENGTH - SERIALIZATION_TRUNCATION_MARKER.length)}${SERIALIZATION_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function serializePiToolResultWithMetadata(value: unknown, preserveStructure = false): BoundedSerializedValue {
  if (value && typeof value === "object") {
    if (!preserveStructure && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.text === "string") return boundPlainTextResult(record.text);
      if (typeof record.content === "string") return boundPlainTextResult(record.content);
    }
    try {
      return boundedJsonStringify(value);
    } catch {
      return { text: SERIALIZATION_TRUNCATION_MARKER, truncated: true };
    }
  }

  const text = stringifyModelContent(value);
  if (text) return { text, truncated: false };
  try {
    const serialized = JSON.stringify(value);
    return { text: serialized === undefined ? "[无法序列化]" : serialized, truncated: false };
  } catch {
    return { text: "[无法序列化]", truncated: false };
  }
}

export function serializePiToolResult(value: unknown, preserveStructure = false) {
  return serializePiToolResultWithMetadata(value, preserveStructure).text;
}

function truncateEvidence(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > MAX_EVIDENCE_TEXT_LENGTH
    ? `${normalized.slice(0, MAX_EVIDENCE_TEXT_LENGTH - 1)}…`
    : normalized;
}

type EvidenceTraversalState = { nodes: number };

function collectEvidenceMatches(
  value: unknown,
  inheritedRepo = "",
  output: CollectedEvidenceMatch[] = [],
  state: EvidenceTraversalState = { nodes: 0 },
  depth = 0,
  priority = 0,
): CollectedEvidenceMatch[] {
  if (depth > 7 || state.nodes >= MAX_EVIDENCE_NODES) return output;
  state.nodes += 1;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEvidenceMatches(item, inheritedRepo, output, state, depth + 1, priority);
      if (state.nodes >= MAX_EVIDENCE_NODES) break;
    }
    return output;
  }
  if (!isRecord(value)) return output;

  const repo = firstString(value, ["repo", "repository", "project", "projectName"]) || inheritedRepo;
  const file = firstString(value, ["file", "filePath", "file_path", "path"]);
  const line = firstNumber(value, ["line", "lineNumber", "startLine", "line_start", "lineStart"]);
  const endLine = firstNumber(value, ["endLine", "line_end", "lineEnd"]);
  const evidenceValue = firstString(value, ["evidence", "snippet", "code", "content", "text", "source"]);
  if (file || line !== undefined) {
    if (output.length < MAX_EVIDENCE_CANDIDATES) output.push({
      ...(repo ? { repo } : {}),
      ...(file ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(evidenceValue ? { evidence: truncateEvidence(evidenceValue) } : {}),
      priority,
      order: output.length,
    });
  }

  const entries = Object.entries(value).sort(([left], [right]) => {
    const rank = (key: string) => key === "matches" || key === "results" ? 0 : key === "definitions" ? 2 : 1;
    return rank(left) - rank(right);
  });
  for (const [key, child] of entries) {
    if (key === "stats" || key === "embeddings") continue;
    const childPriority = key === "matches" || key === "results" ? 2 : key === "definitions" ? 0 : priority;
    if (typeof child === "string") {
      const nested = parseJson(child);
      if (nested !== undefined) {
        collectEvidenceMatches(nested, repo, output, state, depth + 1, childPriority);
      } else {
        output.push(...collectTextEvidenceMatches(child, repo ? { repo } : {}).map(match => ({
          ...match,
          priority: childPriority,
          order: output.length,
        })).slice(0, Math.max(0, MAX_EVIDENCE_CANDIDATES - output.length)));
      }
      if (state.nodes >= MAX_EVIDENCE_NODES) break;
      continue;
    }
    collectEvidenceMatches(child, repo, output, state, depth + 1, childPriority);
    if (state.nodes >= MAX_EVIDENCE_NODES) break;
  }
  return output;
}

function evidenceCompletenessScore(match: EvidenceMatch) {
  return Number(Boolean(match.repo)) * 4
    + Number(Boolean(match.file)) * 2
    + Number(match.line !== undefined)
    + Number(Boolean(match.evidence));
}

function prioritizeEvidenceMatches(matches: readonly CollectedEvidenceMatch[]) {
  return [...matches]
    .sort((left, right) => right.priority - left.priority
      || evidenceCompletenessScore(right) - evidenceCompletenessScore(left)
      || left.order - right.order)
    .slice(0, MAX_EVIDENCE_MATCHES)
    .map(({ priority: _priority, order: _order, ...match }) => match);
}

function collectTextEvidenceMatches(rawText: string, params: unknown): CollectedEvidenceMatch[] {
  const output: CollectedEvidenceMatch[] = [];
  const paramsRecord = isRecord(params) ? params : {};
  const defaultRepo = firstString(paramsRecord, ["repo", "repository", "project"]);
  const defaultFile = firstString(paramsRecord, ["file", "filePath", "file_path", "path"]);
  const defaultLine = firstNumber(paramsRecord, ["startLine", "line_start", "lineStart", "line"]);
  const boundedText = rawText.slice(0, MAX_EVIDENCE_SCAN_LENGTH);
  const explicitPattern = /(?:^|\s)((?:src|app|lib|packages|test|tests)[\/\\][^\s:]+):(\d+)(?:-(\d+))?(?:\s*[|:]\s*(.*))?/giu;

  for (const [index, line] of boundedText.split(/\r?\n/u).entries()) {
    if (output.length >= MAX_EVIDENCE_MATCHES) break;
    const match = explicitPattern.exec(line);
    if (match) {
      const file = match[1];
      const lineNumber = match[2];
      if (!file || !lineNumber) continue;
      output.push({
        ...(defaultRepo ? { repo: defaultRepo } : {}),
        file,
        line: Number(lineNumber),
        ...(match[3] ? { endLine: Number(match[3]) } : {}),
        ...(match[4]?.trim() ? { evidence: truncateEvidence(match[4]) } : {}),
        priority: 1,
        order: output.length,
      });
      continue;
    }

    if (defaultFile && defaultLine !== undefined && line.trim()) {
      output.push({
        ...(defaultRepo ? { repo: defaultRepo } : {}),
        file: defaultFile,
        line: defaultLine + index,
        evidence: truncateEvidence(line),
        priority: 1,
        order: output.length,
      });
    }
  }
  return output;
}

const STRUCTURED_REPO_FIELD_PATTERN = /"(?:repo|repository|project)"\s*:\s*"((?:\\.|[^"\\])*)"/iu;
const STRUCTURED_MATCHES_FIELD_PATTERN = /"(?:matches|results)"\s*:\s*\[/iu;
const STRUCTURED_FILE_FIELD_PATTERN = /"(?:file|filePath|file_path|path)"\s*:\s*"((?:\\.|[^"\\])*)"/giu;
const STRUCTURED_LINE_FIELD_PATTERN = /"(?:line|lineNumber|startLine|line_start|lineStart)"\s*:\s*(?:"(\d+)"|(\d+))/iu;
const STRUCTURED_END_LINE_FIELD_PATTERN = /"(?:endLine|line_end|lineEnd)"\s*:\s*(?:"(\d+)"|(\d+))/iu;
const STRUCTURED_EVIDENCE_FIELD_PATTERN = /"(?:evidence|snippet|code|content|text|source)"\s*:\s*"((?:\\.|[^"\\])*)"/iu;

function decodeJsonString(value: string) {
  try {
    const decoded = JSON.parse(`"${value}"`);
    return typeof decoded === "string" ? decoded : "";
  } catch {
    return value;
  }
}

function firstStructuredNumber(pattern: RegExp, text: string) {
  const match = pattern.exec(text);
  return match ? Number(match[1] || match[2]) : undefined;
}

function firstStructuredString(pattern: RegExp, text: string) {
  const match = pattern.exec(text);
  return match?.[1] ? decodeJsonString(match[1]).trim() : undefined;
}

function collectStructuredTextEvidenceMatches(rawText: string, params: unknown): CollectedEvidenceMatch[] {
  const boundedText = rawText.slice(0, MAX_EVIDENCE_SCAN_LENGTH);
  const output: CollectedEvidenceMatch[] = [];
  let fileMatch: RegExpExecArray | null;
  while (fileMatch = STRUCTURED_FILE_FIELD_PATTERN.exec(boundedText)) {
    if (output.length >= MAX_EVIDENCE_CANDIDATES) break;
    const rawFile = fileMatch[1];
    if (!rawFile) continue;
    const file = decodeJsonString(rawFile).trim();
    if (!file) continue;
    const start = fileMatch.index;
    const inMatches = STRUCTURED_MATCHES_FIELD_PATTERN.lastIndex = 0;
    const matchField = STRUCTURED_MATCHES_FIELD_PATTERN.exec(boundedText);
    const priority = matchField && matchField.index < start ? 2 : 1;
    const previousObjectStart = boundedText.lastIndexOf("{", start);
    const previousObjectEnd = boundedText.lastIndexOf("}", start);
    const objectText = previousObjectStart > previousObjectEnd
      ? boundedText.slice(previousObjectStart, Math.min(boundedText.length, start + 16_384))
      : boundedText.slice(Math.max(0, start - 4_096), Math.min(boundedText.length, start + 16_384));
    const line = firstStructuredNumber(STRUCTURED_LINE_FIELD_PATTERN, objectText);
    const endLine = firstStructuredNumber(STRUCTURED_END_LINE_FIELD_PATTERN, objectText);
    const evidenceMatch = STRUCTURED_EVIDENCE_FIELD_PATTERN.exec(objectText);
    const evidence = evidenceMatch?.[1] ? truncateEvidence(decodeJsonString(evidenceMatch[1])) : undefined;
    const paramsRecord = isRecord(params) ? params : {};
    const repo = firstString(paramsRecord, ["repo", "repository", "project"])
      || firstStructuredString(STRUCTURED_REPO_FIELD_PATTERN, boundedText.slice(0, start));
    output.push({
      ...(repo ? { repo } : {}),
      file,
      ...(line !== undefined ? { line } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(evidence ? { evidence } : {}),
      priority,
      order: output.length,
    });
  }
  STRUCTURED_FILE_FIELD_PATTERN.lastIndex = 0;
  return output;
}

function buildStoredResultReadNext(stored: StoredToolResult, sourceTruncated = false) {
  if (stored.truncated || sourceTruncated) {
    return "结果超过安全存储上限或序列化边界，尾部未保存；可使用 tool_result_file_read 按 offset 读取已保存部分";
  }
  return "使用 tool_result_file_read 按 offset 读取完整结果";
}

function buildReferenceSummary(
  toolName: string,
  rawText: string,
  reason: string,
  stored: StoredToolResult = storeToolResult(rawText),
  sourceTruncated = false,
) {
  const preview = truncateEvidence(rawText.slice(0, MAX_REFERENCE_PREVIEW_SOURCE_LENGTH));
  return JSON.stringify({
    kind: "tool_result_reference",
    tool: toolName,
    status: "parse_failed",
    reason,
    originalSize: rawText.length,
    storedSize: stored.storedSize,
    storedTruncated: stored.truncated,
    sourceTruncated,
    fileId: stored.fileId,
    ...(preview ? { preview } : {}),
    next: buildStoredResultReadNext(stored, sourceTruncated),
  });
}

function buildSearchCondition(toolName: string, params: unknown) {
  if (!isRecord(params)) return truncateEvidence(toolName);
  const query = firstString(params, ["query", "searchText", "pattern", "sql", "filePath", "path", "route", "target"]);
  const repoValue = firstString(params, ["repo"]);
  const repo = repoValue ? ` repo=${truncateEvidence(repoValue)}` : "";
  return `${truncateEvidence(toolName)}${repo}${query ? ` ${truncateEvidence(query)}` : ""}`.trim();
}

function fitEvidenceSummary(base: Record<string, unknown>, matches: readonly EvidenceMatch[]) {
  for (let count = matches.length; count >= 0; count -= 1) {
    const candidate = JSON.stringify({ ...base, matches: matches.slice(0, count) });
    if (candidate.length <= MAX_EVIDENCE_SUMMARY_LENGTH) return candidate;
  }
  return JSON.stringify({ ...base, matches: [] });
}

function buildEvidenceSummary(toolName: string, rawText: string, params: unknown, sourceTruncated = false) {
  const parseSkipped = rawText.length > MAX_STRUCTURED_PARSE_LENGTH;
  const parsed = parseSkipped ? undefined : parseJson(rawText);
  const repoFromRaw = isRecord(parsed) ? firstString(parsed, ["repo", "repository", "project"]) : undefined;
  const matches = parseSkipped
    ? prioritizeEvidenceMatches([
      ...collectStructuredTextEvidenceMatches(rawText, { ...(isRecord(params) ? params : {}), ...(repoFromRaw ? { repo: repoFromRaw } : {}) }),
      ...collectTextEvidenceMatches(rawText, params),
    ])
    : parsed === undefined
      ? prioritizeEvidenceMatches(collectTextEvidenceMatches(rawText, params))
      : prioritizeEvidenceMatches(collectEvidenceMatches(parsed));
  if (matches.length === 0 && !sourceTruncated && !parseSkipped && isLikelyIrrelevantToolResult(rawText)) {
    return `本次检索未获得相关结果：${buildSearchCondition(toolName, params)}。后续避免重复使用相同条件。`;
  }
  const stored = storeToolResult(rawText);
  if (matches.length === 0) {
    return buildReferenceSummary(
      toolName,
      rawText,
      parseSkipped
        ? "结果过大，未找到可定位的文件或行号字段"
        : parsed === undefined ? "结果不是可解析的 JSON，且未找到可定位证据" : "未找到可定位的文件或行号字段",
      stored,
      sourceTruncated,
    );
  }
  const summary = {
    kind: "evidence_summary",
    tool: toolName,
    truncated: true,
    originalSize: rawText.length,
    storedSize: stored.storedSize,
    storedTruncated: stored.truncated,
    sourceTruncated,
    fileId: stored.fileId,
    matches,
    next: buildStoredResultReadNext(stored, sourceTruncated),
  };
  return fitEvidenceSummary(summary, matches);
}

function projectRepositories(value: unknown, depth = 0): Array<{ name: string; path?: string; branch?: string }> {
  if (depth > 5) return [];
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PROJECT_SUMMARY_ITEMS)
      .flatMap(item => projectRepositories(item, depth + 1));
  }
  if (!isRecord(value)) return [];

  for (const key of ["repositories", "repos", "projects"]) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) continue;
    const projected = candidate
      .slice(0, MAX_PROJECT_SUMMARY_ITEMS)
      .flatMap(item => {
      if (typeof item === "string" && item.trim()) return [{ name: truncateEvidence(item) }];
      if (!isRecord(item)) return [];
      const name = firstString(item, ["name", "repo", "repository", "project"]);
      if (!name) return [];
      const path = firstString(item, ["path", "filePath", "file_path"]);
      const branch = firstString(item, ["branch", "ref"]);
      return [{
        name: truncateEvidence(name),
        ...(path ? { path: truncateEvidence(path) } : {}),
        ...(branch ? { branch: truncateEvidence(branch) } : {}),
      }];
    });
    if (projected.length > 0) return projected.slice(0, MAX_PROJECT_SUMMARY_ITEMS);
  }

  for (const key of ["content", "text"]) {
    const nestedContent = value[key];
    if (typeof nestedContent === "string") {
      const parsedContent = parseJson(nestedContent);
      if (parsedContent !== undefined) return projectRepositories(parsedContent, depth + 1);
      continue;
    }
    if (Array.isArray(nestedContent) || isRecord(nestedContent)) {
      const projects = projectRepositories(nestedContent, depth + 1);
      if (projects.length > 0) return projects;
    }
  }

  return [];
}

function buildProjectSummary(toolName: string, rawText: string, sourceTruncated = false) {
  const stored = storeToolResult(rawText);
  if (rawText.length > MAX_STRUCTURED_PARSE_LENGTH) {
    return buildReferenceSummary(toolName, rawText, "项目清单过大，已跳过结构化解析", stored, sourceTruncated);
  }
  const parsed = parseJson(rawText);
  if (parsed === undefined) return buildReferenceSummary(toolName, rawText, "项目清单不是可解析的 JSON", stored, sourceTruncated);
  const projects = projectRepositories(parsed);
  if (projects.length === 0) return buildReferenceSummary(toolName, rawText, "未找到可定位的项目字段", stored, sourceTruncated);

  const summary = {
    kind: "project_scope_summary",
    tool: toolName,
    ...(isRecord(parsed) && typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
    originalSize: rawText.length,
    storedSize: stored.storedSize,
    storedTruncated: stored.truncated,
    sourceTruncated,
    fileId: stored.fileId,
    projects,
    next: buildStoredResultReadNext(stored, sourceTruncated),
  };
  const serialized = JSON.stringify(summary);
  if (serialized.length <= MAX_EVIDENCE_SUMMARY_LENGTH) return serialized;

  const compactProjects = projects.map(project => ({ name: project.name }));
  const compactSummary = JSON.stringify({ ...summary, projects: compactProjects });
  return compactSummary.length <= MAX_EVIDENCE_SUMMARY_LENGTH
    ? compactSummary
    : JSON.stringify({ ...summary, projects: compactProjects.slice(0, 12) });
}

function normalizeToolName(toolName: string) {
  return toolName.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isListReposTool(toolName: string) {
  return LIST_REPOS_TOOL_NAME_PATTERN.test(toolName);
}

function isEvidenceTool(toolName: string) {
  const normalized = normalizeToolName(toolName);
  return normalized === "query"
    || normalized.endsWith("gitnexusquery")
    || normalized === "codesnippet"
    || normalized.endsWith("gitnexuscodesnippet");
}

export function compressPiToolResult(toolName: string, value: unknown, params: unknown = {}) {
  const preserveStructure = isListReposTool(toolName) || isEvidenceTool(toolName);
  const serialized = serializePiToolResultWithMetadata(value, preserveStructure);
  const rawText = serialized.text;
  const sourceTruncated = serialized.truncated;
  if (isListReposTool(toolName)) return buildProjectSummary(toolName, rawText, sourceTruncated);
  if (isEvidenceTool(toolName) && (rawText.length > PI_TOOL_RESULT_THRESHOLD || sourceTruncated)) {
    return buildEvidenceSummary(toolName, rawText, params, sourceTruncated);
  }
  if (sourceTruncated) {
    return buildReferenceSummary(toolName, rawText, "结果对象超过安全序列化边界", undefined, true);
  }
  if (isEvidenceTool(toolName) && isLikelyIrrelevantToolResult(rawText)) {
    return `本次检索未获得相关结果：${buildSearchCondition(toolName, params)}。后续避免重复使用相同条件。`;
  }
  if (rawText.length > MAX_TOOL_RESULT_CONTENT_LENGTH) {
    return buildStoredToolResultPlaceholder(rawText, toolName, sourceTruncated);
  }
  return rawText;
}
