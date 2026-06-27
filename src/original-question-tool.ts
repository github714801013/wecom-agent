import { tool } from "@langchain/core/tools";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

export interface OriginalQuestionToolInput {
  originalUserQuestion: string;
  currentQuestion: string;
  sessionMessages: BaseMessage[];
}

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

function getSessionFirstUserQuestion(messages: BaseMessage[]) {
  const firstHumanMessage = messages.find(message => message instanceof HumanMessage);
  return firstHumanMessage ? stringifyMessageContent(firstHumanMessage.content).trim() : "";
}

export function buildOriginalQuestionTool(input: OriginalQuestionToolInput) {
  const originalUserQuestion = input.originalUserQuestion.trim();
  const currentQuestion = input.currentQuestion.trim();
  const sessionFirstUserQuestion = getSessionFirstUserQuestion(input.sessionMessages);

  return tool(
    async () => JSON.stringify({
      original_user_question: originalUserQuestion,
      integrated_user_question: currentQuestion,
      current_question: currentQuestion,
      session_first_user_question: sessionFirstUserQuestion,
      has_question_rewrite: Boolean(currentQuestion && originalUserQuestion && currentQuestion !== originalUserQuestion),
    }),
    {
      name: "original_user_question_get",
      description: [
        "获取当前轮整合后的用户问题，避免历史整合、上下文压缩、提示词增强或追问改写后导致用户意图丢失或失真。",
        "当你不确定当前提示中的问题是否已经被改写、合并、压缩，或需要核对整合后的用户问题时调用。",
        "返回 JSON：integrated_user_question/current_question 为当前已整合问题，original_user_question 为当前轮用户原话，session_first_user_question 为当前会话可见的首个用户问题。",
      ].join(""),
      schema: z.object({}),
    }
  );
}
