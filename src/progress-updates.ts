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

function extractTaggedDisplayContent(content: string): string {
  const finalAnswer = getLastTaggedContent(content, FINAL_ANSWER_TAG_PATTERN);
  if (finalAnswer) return finalAnswer;

  const remainingContent = stripTaggedContent(content);
  if (remainingContent) return collapseProgressUpdates(remainingContent);

  return getLastTaggedContent(content, AGENT_PROGRESS_TAG_PATTERN);
}

const PROCESSING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function getProcessingFrame(now = Date.now()) {
  return PROCESSING_FRAMES[Math.floor(now / 500) % PROCESSING_FRAMES.length] || PROCESSING_FRAMES[0]!;
}

export function collapseProgressUpdates(content: string): string {
  const trimmed = content.trim();
  if (/<\/?(?:agent_progress|final_answer)>/i.test(trimmed)) {
    return extractTaggedDisplayContent(trimmed);
  }

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

export function buildProgressStreamContent(content: string, activeCalls: string[] = [], options: { motionFrame?: string } = {}) {
  const displayContent = collapseProgressUpdates(content);
  const motionPrefix = options.motionFrame ? `${options.motionFrame} 处理中` : "";
  const body = displayContent && activeCalls.length > 0
    ? `${displayContent}\n\n${activeCalls.join("\n")}`
    : displayContent || activeCalls.join("\n");

  if (motionPrefix && body) {
    return `${motionPrefix}\n${body}`;
  }
  if (motionPrefix) {
    return motionPrefix;
  }
  return body;
}
