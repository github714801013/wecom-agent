export interface ToolContextRecord {
  id: string;
  name: string;
  args: string;
  content: string;
}

const NO_HIT_PATTERNS = [
  /no results?/i,
  /not found/i,
  /0\s+results?/i,
  /row_count["']?\s*:\s*0/i,
  /total["']?\s*:\s*0/i,
  /未找到/,
  /未检索到/,
  /没有检索到/,
  /无相关结果/,
  /无匹配/,
];

function truncateText(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function parseArgs(args: string) {
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function getSearchCondition(record: ToolContextRecord) {
  const args = parseArgs(record.args);
  const query = args.query ?? args.searchText ?? args.pattern ?? args.sql ?? args.filePath ?? args.path ?? args.route ?? args.target;
  const repo = args.repo ? ` repo=${String(args.repo)}` : "";
  const queryText = query ? ` ${String(query)}` : "";
  return `${record.name}${repo}${queryText}`.trim();
}

function tokenize(text: string) {
  return Array.from(new Set(text
    .toLowerCase()
    .split(/[^a-z0-9_\-\u4e00-\u9fa5]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2)));
}

function hasEnoughOverlap(record: ToolContextRecord) {
  const args = parseArgs(record.args);
  const queryText = [
    args.query,
    args.searchText,
    args.pattern,
    args.sql,
    args.filePath,
    args.path,
    args.route,
    args.target,
  ].filter(Boolean).join(" ");
  const tokens = tokenize(queryText);
  if (tokens.length === 0) return true;

  const content = record.content.toLowerCase();
  return tokens.some(token => content.includes(token));
}

export function isLikelyIrrelevantToolResult(content: string) {
  const normalized = content.trim();
  if (!normalized || normalized === "[]" || normalized === "{}") return true;
  return NO_HIT_PATTERNS.some(pattern => pattern.test(normalized));
}

export function filterToolResultForCurrentTurn(record: ToolContextRecord) {
  const condition = getSearchCondition(record);

  if (isLikelyIrrelevantToolResult(record.content)) {
    return `本次检索未获得相关结果：${condition}。后续避免重复使用相同条件。`;
  }

  if (record.content.length > 6000 && !hasEnoughOverlap(record)) {
    return `本次检索结果过长且与检索条件相关性较低：${condition}。已丢弃原始结果，后续避免重复使用相同条件。`;
  }

  return record.content;
}

export function buildToolContextSummary(records: ToolContextRecord[]) {
  const effectiveRecords = records.filter(record => !isLikelyIrrelevantToolResult(record.content));
  const ineffectiveRecords = records.filter(record => isLikelyIrrelevantToolResult(record.content));

  const effectiveEvidence = effectiveRecords
    .slice(-8)
    .map(record => `- ${getSearchCondition(record)}\n  ${truncateText(record.content.replace(/\s+/g, " ").trim(), 1200)}`)
    .join("\n");

  const ineffectiveConditions = ineffectiveRecords
    .slice(-20)
    .map(record => `- ${getSearchCondition(record)}：无相关结果，后续避免重复使用相同条件`)
    .join("\n");

  if (!effectiveEvidence && !ineffectiveConditions) return "";

  return `【本轮工具上下文摘要】
有效工具证据:
${effectiveEvidence || "- 无"}

无效检索条件:
${ineffectiveConditions || "- 无"}`;
}
