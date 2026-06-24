import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const PRIORITY_ANCHOR_HEADER_PATTERN = /优先锚点[^\n]*：\n([\s\S]*?)(?:\n旁证\/已排除锚点|\n其他已确认锚点|\n当前问题：|$)/;
const CODE_LEVEL_ANCHOR_PATTERN = /(?:\.java\b|[a-z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+)/;

export function extractPriorityAnswerAnchors(questionWithHistory: string) {
  const match = questionWithHistory.match(PRIORITY_ANCHOR_HEADER_PATTERN);
  if (!match) return [];
  const anchorBlock = match[1] || "";

  return Array.from(new Set(
    anchorBlock
      .split(/\r?\n/)
      .map(line => line.replace(/^-\s*/, "").trim())
      .filter(anchor => anchor && CODE_LEVEL_ANCHOR_PATTERN.test(anchor)),
  ));
}

export function getMissingPriorityAnswerAnchors(questionWithHistory: string, answer: string) {
  const anchors = extractPriorityAnswerAnchors(questionWithHistory);
  return anchors.filter(anchor => !answer.includes(anchor));
}

export async function repairAnswerForMissingPriorityAnchors(input: {
  model: { invoke(messages: Array<SystemMessage | HumanMessage>): Promise<{ content: unknown }> };
  questionWithHistory: string;
  answer: string;
}) {
  const missingAnchors = getMissingPriorityAnswerAnchors(input.questionWithHistory, input.answer);
  if (missingAnchors.length === 0) return input.answer;

  const response = await input.model.invoke([
    new SystemMessage(`你是最终回答修正器。只基于用户问题、历史优先锚点和已有回答进行修正，不调用工具、不编造新证据。
要求：
1. 最终回答必须覆盖所有缺失的优先锚点：${missingAnchors.join("、")}。
2. 如果已有回答把历史标记为“旁证/已排除”的候选作为主结论，必须调整为旁证或排除项。
3. 保留已有回答中已经有代码证据支撑的内容。
4. 不输出过程说明，不输出“根据要求修正”等元话术，只输出面向用户的最终结论。`),
    new HumanMessage([
      `用户问题与历史锚点：\n${input.questionWithHistory}`,
      `已有回答：\n${input.answer}`,
      `缺失的优先锚点：${missingAnchors.join("、")}`,
    ].join("\n\n")),
  ]);

  return String(response.content || "");
}
