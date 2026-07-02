function splitProgressSentences(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。.!！?？])\s*/u)
    .map(item => item.trim())
    .filter(Boolean);
}

// 过程话术关键词表：用于识别"模型仍在阶段性处理、未形成最终结论"的句子。
// 第一人称承诺句 + 未来动作 + 承诺后续但无结论的句式。
export const PROGRESS_KEYWORDS = [
  "继续核实中",
  "继续读取",
  "继续确认",
  "继续核实",
  "准备输出结论",
  "继续追踪",
  "继续排查",
  "继续查找",
  "继续搜索",
  "继续分析",
  "整理给你",
  "给你整理",
  "给你反馈",
  "反馈给你",
  "接下来会查",
  "接下来去查",
  "接下来读",
  "接下来看",
  "接下来确认",
  "接下来核实",
  "我会继续",
  "我将继续",
  "我会去追踪",
  "我会去核实",
  "我会去读取",
  "我会去排查",
  "我会去查找",
  "我会去确认",
  "我将去追踪",
  "我会接着",
  "我会围绕",
  "如果核实过程中",
  "核实过程中确认",
  "我需要核实",
  "我需要确认",
  "需要核实",
  "需要确认",
  "我将继续围绕",
  "顺着代码",
  "顺着调用链",
  "具体会顺着",
  "正在调用",
];

function isProgressSentence(sentence: string) {
  return PROGRESS_KEYWORDS.some(keyword => sentence.includes(keyword));
}

const FINAL_ANSWER_TAG_PATTERN = /<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/gi;
const AGENT_PROGRESS_TAG_PATTERN = /<agent_progress>\s*([\s\S]*?)\s*<\/agent_progress>/gi;
const PROTOCOL_TAG_TOKEN_PATTERN = /<\/?(?:agent_progress|final_answer)>/gi;
const PROTOCOL_TAG_PREFIXES = ["<agent_progress", "</agent_progress", "<final_answer", "</final_answer"];
const EMPTY_PROTOCOL_CONTENT_PATTERN = /\[System: Empty message content sanitised to satisfy protocol\]/g;
const THINK_BLOCK_PATTERN = /<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi;
const THINK_TAG_TOKEN_PATTERN = /<\/?think(?:ing)?\b[^>]*>/gi;
const INCOMPLETE_FINAL_NOTICE_PATTERN = /不是最终结论|完整结论还需要继续补齐证据闭环/;
const ACTIVE_TOOL_LINE_PATTERN = /^>.*正在调用[:：]/u;
const PUNCTUATION_ONLY_PATTERN = /^[\s.。!！?？,，;；:：-]+$/u;

export function stripProtocolNoise(content: string): string {
  return content
    .replace(EMPTY_PROTOCOL_CONTENT_PATTERN, "")
    .replace(THINK_BLOCK_PATTERN, "")
    .replace(THINK_TAG_TOKEN_PATTERN, "");
}

function getLastTaggedContent(content: string, pattern: RegExp): string {
  const matches = Array.from(content.matchAll(pattern));
  const lastMatch = matches[matches.length - 1];
  return lastMatch?.[1]?.trim() || "";
}

function stripTaggedContent(content: string): string {
  return content
    .replace(FINAL_ANSWER_TAG_PATTERN, "")
    .replace(AGENT_PROGRESS_TAG_PATTERN, "")
    .trim();
}

function stripProtocolTagTokens(content: string): string {
  return content.replace(PROTOCOL_TAG_TOKEN_PATTERN, "").trim();
}

function collapsePlainProgressContent(content: string): string {
  const trimmed = content.trim();
  if (!PROGRESS_KEYWORDS.some(keyword => trimmed.includes(keyword))) return content;

  const sentences = splitProgressSentences(trimmed);
  const visibleSentences = sentences.filter(sentence =>
    !INCOMPLETE_FINAL_NOTICE_PATTERN.test(sentence)
    && !ACTIVE_TOOL_LINE_PATTERN.test(sentence)
    && !PUNCTUATION_ONLY_PATTERN.test(sentence)
  );
  let lastProgressIndex = -1;
  for (let index = visibleSentences.length - 1; index >= 0; index -= 1) {
    const sentence = visibleSentences[index];
    if (sentence && isProgressSentence(sentence)) {
      lastProgressIndex = index;
      break;
    }
  }
  if (lastProgressIndex < 0) return visibleSentences.join("\n\n").trim() || trimmed;

  const nonProgressSentencesAfterProgress = visibleSentences
    .slice(lastProgressIndex + 1)
    .filter(sentence => !isProgressSentence(sentence));

  if (nonProgressSentencesAfterProgress.length > 0) {
    return nonProgressSentencesAfterProgress.join("\n\n").trim();
  }

  const nonProgressSentencesBeforeProgress = visibleSentences
    .slice(0, lastProgressIndex)
    .filter(sentence => !isProgressSentence(sentence));

  if (nonProgressSentencesBeforeProgress.length > 0) {
    return nonProgressSentencesBeforeProgress.join("\n\n").trim();
  }

  return visibleSentences[lastProgressIndex] || trimmed;
}

function extractTaggedDisplayContent(content: string): string {
  const finalAnswer = getLastTaggedContent(content, FINAL_ANSWER_TAG_PATTERN);
  if (finalAnswer) return finalAnswer;

  const remainingContent = stripTaggedContent(content);
  if (remainingContent) return collapsePlainProgressContent(stripProtocolTagTokens(remainingContent));

  return getLastTaggedContent(content, AGENT_PROGRESS_TAG_PATTERN);
}

function isIncompleteProtocolTagPrefix(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length > 0
    && !trimmed.includes(">")
    && PROTOCOL_TAG_PREFIXES.some(prefix => prefix.startsWith(trimmed.toLowerCase()));
}

const PROCESSING_FRAMES = ["◐", "◓", "◑", "◒"];
const LEGACY_PROCESSING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const USER_FACING_PROGRESS_TEXT = {
  thinking: "正在理解你的问题。",
  searching: "正在查询相关信息，请稍候。",
  generating: "正在整理回复。",
  processing: "正在处理，请稍候。",
} as const;

const THINKING_HEARTBEAT_TEXTS = [
  USER_FACING_PROGRESS_TEXT.thinking,
  USER_FACING_PROGRESS_TEXT.searching,
  USER_FACING_PROGRESS_TEXT.generating,
  USER_FACING_PROGRESS_TEXT.processing,
];

const TECHNICAL_PROGRESS_PATTERN = /MCP|mcp|RAG|rag|Tool|tool|工具|预检索|检索|锚点|证据|代码|仓库|项目范围|业务分析节点|节点|调用|模型|stream|chunk|query|code_snippet|gitnexus|zoekt|runtime_todolist/u;
const THINKING_PROGRESS_PATTERN = /收到问题|识别意图|理解|问题规划|规划|读取消息|分析请求/u;
const GENERATING_PROGRESS_PATTERN = /整理回复|整理结果|输出结论|准备输出|生成回答|整理给你|给你整理/u;

const HEARTBEAT_STRIP_FRAMES = [...PROCESSING_FRAMES, ...LEGACY_PROCESSING_FRAMES];
const LEGACY_HEARTBEAT_TEXTS = ["仍在分析中", "仍在核实中", "仍在整理证据中", "仍在等待模型响应"];
const HEARTBEAT_TEXT_STEMS = [...THINKING_HEARTBEAT_TEXTS, ...LEGACY_HEARTBEAT_TEXTS]
  .map(text => text.replace(/[。.]$/u, ""));

function isThinkingHeartbeatLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  const withoutFrame = HEARTBEAT_STRIP_FRAMES.reduce(
    (current, frame) => current.startsWith(`${frame} `) ? current.slice(frame.length + 1).trim() : current,
    trimmed,
  );
  const normalized = withoutFrame.replace(/^处理中[:：]\s*/u, "").replace(/\.{1,3}$/u, "").trim();
  return HEARTBEAT_TEXT_STEMS.some(text => normalized.startsWith(text));
}

function stripThinkingHeartbeatContent(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(line => !isThinkingHeartbeatLine(line))
    .join("\n")
    .trim();
}

export function getProcessingFrame(now = Date.now()) {
  return PROCESSING_FRAMES[Math.floor(now / 1000) % PROCESSING_FRAMES.length] || PROCESSING_FRAMES[0]!;
}

function hasProcessingFramePrefix(content: string) {
  const trimmed = content.trimStart();
  return HEARTBEAT_STRIP_FRAMES.some(frame => trimmed.startsWith(`${frame} `));
}

function isUserFacingProgressText(content: string) {
  const trimmed = content.trim();
  return Object.values(USER_FACING_PROGRESS_TEXT).some(text => trimmed === text);
}

function isTechnicalOrInternalProgress(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return TECHNICAL_PROGRESS_PATTERN.test(trimmed)
    || PROGRESS_KEYWORDS.some(keyword => trimmed.includes(keyword));
}

export function buildUserFacingProgressContent(content: string, activeCalls: string[] = []) {
  const displayContent = collapseProgressUpdates(content).trim();

  if (activeCalls.length > 0) return USER_FACING_PROGRESS_TEXT.searching;
  if (!displayContent) return "";
  if (isUserFacingProgressText(displayContent)) return displayContent;

  if (GENERATING_PROGRESS_PATTERN.test(displayContent)) return USER_FACING_PROGRESS_TEXT.generating;
  if (THINKING_PROGRESS_PATTERN.test(displayContent)) return USER_FACING_PROGRESS_TEXT.thinking;
  if (isTechnicalOrInternalProgress(displayContent)) return USER_FACING_PROGRESS_TEXT.searching;

  return displayContent;
}

export function buildIntermediateStreamContent(content: string, now = Date.now()) {
  const safeContent = buildUserFacingProgressContent(stripProtocolNoise(content)).trim();
  if (!safeContent || hasProcessingFramePrefix(safeContent)) return safeContent;

  return `${getProcessingFrame(now)} ${safeContent}`;
}

export function collapseProgressUpdates(content: string): string {
  const trimmed = stripThinkingHeartbeatContent(stripProtocolNoise(content));
  if (isIncompleteProtocolTagPrefix(trimmed)) return "";

  if (/<\/?(?:agent_progress|final_answer)>/i.test(trimmed)) {
    return extractTaggedDisplayContent(trimmed);
  }

  return collapsePlainProgressContent(trimmed);
}

export function buildProgressStreamContent(content: string, activeCalls: string[] = []) {
  return buildUserFacingProgressContent(content, activeCalls);
}

export function buildThinkingHeartbeatContent(content: string, activeCalls: string[] = [], now = Date.now()) {
  const displayContent = collapseProgressUpdates(content);
  const userFacingContent = buildUserFacingProgressContent(displayContent, activeCalls);
  const timeBucket = Math.floor(now / 1000);
  const heartbeatText = userFacingContent || THINKING_HEARTBEAT_TEXTS[timeBucket % THINKING_HEARTBEAT_TEXTS.length]!;
  return `${getProcessingFrame(now)} ${heartbeatText}`;
}
