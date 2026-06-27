import { tool } from "@langchain/core/tools";
import { BaseMessage, AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  buildRelationshipIndex,
  formatRelationshipIndex,
  type CompressionCallChainEdge,
  type RelationshipEdge,
} from "./relationship-index.js";
import {
  buildAnalyzedCodeRangeIndex,
  formatAnalyzedCodeRangeIndex,
  type AnalyzedCodeRange,
  type CompressionSectionLike,
} from "./analyzed-code-range-index.js";

export interface SessionMemoryRecord {
  id: string;
  role: "user" | "assistant" | "system" | "compression";
  summary: string;
  anchors: string[];
  createdAt: number;
}

export interface SessionMemoryGraph {
  records: SessionMemoryRecord[];
  relationships: RelationshipEdge[];
  analyzedRanges: AnalyzedCodeRange[];
  updatedAt: number;
}

export interface CompressionMemoryInput {
  intent: string;
  keyEvidence: string[];
  missingInfo: string[];
  sections: Array<CompressionSectionLike & { content?: unknown }>;
  callChain?: CompressionCallChainEdge[];
}

const MAX_RECORDS = 80;
const MAX_RECORD_SUMMARY_LENGTH = 900;
const MAX_ANCHORS_PER_RECORD = 24;
const MAX_RELATIONSHIPS = 80;
const MAX_ANALYZED_RANGES = 80;
const MAX_QUERY_RECORDS = 6;
const MAX_QUERY_RELATIONSHIPS = 12;
const MAX_QUERY_RANGES = 12;
const TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_$]{2,}|[\u4e00-\u9fa5]{2,}|\/[A-Za-z0-9/_{}.-]+|[A-Za-z]:\\[^\s，。；;]+/g;
const GENERIC_TOKENS = new Set([
  "当前",
  "问题",
  "继续",
  "查询",
  "核实",
  "分析",
  "逻辑",
  "接口",
  "方法",
  "调用",
  "结果",
  "用户",
]);

function stringifyMessageContent(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) {
        return String((item as { text?: unknown }).text ?? "");
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function compactText(text: string, maxLength = MAX_RECORD_SUMMARY_LENGTH) {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength)}...`;
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string, maxItems: number) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

function extractAnchors(text: string, extra: string[] = []) {
  const tokens = [
    ...extra,
    ...Array.from(text.matchAll(TOKEN_PATTERN)).map(match => match[0]),
  ]
    .map(token => token.trim())
    .filter(token => token.length >= 2)
    .filter(token => !GENERIC_TOKENS.has(token));
  return Array.from(new Set(tokens)).slice(0, MAX_ANCHORS_PER_RECORD);
}

function messageRole(message: BaseMessage): SessionMemoryRecord["role"] {
  if (message instanceof HumanMessage) return "user";
  if (message instanceof AIMessage) return "assistant";
  if (message instanceof SystemMessage) return "system";
  return "system";
}

function relationshipKey(edge: RelationshipEdge) {
  return `${edge.from}\u0000${edge.relation}\u0000${edge.to}`;
}

function rangeKey(range: AnalyzedCodeRange) {
  return `${range.filePath}\u0000${range.symbol}\u0000${range.startLine}\u0000${range.endLine}`;
}

function recordKey(record: SessionMemoryRecord) {
  return `${record.role}\u0000${record.summary}`;
}

export function appendMessagesToSessionMemoryGraph(
  graph: SessionMemoryGraph | undefined,
  messages: BaseMessage[],
  now = Date.now(),
): SessionMemoryGraph {
  const texts = messages.map(message => stringifyMessageContent(message.content)).filter(text => text.trim());
  const newRecords = messages
    .map((message, index) => {
      const content = stringifyMessageContent(message.content);
      if (!content.trim()) return null;
      return {
        id: `msg_${now}_${index}`,
        role: messageRole(message),
        summary: compactText(content),
        anchors: extractAnchors(content),
        createdAt: now + index,
      } satisfies SessionMemoryRecord;
    })
    .filter((record): record is SessionMemoryRecord => Boolean(record));

  return mergeSessionMemoryGraph(graph, {
    records: newRecords,
    relationships: buildRelationshipIndex({ texts, maxEdges: MAX_RELATIONSHIPS }),
    analyzedRanges: buildAnalyzedCodeRangeIndex({ texts, maxRanges: MAX_ANALYZED_RANGES }),
    updatedAt: now,
  });
}

export function appendCompressionToSessionMemoryGraph(
  graph: SessionMemoryGraph | undefined,
  input: CompressionMemoryInput,
  now = Date.now(),
): SessionMemoryGraph {
  const sectionTexts = input.sections.map(section => {
    const filePath = section.file_path ? `文件: ${section.file_path}` : "";
    const symbol = section.symbol ? `符号: ${section.symbol}` : "";
    const lines = section.lines ? `行号: ${section.lines}` : "";
    return [filePath, symbol, lines].filter(Boolean).join(" ");
  });
  const texts = [
    input.intent,
    ...input.keyEvidence,
    ...sectionTexts,
    ...input.sections.map(section => {
      const content = "content" in section ? String((section as { content?: unknown }).content ?? "") : "";
      return content;
    }),
  ].filter(text => text.trim());

  const summaryParts = [
    `意图: ${input.intent}`,
    input.keyEvidence.length ? `关键证据: ${input.keyEvidence.map(item => compactText(item, 180)).join(" | ")}` : "",
    input.missingInfo.length ? `缺失信息: ${input.missingInfo.join(" | ")}` : "",
  ].filter(Boolean);

  return mergeSessionMemoryGraph(graph, {
    records: [{
      id: `compression_${now}`,
      role: "compression",
      summary: compactText(summaryParts.join("；"), 1200),
      anchors: extractAnchors(texts.join("\n"), [input.intent]),
      createdAt: now,
    }],
    relationships: buildRelationshipIndex({
      ...(input.callChain ? { callChain: input.callChain } : {}),
      texts,
      maxEdges: MAX_RELATIONSHIPS,
    }),
    analyzedRanges: buildAnalyzedCodeRangeIndex({
      sections: input.sections,
      texts,
      maxRanges: MAX_ANALYZED_RANGES,
    }),
    updatedAt: now,
  });
}

function mergeSessionMemoryGraph(
  current: SessionMemoryGraph | undefined,
  next: SessionMemoryGraph,
): SessionMemoryGraph {
  const records = uniqueBy(
    [...(current?.records || []), ...next.records].slice(-MAX_RECORDS * 2),
    recordKey,
    MAX_RECORDS,
  ).slice(-MAX_RECORDS);

  return {
    records,
    relationships: uniqueBy(
      [...(current?.relationships || []), ...next.relationships],
      relationshipKey,
      MAX_RELATIONSHIPS,
    ),
    analyzedRanges: uniqueBy(
      [...(current?.analyzedRanges || []), ...next.analyzedRanges],
      rangeKey,
      MAX_ANALYZED_RANGES,
    ),
    updatedAt: next.updatedAt,
  };
}

function scoreText(text: string, queryTokens: string[]) {
  if (queryTokens.length === 0) return 1;
  return queryTokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
}

export function querySessionMemoryGraph(
  graph: SessionMemoryGraph | undefined,
  query: string,
  limit = MAX_QUERY_RECORDS,
) {
  const safeLimit = Math.max(1, Math.min(limit, 12));
  const queryTokens = extractAnchors(query, []);
  const scoredRecords = (graph?.records || [])
    .map(record => ({
      record,
      score: scoreText(`${record.summary}\n${record.anchors.join("\n")}`, queryTokens),
    }))
    .filter(item => queryTokens.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || right.record.createdAt - left.record.createdAt)
    .slice(0, safeLimit)
    .map(item => item.record);

  const relationshipMatches = (graph?.relationships || [])
    .map(edge => ({
      edge,
      score: scoreText(`${edge.from}\n${edge.to}\n${edge.evidence || ""}`, queryTokens),
    }))
    .filter(item => queryTokens.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_QUERY_RELATIONSHIPS)
    .map(item => item.edge);

  const rangeMatches = (graph?.analyzedRanges || [])
    .map(range => ({
      range,
      score: scoreText(`${range.filePath}\n${range.symbol}`, queryTokens),
    }))
    .filter(item => queryTokens.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_QUERY_RANGES)
    .map(item => item.range);

  return {
    query,
    query_anchors: queryTokens,
    has_memory: Boolean(graph && (graph.records.length || graph.relationships.length || graph.analyzedRanges.length)),
    records: scoredRecords,
    relationship_index: formatRelationshipIndex(relationshipMatches),
    analyzed_code_range_index: formatAnalyzedCodeRangeIndex(rangeMatches),
    memory_updated_at: graph?.updatedAt || null,
  };
}

export function buildSessionMemoryGraphTool(input: {
  graph: SessionMemoryGraph | undefined;
  currentQuestion: string;
}) {
  return tool(
    async (args) => {
      const query = (args.query || input.currentQuestion || "").trim();
      const result = querySessionMemoryGraph(input.graph, query, args.limit);
      return JSON.stringify(result);
    },
    {
      name: "session_memory_graph_query",
      description: [
        "按需查询当前会话的短时记忆图，返回与 query 相关的历史问题、已确认锚点、接口/方法调用关系、已分析代码行号范围。",
        "当历史上下文可能被压缩、当前是“继续/追问”、需要继承上一轮接口/仓库/方法/文件/表字段/已分析范围，或需要避免重复读取相同代码时调用。",
        "不要要求用户补充已经可能存在于短时记忆图中的信息；先调用本工具查询。",
      ].join(""),
      schema: z.object({
        query: z.string().describe("当前要召回的目标问题、接口、方法、文件、字段或业务词。").optional(),
        limit: z.number().int().min(1).max(12).describe("最多返回的相关记忆条数，默认 6。").optional(),
      }),
    },
  );
}
