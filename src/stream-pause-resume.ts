import type { HumanLoopRequest } from "./human-loop.js";

export const STREAM_PAUSE_CURRENT_PLAN = "企业微信流式窗口暂停后的断点恢复";

export interface StreamPauseResumeInput {
  userQuestion: string;
  currentQuestion: string;
  partialAnswer: string;
  toolContextSummary: string;
  repoHints: string[];
}

function normalizeLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength: number) {
  const normalized = text.trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

export function buildStreamPauseResumeRequest(input: StreamPauseResumeInput): HumanLoopRequest {
  const knownFacts = [
    `用户整合后的问题：${normalizeLine(input.userQuestion) || "未记录"}`,
  ];

  const currentQuestion = normalizeLine(input.currentQuestion);
  if (currentQuestion && currentQuestion !== normalizeLine(input.userQuestion)) {
    knownFacts.push(`当前整合问题：${currentQuestion}`);
  }

  knownFacts.push(input.repoHints.length > 0
    ? `当前项目/仓库范围：${input.repoHints.join(", ")}`
    : "当前项目/仓库范围：未显式限定，继续沿已命中的证据范围排查");

  knownFacts.push(input.partialAnswer.trim()
    ? `暂停前阶段性内容：${truncateText(input.partialAnswer, 1800)}`
    : "暂停前阶段性内容：尚未形成可见结论，继续沿已完成的规划、检索和工具证据推进");

  knownFacts.push(input.toolContextSummary.trim()
    ? `暂停前工具证据摘要：${truncateText(input.toolContextSummary, 2600)}`
    : "暂停前工具证据摘要：本轮尚未形成有效工具结果或工具结果已在阶段性内容中体现");

  return {
    reason: "clarification_required",
    question: "本次分析已暂停在企业微信流式安全窗口内。请回复「继续」，我会基于已保存的阶段性内容和工具证据接着处理。",
    resumeInstruction: [
      "这是企业微信 10 分钟流式窗口触发的断点恢复，不是用户补充信息不足。",
      "用户回复继续后，必须继承已知事实、阶段性内容、工具证据摘要、项目范围和当前整合问题。",
      "禁止从头重新识别问题、重新询问接口地址/页面/字段、重复分析已覆盖的代码位置或重复执行已知无效检索。",
      "应从暂停点后的未完成审核项、未完成工具链路或未验证证据继续推进；已核实过的逻辑和已分析过的代码范围视为已完成节点，只能引用结论或沿下一跳继续。",
      "只有所有可用路径都核实完仍无法回答，才允许再次 Human Loop；再次 Human Loop 必须列出已穷尽路径、已核实节点和剩余最小缺口。",
    ].join("\n"),
    contextSnapshot: {
      userQuestion: input.currentQuestion || input.userQuestion,
      currentPlan: STREAM_PAUSE_CURRENT_PLAN,
      knownFacts,
      missingFacts: [
        "无须用户补充业务参数；用户只需回复继续即可恢复。",
        "需要模型继续完成暂停前尚未完成的工具验证、证据收敛和最终回答审核。",
      ],
    },
  };
}

export function isStreamPauseResumeRequest(request: HumanLoopRequest | undefined) {
  if (!request) return false;
  return request.contextSnapshot.currentPlan === STREAM_PAUSE_CURRENT_PLAN
    || request.resumeInstruction.includes("企业微信 10 分钟流式窗口触发的断点恢复");
}

export function buildStreamPauseResumeRuntimeInstruction() {
  return `系统提示：【流式暂停断点恢复】
当前输入来自企业微信 10 分钟流式窗口暂停后的「继续」恢复，不是新问题。
1. 禁止重新执行问题分类、宽泛规划、预检索或从头搜索；必须优先读取恢复内容中的已知事实、阶段性内容、工具证据摘要和项目范围。
2. 已核实过的逻辑、已命中的入口、已分析过的代码范围、已确认无效的检索条件都视为已完成节点；不要重复查询同一位置或同一条件。
3. 只能从未完成节点继续：未验证的下一跳、未完成的审核项、尚未收敛的数据条件或仍缺失的下游证据。
4. 只有所有可用工具路径、代码路径、测试/dev 库路径和已有证据都核实完仍无法回答时，才允许 Human Loop；触发时必须列出已穷尽路径和剩余最小缺口。`;
}
