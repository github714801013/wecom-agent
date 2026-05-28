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

const PROCESSING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function getProcessingFrame(now = Date.now()) {
  return PROCESSING_FRAMES[Math.floor(now / 500) % PROCESSING_FRAMES.length] || PROCESSING_FRAMES[0]!;
}

export function collapseProgressUpdates(content: string) {
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
