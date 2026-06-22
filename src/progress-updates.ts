function splitProgressSentences(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。.!！?？])\s*/u)
    .map(item => item.trim())
    .filter(Boolean);
}

function isProgressSentence(sentence: string) {
  return sentence.includes("继续核实中");
}

const FINAL_ANSWER_TAG_PATTERN = /<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/gi;
const AGENT_PROGRESS_TAG_PATTERN = /<agent_progress>\s*([\s\S]*?)\s*<\/agent_progress>/gi;
const PROTOCOL_TAG_TOKEN_PATTERN = /<\/?(?:agent_progress|final_answer)>/gi;
const PROTOCOL_TAG_PREFIXES = ["<agent_progress", "</agent_progress", "<final_answer", "</final_answer"];

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
  if (!trimmed.includes("继续核实中")) return content;

  const sentences = splitProgressSentences(trimmed);
  let lastProgressIndex = -1;
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index];
    if (sentence && isProgressSentence(sentence)) {
      lastProgressIndex = index;
      break;
    }
  }
  const nonProgressSentencesAfterProgress = sentences
    .slice(lastProgressIndex + 1)
    .filter(sentence => !isProgressSentence(sentence));

  if (nonProgressSentencesAfterProgress.length > 0) {
    return nonProgressSentencesAfterProgress.join("\n\n").trim();
  }

  return sentences[lastProgressIndex] || trimmed;
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

const PROCESSING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINKING_HEARTBEAT_TEXTS = [
  "仍在分析中",
  "仍在核实中",
  "仍在整理证据中",
  "仍在等待模型响应",
];

const HEARTBEAT_FRAME_PREFIXES = PROCESSING_FRAMES.map(frame => `${frame} 处理中`);
const HEARTBEAT_FRAME_PATTERN = PROCESSING_FRAMES.join("|");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HEARTBEAT_TEXT_PATTERN = THINKING_HEARTBEAT_TEXTS.map(escapeRegExp).join("|");
const HEARTBEAT_FRAMED_PATTERN = new RegExp(`^(?:${HEARTBEAT_FRAME_PATTERN}) 处理中：(?:${HEARTBEAT_TEXT_PATTERN})\\.{1,3}$`, "u");
const HEARTBEAT_PLAIN_PATTERN = new RegExp(`^(?:${HEARTBEAT_TEXT_PATTERN})\\.{1,3}$`, "u");

function isThinkingHeartbeatLine(line: string) {
  const trimmed = line.trim();
  if (HEARTBEAT_FRAME_PREFIXES.includes(trimmed)) return true;

  return HEARTBEAT_FRAMED_PATTERN.test(trimmed) || HEARTBEAT_PLAIN_PATTERN.test(trimmed);
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
  return PROCESSING_FRAMES[Math.floor(now / 500) % PROCESSING_FRAMES.length] || PROCESSING_FRAMES[0]!;
}

export function collapseProgressUpdates(content: string): string {
  const trimmed = stripThinkingHeartbeatContent(content);
  if (isIncompleteProtocolTagPrefix(trimmed)) return "";

  if (/<\/?(?:agent_progress|final_answer)>/i.test(trimmed)) {
    return extractTaggedDisplayContent(trimmed);
  }

  return collapsePlainProgressContent(trimmed);
}

export function buildProgressStreamContent(content: string, activeCalls: string[] = []) {
  const displayContent = collapseProgressUpdates(content);
  const body = displayContent && activeCalls.length > 0
    ? `${displayContent}\n\n${activeCalls.join("\n")}`
    : displayContent || activeCalls.join("\n");

  return body;
}

export function buildThinkingHeartbeatContent(content: string, activeCalls: string[] = [], now = Date.now()) {
  const displayContent = collapseProgressUpdates(content);
  const timeBucket = Math.floor(now / 1000);
  const heartbeatText = THINKING_HEARTBEAT_TEXTS[timeBucket % THINKING_HEARTBEAT_TEXTS.length]!;
  const dots = ".".repeat((timeBucket % 3) + 1);
  const heartbeatLine = `${getProcessingFrame(now)} 处理中：${heartbeatText}${dots}`;
  const bodyContent = displayContent ? `${displayContent}\n\n${heartbeatLine}` : heartbeatLine;
  const body = activeCalls.length > 0
    ? `${bodyContent}\n\n${activeCalls.join("\n")}`
    : bodyContent;
  return body;
}
