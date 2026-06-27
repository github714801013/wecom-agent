export interface AnalyzedCodeRange {
  filePath: string;
  symbol: string;
  startLine: number;
  endLine: number;
}

export interface CompressionSectionLike {
  file_path?: string;
  symbol?: string;
  lines?: string;
}

const MAX_SYMBOL_LENGTH = 120;
const SECTION_LINE_RANGE_PATTERN = /(?:L|line(?:s)?\s*)?(\d+)\s*(?:~|-|–|—|至|到)\s*(?:L|line(?:s)?\s*)?(\d+)/iu;
const SYMBOL_RANGE_PATTERN = /([/@A-Za-z_$\u4e00-\u9fa5][\w$./{}\-\u4e00-\u9fa5]{1,119})\s*[:：]\s*(?:L|第\s*)?(\d+)\s*(?:~|-|–|—|至|到)\s*(?:L)?(\d+)/gu;
const READ_LINE_RANGE_PATTERN = /(?:已读取|已分析|读取|分析).{0,8}?第\s*(\d+)\s*(?:~|-|–|—|至|到)\s*(\d+)\s*行/gu;

function normalizeSymbol(symbol: string, fallback: string) {
  const normalized = symbol
    .replace(/^[，。！？!?,;；：:、"'`()[\]{}<>]+|[，。！？!?,;；：:、"'`()[\]{}<>]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, MAX_SYMBOL_LENGTH);
}

function parseLineRange(text: string) {
  const match = text.match(SECTION_LINE_RANGE_PATTERN);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0) return null;
  return {
    startLine: Math.min(first, second),
    endLine: Math.max(first, second),
  };
}

function rangeKey(range: AnalyzedCodeRange) {
  const identity = range.symbol || range.filePath;
  return `${identity}\u0000${range.startLine}\u0000${range.endLine}`;
}

function uniqueRanges(ranges: AnalyzedCodeRange[], maxRanges: number) {
  const seen = new Set<string>();
  const result: AnalyzedCodeRange[] = [];
  for (const range of ranges) {
    if (!range.symbol || range.startLine <= 0 || range.endLine <= 0) continue;
    const key = rangeKey(range);
    if (seen.has(key)) {
      const existing = result.find(item => rangeKey(item) === key);
      if (existing && !existing.filePath && range.filePath) {
        existing.filePath = range.filePath;
      }
      continue;
    }
    seen.add(key);
    result.push(range);
    if (result.length >= maxRanges) break;
  }
  return result;
}

export function analyzedCodeRangesFromCompressionSections(
  sections: CompressionSectionLike[] = [],
  maxRanges = 30,
) {
  const ranges: AnalyzedCodeRange[] = [];
  for (const section of sections) {
    const lineRange = parseLineRange(section.lines || "");
    if (!lineRange) continue;
    const filePath = String(section.file_path || "").trim();
    const symbol = normalizeSymbol(String(section.symbol || ""), filePath || "未知代码片段");
    ranges.push({
      filePath,
      symbol,
      ...lineRange,
    });
  }
  return uniqueRanges(ranges, maxRanges);
}

export function analyzedCodeRangesFromText(text: string, maxRanges = 30) {
  const ranges: AnalyzedCodeRange[] = [];

  for (const line of text.split(/\r?\n/gu)) {
    const lineMatches: Array<{ index: number; range: AnalyzedCodeRange }> = [];

    for (const match of line.matchAll(SYMBOL_RANGE_PATTERN)) {
      const first = Number(match[2]);
      const second = Number(match[3]);
      if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0) continue;
      lineMatches.push({
        index: match.index ?? 0,
        range: {
          filePath: "",
          symbol: normalizeSymbol(match[1] || "", "未知代码片段"),
          startLine: Math.min(first, second),
          endLine: Math.max(first, second),
        },
      });
    }

    for (const match of line.matchAll(READ_LINE_RANGE_PATTERN)) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0) continue;
      lineMatches.push({
        index: match.index ?? 0,
        range: {
          filePath: "",
          symbol: "已读取",
          startLine: Math.min(first, second),
          endLine: Math.max(first, second),
        },
      });
    }

    for (const item of lineMatches.sort((left, right) => left.index - right.index)) {
      ranges.push(item.range);
      if (ranges.length >= maxRanges) return uniqueRanges(ranges, maxRanges);
    }
  }

  return uniqueRanges(ranges, maxRanges);
}

export function buildAnalyzedCodeRangeIndex(input: {
  sections?: CompressionSectionLike[];
  texts?: string[];
  maxRanges?: number;
}) {
  const maxRanges = input.maxRanges ?? 30;
  return uniqueRanges([
    ...analyzedCodeRangesFromCompressionSections(input.sections || [], maxRanges),
    ...(input.texts || []).flatMap(text => analyzedCodeRangesFromText(text, maxRanges)),
  ], maxRanges);
}

export function formatAnalyzedCodeRangeIndex(
  ranges: AnalyzedCodeRange[],
  emptyText = "- 暂无明确已分析代码范围索引",
) {
  if (ranges.length === 0) return emptyText;
  return ranges.map(range => {
    const filePart = range.filePath ? `（文件: ${range.filePath}）` : "";
    return `- ${range.symbol}:${range.startLine}~${range.endLine}${filePart}`;
  }).join("\n");
}
