export type ActiveMessageIntent = "stop" | "continue_current" | "replace_with_followup";
export interface ConversationContextItem {
  role: "user" | "assistant" | "system";
  content: string;
}

export type HistoryRelevanceDecision = "related" | "independent" | "uncertain";

export interface HistoryRelevanceResult {
  decision: HistoryRelevanceDecision;
  reason: string;
}

const STOP_PATTERNS = [
  /^(停|停止|别查了|不用查了|先停|暂停|中止|终止|取消|算了|不用了|别回答了|不要回答了)$/i,
  /^(kill|kills|stop|cancel|abort)$/i,
];

const CONTINUE_PATTERNS = [
  /^(继续|接着|接着查|继续查|继续核实|继续回答|往下查|继续处理)$/i,
  /^(continue|go on|keep going)$/i,
];

const NEW_TOPIC_PATTERNS = [
  /^(新问题|另一个问题|另外一个问题|换个问题|重新开始|不要参考上文|不用参考上文)/i,
  /^(new topic|another question|reset context)/i,
];

const SHORT_FOLLOWUP_PATTERNS = [
  /^(怎么验证|如何验证|为什么|那怎么改|怎么改|下一步|继续下一步|怎么处理)$/i,
  /^(why|how|next|what next)$/i,
];

const COMPOUND_CONTINUE_PATTERN = /(继续|接着|往下查|继续排查|继续处理|continue|go on|keep going)/i;

const JIRA_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\s，。！？!?,;；：:]+/;
const POSIX_OR_CODE_PATH_PATTERN = /\b(?:src|config|test|tests)\/[^\s，。！？!?,;；：:]+/;
const API_PATH_PATTERN = /\/api\/[A-Za-z0-9][A-Za-z0-9/_{}.-]*/i;

const MAINTAINED_REPO_ANCHORS = [
  "wecom-agent",
  "GitNexus",
  "oa-api",
  "oa-order",
  "oa-stock",
  "oa-after",
  "web",
  "logistics",
  "autoTransfer",
];

const JAVA_FILE_PATTERN = /\b[A-Z][A-Za-z0-9_$]*(?:Controller|ServiceImpl|Service|Mapper|Dao|Repository|Client|Cloud|BO|DTO|VO)?\.java\b/;
const CAMEL_METHOD_PATTERN = /\b[a-z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/;
const CODE_SPAN_PATTERN = /`([^`\n]{2,120})`/;
const CONFIRMED_EVIDENCE_PATTERN = /(命中|确认|入口|方法|类名|文件|接口|仓库|repo|有效工具证据|code_snippet)/;
const BUSINESS_MESSAGE_PATTERN = /[\u4e00-\u9fa5A-Za-z0-9 ]{0,20}(?:已超过|失败|异常|错误|提示|拦截|不允许|不能|无法)[\u4e00-\u9fa5A-Za-z0-9 ]{0,20}/;

function normalizeActiveMessage(text: string) {
  return text
    .trim()
    .replace(/^[@＠][^\s，。！？!?,;；：:、]+[\s，。！？!?,;；：:、]*/u, "")
    .replace(/[\s，。！？!?.]+$/u, "")
    .trim();
}

export function detectActiveMessageIntent(text: string): ActiveMessageIntent {
  const normalized = normalizeActiveMessage(text);
  if (!normalized) return "continue_current";

  if (STOP_PATTERNS.some(pattern => pattern.test(normalized))) {
    return "stop";
  }

  if (CONTINUE_PATTERNS.some(pattern => pattern.test(normalized))) {
    return "continue_current";
  }

  return "replace_with_followup";
}

export function buildFollowupQuestion(previousQuestion: string, followup: string) {
  const previous = previousQuestion.trim();
  const current = followup.trim();

  if (!previous) return current;
  if (!current) return previous;

  return `【用户追问整合】
原问题：
${previous}

用户追问：
${current}

处理要求：
请把“用户追问”作为对“原问题”的补充或修正，先整合成同一个问题再继续回答；不要只回答追问中的片段。
已确认锚点必须优先继承：如果原问题或上一轮回答里已经确认项目、仓库、接口路径、入口文件、入口方法、类名、方法名、符号、表名或字段名，继续检索时必须优先带着这些锚点查；不要重新放宽到其它项目、其它技术栈或宽泛业务词。`;
}

function compactText(text: string, maxLength: number) {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength)}...`;
}

function collectPatternMatches(text: string, pattern: RegExp) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return Array.from(text.matchAll(new RegExp(pattern.source, flags))).map(match => match[0]);
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractStrongAnchors(text: string) {
  const anchors = [
    ...collectPatternMatches(text, JIRA_KEY_PATTERN),
    ...collectPatternMatches(text, WINDOWS_PATH_PATTERN),
    ...collectPatternMatches(text, POSIX_OR_CODE_PATH_PATTERN),
    ...collectPatternMatches(text, API_PATH_PATTERN),
    ...collectPatternMatches(text, JAVA_FILE_PATTERN),
    ...collectPatternMatches(text, CAMEL_METHOD_PATTERN)
      .filter(anchor => anchor.length >= 6),
    ...MAINTAINED_REPO_ANCHORS.filter(anchor => text.includes(anchor)),
  ];
  return uniqueValues(anchors.map(anchor => anchor.trim()));
}

function extractBusinessMessageAnchors(text: string) {
  return collectPatternMatches(text, BUSINESS_MESSAGE_PATTERN)
    .map(anchor => anchor.replace(/^[，。！？!?,;；：:\s]+|[，。！？!?,;；：:\s]+$/g, "").trim())
    .filter(anchor => anchor.length >= 4 && anchor.length <= 60);
}

export function extractConfirmedAnchorsFromHistory(history: ConversationContextItem[]) {
  const anchorCandidates = history.flatMap(item => {
    const normalized = normalizeActiveMessage(item.content);
    const codeSpanAnchors = collectPatternMatches(normalized, CODE_SPAN_PATTERN).map(match => match.replace(/^`|`$/g, ""));
    const evidenceAnchors = CONFIRMED_EVIDENCE_PATTERN.test(normalized)
      ? [
        ...extractStrongAnchors(normalized),
        ...extractBusinessMessageAnchors(normalized),
      ]
      : [];
    return [...codeSpanAnchors, ...evidenceAnchors];
  });

  return uniqueValues(anchorCandidates)
    .filter(anchor => anchor.length >= 2 && anchor.length <= 120)
    .slice(0, 32);
}

function computeAnchorOverlap(history: ConversationContextItem[], currentQuestion: string) {
  const currentAnchors = extractStrongAnchors(currentQuestion);
  const historyAnchors = uniqueValues(
    history.flatMap(item => extractStrongAnchors(normalizeActiveMessage(item.content))),
  );
  const hasOverlap = currentAnchors.some(anchor => historyAnchors.includes(anchor));
  const hasDifference = currentAnchors.length > 0
    && historyAnchors.length > 0
    && currentAnchors.some(anchor => !historyAnchors.includes(anchor));
  return { hasOverlap, hasDifference };
}

export function classifyHistoryRelevance(
  history: ConversationContextItem[],
  currentQuestion: string,
): HistoryRelevanceResult {
  const normalized = normalizeActiveMessage(currentQuestion);
  if (!normalized || history.length === 0) {
    return { decision: "uncertain", reason: "empty-current-or-history" };
  }

  if (NEW_TOPIC_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { decision: "independent", reason: "explicit-new-topic" };
  }

  if (CONTINUE_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { decision: "related", reason: "explicit-continue" };
  }

  const anchorOverlap = computeAnchorOverlap(history, normalized);

  if (COMPOUND_CONTINUE_PATTERN.test(normalized) && anchorOverlap.hasOverlap) {
    return { decision: "uncertain", reason: "compound-continue-with-overlap" };
  }

  if (anchorOverlap.hasDifference && !anchorOverlap.hasOverlap) {
    return { decision: "independent", reason: "different-strong-anchor" };
  }

  if (SHORT_FOLLOWUP_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { decision: "related", reason: "short-followup" };
  }

  return { decision: "uncertain", reason: "no-reliable-signal" };
}

export function buildQuestionWithHistory(
  history: ConversationContextItem[],
  currentQuestion: string,
) {
  const current = currentQuestion.trim();
  if (!current || history.length === 0) return current;

  const relevantHistory = history
    .filter(item => item.content.trim())
    .slice(-4)
    .map(item => {
      const label = item.role === "user" ? "用户" : item.role === "assistant" ? "助手" : "系统";
      return `${label}: ${compactText(item.content, 500)}`;
    })
    .join("\n");

  if (!relevantHistory) return current;

  const confirmedAnchors = extractConfirmedAnchorsFromHistory(history);
  const confirmedAnchorBlock = confirmedAnchors.length > 0
    ? `\n\n已确认锚点清单（必须优先继承，禁止因历史摘要截断而丢弃）：\n${confirmedAnchors.map(anchor => `- ${anchor}`).join("\n")}`
    : "";

  return `【历史上下文整合】
相关历史：
${relevantHistory}${confirmedAnchorBlock}

当前问题：
${current}

处理要求：
请先结合“相关历史”和“当前问题”整合成一个明确问题，再继续回答；如果当前问题明显是全新问题，只保留当前问题并忽略无关历史。
已确认锚点必须优先继承：如果相关历史里已经确认项目、仓库、接口路径、入口文件、入口方法、类名、方法名、符号、表名或字段名，继续检索时必须优先带着这些锚点查；不要重新放宽到其它项目、其它技术栈或宽泛业务词。`;
}
