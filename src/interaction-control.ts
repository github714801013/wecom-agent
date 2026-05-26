export type ActiveMessageIntent = "stop" | "continue_current" | "replace_with_followup";
export interface ConversationContextItem {
  role: "user" | "assistant" | "system";
  content: string;
}

const STOP_PATTERNS = [
  /^(停|停止|别查了|不用查了|先停|暂停|中止|终止|取消|算了|不用了|别回答了|不要回答了)$/i,
  /^(kill|kills|stop|cancel|abort)$/i,
];

const CONTINUE_PATTERNS = [
  /^(继续|接着|接着查|继续查|继续核实|继续回答|往下查|继续处理)$/i,
  /^(continue|go on|keep going)$/i,
];

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
请把“用户追问”作为对“原问题”的补充或修正，先整合成同一个问题再继续回答；不要只回答追问中的片段。`;
}

function compactText(text: string, maxLength: number) {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength)}...`;
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

  return `【历史上下文整合】
相关历史：
${relevantHistory}

当前问题：
${current}

处理要求：
请先结合“相关历史”和“当前问题”整合成一个明确问题，再继续回答；如果当前问题明显是全新问题，只保留当前问题并忽略无关历史。`;
}
