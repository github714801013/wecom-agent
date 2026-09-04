import { WSClient, MessageType, generateReqId } from "@wecom/aibot-node-sdk";
import { initializeAgent, runPlanner, runSearchLoopPrelude, getModelContextWindow, getBaseModel, getBusinessPrompt, extractExplicitRepoHints, buildMessagesForCurrentTurn, scopeToolsToRepo } from "./graph.js";
import { getMissingPriorityAnswerAnchors, repairAnswerForMissingPriorityAnchors } from "./answer-anchor-guard.js";
import { config, type BotConfig } from "./config.js";
import { HumanMessage, AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { sessionManager, type ReplyMode } from "./session-manager.js";
import { fetchImageAsBase64, downloadMediaFile } from "./media-helper.js";
import { analyzeImageForQuestion, type VisionImageAnalyzer } from "./vision-analyzer.js";
import { buildMcpHeaders, getAllMcpTools } from "./mcp-client.js";
import {
  buildHumanLoopReply,
  buildHumanLoopResumeContent,
  detectHumanLoopRequest,
  detectClarificationContent,
  isAmbiguousNewTopicWhilePending,
  isHumanLoopExpired,
  toStoredHumanLoopRequest,
  type HumanLoopRequest,
} from "./human-loop.js";
import { buildIntermediateStreamContent, buildProgressStreamContent, buildThinkingHeartbeatContent, collapseProgressUpdates, formatElapsedDuration, getProcessingFrame, stripProtocolNoise } from "./progress-updates.js";
import { rewriteAnswerForBusiness } from "./business-answer-rewrite.js";
import {
  consumeFlowControlDelta,
  createDefaultFlowControl,
  createFlowControlStreamState,
  extractFlowControl,
  type FlowControlPatch,
  mergeFlowControl,
} from "./flow-control.js";
import {
  buildAgentToolErrorLimitReply,
  createAgentProgressGuard,
  createAgentProgressLimitError,
  createAgentToolErrorLimitError,
} from "./agent-progress-guard.js";
import {
  AUTO_VERIFICATION_NO_PROGRESS_REPLY,
  buildAutoVerificationContinuationPrompt,
  runAutoVerificationLoop,
  type AutoVerificationRoundContext,
  type AutoVerificationRoundResult,
} from "./auto-verification-loop.js";
import { isStreamExpired, isWeComReplyAckTimeoutError, isWeComStreamExpiredError, STREAM_EXPIRED_MESSAGE } from "./stream-ttl.js";
import { buildToolContextSummary, filterToolResultForCurrentTurn, type ToolContextRecord } from "./tool-context-filter.js";
import { buildToolResultFileReadTool } from "./tool-result-store.js";
import { buildProgressLimitRecoverySystemPrompt, ensureRecoverySqlAuditMarker } from "./recovery-synthesis.js";
import { buildOriginalQuestionTool } from "./original-question-tool.js";
import { stringifyModelContent } from "./model-content.js";
import { buildUserFacingErrorReply } from "./error-response.js";
import { buildSessionMemoryGraphTool } from "./session-memory-graph.js";
import {
  buildStreamPauseResumeRequest,
  buildStreamPauseResumeRuntimeInstruction,
  isStreamPauseResumeRequest,
} from "./stream-pause-resume.js";
import {
  buildMcpHeaderSwitchReply,
  buildQueryableProjectsReply,
  extractProjectsFromHeaders,
  extractProjectsFromMcpHeaders,
  isQueryableProjectsQuestion,
  listMcpHeaderCommands,
  parseMcpHeaderCommand,
  prependMcpEnvironmentQueryNotice,
  resolveMcpHeaderCommand,
} from "./mcp-header-commands.js";
import {
  buildDirectEvidenceFastPathInstruction,
  buildDirectEvidenceRuntimeInstruction,
  buildEntryAnchorGraphInstruction,
  hasDirectEvidenceAnchors,
  shouldUseWeComDirectEvidenceFastPath,
} from "./direct-evidence.js";
import {
  buildFollowupQuestion,
  buildQuestionWithHistory,
  classifyHistoryRelevance,
  detectActiveMessageIntent,
  type ConversationContextItem,
} from "./interaction-control.js";
import {
  buildSensitiveRequestAuditEvent,
  buildSensitiveRequestBlockedReply,
  extractSensitiveRequestPreflightText,
  judgeSensitiveRequestByModel,
} from "./sensitive-request-guard.js";
import {
  applySqlAuditEvidence,
  assertTodoListComplete,
  blockTodoItem,
  buildIncompleteAuditTodoMessage,
  generateUserFacingAuditFallbackMessage,
  buildRuntimeTodoTool,
  buildSqlAuditEvidence,
  completeAnswerSupportedAuditItems,
  completeRecoveryAuditItems,
  completeSkippedAuditItems,
  completeTodoItem,
  createRuntimeTodoList,
  getIncompleteAuditTodoItems,
  hasRepeatedInputOutput,
  hasTodoItem,
  isSqlAuditEvidenceBlocking,
  renderTodoStepsForHeartbeat,
  snapshotUserFacingTodoSteps,
  type FinalReplyResolutionResult,
  type UserFacingTodoStep,
  resolveFinalReplyWithModel,
  shouldSendFinalReply,
  syncRuntimeAuditTodoPlan,
  startTodoItem,
  summarizeTodoList,
} from "./runtime-todolist.js";

interface ActiveTaskState {
  msgid: string;
  cancelled: boolean;
  question: string;
}

interface AgentStreamMetadata {
  answerReview?: {
    resetContent?: boolean;
    progress?: boolean;
  };
  flowControl?: FlowControlPatch;
}

interface BotReconnectState {
  reconnectExhaustedTimer: NodeJS.Timeout | null;
  reconnectWatchdogTimer: NodeJS.Timeout | null;
}

const THINKING_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_RECONNECT_EXHAUSTED_DELAY_MS = 5000;
const DEFAULT_RECONNECT_EXHAUSTED_WATCHDOG_MS = 60000;
const WS_RECONNECT_EXHAUSTED_CODE = "WS_RECONNECT_EXHAUSTED";

export function isWsReconnectExhaustedError(error: unknown) {
  const err = error as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  return err?.code === WS_RECONNECT_EXHAUSTED_CODE
    || err?.name === "WSReconnectExhaustedError"
    || String(err?.message ?? "").includes("Max reconnect attempts exceeded");
}

export function getReconnectExhaustedDelayMs(envValue = process.env.WECOM_RECONNECT_EXHAUSTED_DELAY_MS) {
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed >= 1000
    ? parsed
    : DEFAULT_RECONNECT_EXHAUSTED_DELAY_MS;
}

export function getReconnectExhaustedWatchdogMs(envValue = process.env.WECOM_RECONNECT_EXHAUSTED_WATCHDOG_MS) {
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed >= 10000
    ? parsed
    : DEFAULT_RECONNECT_EXHAUSTED_WATCHDOG_MS;
}

function stripEmptyProtocolContent(content: string) {
  return stripProtocolNoise(content);
}

function getMaxAgentToolResultsPerTurn() {
  const parsed = Number(process.env.AGENT_MAX_TOOL_RESULTS_PER_TURN);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : config.tools.maxAgentToolResultsPerTurn;
}

function reconnectBotAfterReplyAckTimeout(bot: WSClient, botName: string, msgid: string) {
  try {
    console.warn(`[${botName}] Reply ack timeout for ${msgid}; reconnecting WeCom WebSocket.`);
    bot.disconnect();
    bot.connect();
  } catch (error) {
    console.error(`[${botName}] Failed to reconnect WeCom WebSocket after reply ack timeout for ${msgid}:`, error);
  }
}

function scheduleReconnectAfterReconnectExhausted(
  bot: WSClient,
  botName: string,
  reconnectState: BotReconnectState,
) {
  if (reconnectState.reconnectExhaustedTimer) return;

  const delayMs = getReconnectExhaustedDelayMs();
  console.error(`[${botName}] WeCom WebSocket reconnect exhausted; scheduling application-level reconnect in ${delayMs}ms.`);
  reconnectState.reconnectExhaustedTimer = setTimeout(() => {
    reconnectState.reconnectExhaustedTimer = null;
    try {
      console.warn(`[${botName}] Restarting WeCom WebSocket after reconnect exhausted.`);
      bot.disconnect();
      bot.connect();
      if (!reconnectState.reconnectWatchdogTimer) {
        const watchdogMs = getReconnectExhaustedWatchdogMs();
        reconnectState.reconnectWatchdogTimer = setTimeout(() => {
          console.error(`[${botName}] WeCom WebSocket did not authenticate within ${watchdogMs}ms after reconnect exhausted; exiting for container restart.`);
          process.exit(1);
        }, watchdogMs);
      }
    } catch (error) {
      console.error(`[${botName}] Failed to restart WeCom WebSocket after reconnect exhausted; exiting for container restart.`, error);
      process.exit(1);
    }
  }, delayMs);
}

/**
 * 格式化工具调用显示，提取关键参数以提升用户体验
 */
function getToolDisplay(name: string, args: any): string {
  if (!args || args === '{}' || args === '') return name;
  
  let argsObj: any;
  try {
    if (typeof args === 'string') {
      argsObj = JSON.parse(args);
    } else {
      argsObj = args;
    }

    // 提取最能代表查询意图的参数
    const keyParams = ['query', 'searchText', 'pattern', 'target', 'symbol', 'path', 'table_name', 'sql'];
    for (const key of keyParams) {
      if (argsObj[key]) {
        const val = String(argsObj[key]);
        const truncated = val.length > 30 ? val.substring(0, 30) + "..." : val;
        return `${name}("${truncated}")`;
      }
    }
    // 如果没有匹配到常用参数，则显示简短的 JSON 片段
    const briefArgs = JSON.stringify(argsObj);
    return briefArgs.length > 40 ? `${name}(${briefArgs.substring(0, 40)}...)` : `${name}(${briefArgs})`;
  } catch {
    // 尝试正则匹配还没写完的 JSON 片段（流式过程中常见）
    if (typeof args === 'string') {
      const match = args.match(/"(query|searchText|pattern|target|symbol|path|table_name|sql)"\s*:\s*"([^"]*)"/);
      if (match && match[2]) {
        const val = match[2];
        const truncated = val.length > 30 ? val.substring(0, 30) + "..." : val;
        return `${name}("${truncated}...")`;
      }
    }
  }
  return name;
}

export function stripBoundaryMentions(text: string): string {
  let result = text.trim();
  const leadingMention = /^@[^\s，。！？!?,;；：:、]+[\s，。！？!?,;；：:、]*/u;
  const trailingMention = /[\s，。！？!?,;；：:、]*@[^\s，。！？!?,;；：:、]+$/u;

  while (leadingMention.test(result)) {
    result = result.replace(leadingMention, "").trimStart();
  }
  while (trailingMention.test(result)) {
    result = result.replace(trailingMention, "").trimEnd();
  }
  return result.trim();
}


export function extractTextContent(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return stripBoundaryMentions(content);
  return content
    .filter(item => item.type === "text" && item.text)
    .map(item => stripBoundaryMentions(item.text || ""))
    .filter(Boolean)
    .join("\n");
}

type ParsedWeComContentItem = { type: string; text?: string; image_url?: { url: string } | string };

function collectPayloadText(payload: any): string[] {
  if (!payload) return [];
  if (payload.msgtype === MessageType.Text || payload.msgtype === "text") {
    return [payload.text?.content].filter(Boolean);
  }
  if (payload.msgtype === "mixed") {
    return (payload.mixed?.msg_item || [])
      .filter((item: any) => item.msgtype === "text")
      .map((item: any) => item.text?.content)
      .filter(Boolean);
  }
  if (payload.msgtype === MessageType.Voice) {
    return [payload.voice?.recognition].filter(Boolean);
  }
  return [];
}

function buildImageQuestionContext(body: any): string {
  return [
    ...collectPayloadText(body),
    ...collectPayloadText(body?.quote),
  ]
    .map(text => stripBoundaryMentions(String(text)))
    .filter(Boolean)
    .join("\n");
}

async function appendImageWithAnalysis(
  items: ParsedWeComContentItem[],
  bot: WSClient,
  image: { url?: string; aeskey?: string } | undefined,
  question: string,
  contextLabel: string,
  imageAnalyzer: VisionImageAnalyzer,
) {
  const imageUrl = await fetchImageAsBase64(bot, image?.url || "", image?.aeskey);
  try {
    const analysis = await imageAnalyzer({
      question,
      imageUrl,
      contextLabel,
    });
    if (analysis.trim()) {
      items.push({ type: "text", text: analysis.trim() });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Image analysis failed for ${contextLabel}:`, error);
    items.push({ type: "text", text: `【图片识别结果】\n图片识别失败：${message}。已保留原图供主模型参考。` });
  }
  items.push({ type: "image_url", image_url: { url: imageUrl } });
}

export function isClearSessionCommand(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？!?.]/g, "")
    .replace(/的/g, "");

  if (!normalized) return false;

  if (/^(怎么|如何|为什么|为何|查询|排查|分析|说明|解释)/.test(normalized)) {
    return false;
  }

  if (/(不生效|没生效|无效|失败|问题|原因)/.test(normalized)) {
    return false;
  }

  const exactCommands = new Set([
    "/new",
    "reset",
    "清理当前会话",
    "清理会话",
    "清空当前会话",
    "清空会话",
    "重置当前会话",
    "重置会话",
    "清理当前对话",
    "清理对话",
    "清空对话",
    "重置对话",
    "清理上下文",
    "清空上下文",
    "重置上下文",
    "清理记忆",
    "清空记忆",
    "忘记之前对话",
    "忘记历史对话"
  ]);

  if (exactCommands.has(normalized)) return true;

  const politePrefix = "(请|麻烦|麻烦你|帮我|帮忙|给我|帮我把|把)?";
  const scope = "(当前|本次|这次|这个|刚才|之前|历史|上面|前面|所有|全部)?";
  const filler = "(一下|下)?";
  const target = "(会话|对话|聊天记录|上下文|记忆|历史|内容|消息|记录)";

  const semanticPatterns = [
    new RegExp(`^${politePrefix}${scope}?(清理|清空|清除|删除|重置|刷新|抹掉|擦掉|删掉|清掉|清一下|清一清)${filler}${scope}?${target}(吧|一下|下)?$`),
    new RegExp(`^${politePrefix}${scope}?${target}(清理|清空|清除|删除|重置|刷新|抹掉|擦掉|删掉|清掉)${filler}(吧|一下|下)?$`),
    new RegExp(`^${politePrefix}(忘记|忘掉|不要记|别记|删除|清掉)${scope}?${target}(吧|一下|下)?$`),
    /^(重新开始|从头开始|新开会话|开启新会话|开始新会话|开始新的会话|开个新会话|另起会话|另起一个会话)$/,
    /^(不带上下文|不要上下文|不要带历史|不参考历史|不看历史|不看上文|忽略上文|忽略前文|忽略之前内容)$/
  ];

  return semanticPatterns.some(pattern => pattern.test(normalized));
}

export function isHelpCommand(text: string): boolean {
  const normalized = stripBoundaryMentions(text)
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？!?.]/g, "");

  if (!normalized) return false;

  const exactCommands = new Set([
    "help",
    "/help",
    "帮助",
    "帮助信息",
    "使用帮助",
    "使用手册",
    "操作手册",
    "指南",
    "怎么用",
    "如何使用",
  ]);

  return exactCommands.has(normalized);
}

const UNCERTAINTY_PATTERN = /无法确认|无法确定|需要进一步|建议查看代码|建议检索|需要代码|需要工具|不确定答案|信息不足|资料不足|需要更多信息|请提供更多|无法回答|超出我的能力/u;

function hasUncertaintyMarkers(content: string): boolean {
  return UNCERTAINTY_PATTERN.test(content.trim());
}

export type QuestionDifficulty = "simple" | "medium" | "complex";

// 直接匹配型意图：关键词命中即可得答案，无需多轮逻辑推理。
// 接口/功能/板块的处理逻辑、步骤、业务逻辑梳理（FLOW/API 等）属于逻辑推理，不在此列。
const DIRECT_MATCH_INTENTS = new Set(["SQL", "CONFIG", "DOC", "AUTH"]);

export function isDirectMatchIntent(intent: string | null | undefined): boolean {
  return Boolean(intent && DIRECT_MATCH_INTENTS.has(intent.trim().toUpperCase()));
}

// 基于 planner 意图分析结果分流：queries 数量反映业务逻辑查询需求
export function classifyQuestionDifficulty(plannerResult: { queries: unknown[] } | null): QuestionDifficulty {
  if (!plannerResult) return "complex";
  const queryCount = plannerResult.queries?.length ?? 0;
  if (queryCount === 0) return "simple";
  if (queryCount <= 2) return "medium";
  return "complex";
}

const DEV_MODE_PREFIX = "/dev";
const BUSINESS_MODE_PREFIX = "/business";

export type ReplyModeCommand = { modeSwitch: ReplyMode; strippedText: string } | { modeSwitch: null; strippedText: string };

export function detectReplyModeCommand(text: string): ReplyModeCommand {
  const trimmed = stripBoundaryMentions(text);
  if (trimmed === DEV_MODE_PREFIX || trimmed.toLowerCase().startsWith(`${DEV_MODE_PREFIX} `)) {
    const stripped = trimmed.length > DEV_MODE_PREFIX.length ? trimmed.slice(DEV_MODE_PREFIX.length).trim() : "";
    return { modeSwitch: "dev", strippedText: stripped };
  }
  if (trimmed === BUSINESS_MODE_PREFIX || trimmed.toLowerCase().startsWith(`${BUSINESS_MODE_PREFIX} `)) {
    const stripped = trimmed.length > BUSINESS_MODE_PREFIX.length ? trimmed.slice(BUSINESS_MODE_PREFIX.length).trim() : "";
    return { modeSwitch: "business", strippedText: stripped };
  }
  return { modeSwitch: null, strippedText: trimmed };
}

export function buildHelpReply(headerCommands = listMcpHeaderCommands(config.mcpServers)) {
  const replyModeHints = [
    "/dev：切换到开发者模式（返回技术原貌回答）",
    "/business：切换回业务回答模式（默认）",
  ];
  const allCommandHints = headerCommands.length > 0
    ? [
        "当前支持指令：",
        ...replyModeHints,
        ...headerCommands.map(command => `${command.command}：切换到 ${command.label} 配置（${command.serverNames.join("、")}）`),
      ].join("\n")
    : ["当前支持指令：", ...replyModeHints].join("\n");
  return [
    "使用帮助",
    "",
    "1. 提问方式",
    "直接描述业务问题、接口、报错、页面路径、项目名或截图。我会优先定位项目范围，再核实代码、SQL 或配置证据。",
    "",
    "2. 清理会话",
    "发送“清理会话”“清空上下文”“重置对话”或 /new，可以清除当前会话历史。",
    "",
    "3. 清理项目限制",
    "发送“清理会话”后重新提问，不带历史项目范围；也可以直接说明“不要沿用上个项目，改查 <项目名>”。",
    allCommandHints,
    "",
    "4. 继续或停止",
    "任务处理中发送“继续”可确认继续等待；发送“停止”可取消当前任务。",
    "",
    "5. SQL 参数",
    "如果需要 SQL，我会把需要你填写的参数统一放在 SQL 最前面的变量区，并用一句话列出需要提供的信息。",
  ].join("\n");
}

export interface FinalReplyDeliveryInput {
  content: string;
  finalResolution: FinalReplyResolutionResult;
  humanLoopReply?: string | null;
  userQuestion?: string;
}

export interface FinalReplyDeliveryResult {
  content: string;
  shouldSendFinal: boolean;
  reason: string;
  source: "reviewed" | "human_loop" | "blocked" | "error" | "no_progress";
}

function extractLikelyFieldNames(content: string) {
  const fields = new Set<string>();
  for (const match of content.matchAll(/\b([A-Za-z][A-Za-z0-9_]{1,})\s*字段/gmu)) {
    const name = match[1]?.trim();
    if (!name) continue;
    if (/^(Java|Mapper|Entity|String|Long|Integer|BigInt|bigint|nvarchar)$/i.test(name)) continue;
    fields.add(name);
  }
  return [...fields].sort((left, right) => Number(right.includes("_")) - Number(left.includes("_")) || left.length - right.length);
}

function buildUserFacingBlockedInsight(candidate: string) {
  const normalized = candidate.replace(/\r\n/g, "\n").trim();
  const likelyField = extractLikelyFieldNames(normalized)[0];
  if (likelyField) {
    return `当前线索指向 ${likelyField} 字段，但还没有完成数据库字段类型、实体字段类型和 Mapper 查询条件的一致性核对。`;
  }

  const sentences = normalized
    .split(/(?<=[。.!！?？])\s*/u)
    .map(item => item.trim())
    .filter(Boolean);
  const informativeSentence = sentences.find(sentence =>
    !/(我会|我将|继续|暂不需要|需要你|请补充|尚未|不是最终结论|阶段性)/u.test(sentence)
    && sentence.length >= 8
  );
  return informativeSentence || "当前已经获取到部分线索，但还不足以形成可直接采信的最终结论。";
}

function buildUserFacingBlockedMissingFacts(candidate: string) {
  const missingFacts: string[] = [];
  if (/数据库|列类型|字段类型|建表语句|表结构/u.test(candidate)) {
    missingFacts.push("数据库真实列类型或表结构");
  }
  if (/Java|实体|JdProductConfig|Mapper|映射/u.test(candidate)) {
    missingFacts.push("Java 实体字段类型和 Mapper 查询映射");
  }
  if (/数据内容|含字母|nvarchar|bigint|类型转换/u.test(candidate)) {
    missingFacts.push("实际数据内容与字段类型是否匹配");
  }
  return missingFacts.length > 0 ? missingFacts : ["能够支撑最终结论的直接证据"];
}

function buildBlockedFinalReply(candidate: string, action: FinalReplyResolutionResult["action"]) {
  const insight = buildUserFacingBlockedInsight(candidate);
  const missingFacts = buildUserFacingBlockedMissingFacts(candidate);
  const needsHumanInput = action === "human_loop";

  return [
    needsHumanInput
      ? "当前已核实到部分线索，但继续判断需要你补充外部信息。"
      : "已自动继续核实，但本轮仍未获得足够完整的直接证据。",
    "",
    "当前已确认的线索：",
    insight,
    "",
    needsHumanInput ? "需要你补充：" : "仍缺少的直接证据：",
    ...missingFacts.map(item => `- ${item}`),
    "",
    needsHumanInput
      ? "请直接补充上述最小信息；收到后会基于当前上下文继续核对。"
      : "本轮已停止无进展重试，避免重复调用相同工具；如能提供上述外部证据，可直接补充后继续核对。",
  ].join("\n");
}

export function buildBlockedFinalHumanLoopRequest(input: FinalReplyDeliveryInput): HumanLoopRequest {
  const candidate = input.content.trim();
  return {
    reason: "clarification_required",
    question: buildBlockedFinalReply(candidate, "human_loop"),
    resumeInstruction: [
      "用户补充缺失信息后，基于上轮上下文继续排查。",
      "不要重复解释最终回复闸门、候选回答或内部审核机制。",
      "优先使用新增信息和已知线索补齐直接证据，并给出明确最终结论；如果仍缺证据，只输出最小缺口。",
    ].join(""),
    contextSnapshot: {
      userQuestion: input.userQuestion || input.content,
      knownFacts: candidate ? [buildUserFacingBlockedInsight(candidate)] : [],
      missingFacts: buildUserFacingBlockedMissingFacts(candidate),
    },
  };
}

export function resolveFinalReplyDelivery(input: FinalReplyDeliveryInput): FinalReplyDeliveryResult {
  if (shouldSendFinalReply(input.finalResolution)) {
    return {
      content: input.finalResolution.answer,
      shouldSendFinal: true,
      reason: input.finalResolution.reason,
      source: "reviewed",
    };
  }

  if (input.finalResolution.source === "error") {
    return {
      content: input.finalResolution.answer || input.finalResolution.reason,
      shouldSendFinal: true,
      reason: input.finalResolution.reason,
      source: "error",
    };
  }

  const humanLoopReply = input.humanLoopReply?.trim();
  if (humanLoopReply) {
    return {
      content: humanLoopReply,
      shouldSendFinal: true,
      reason: "converted clarification content to human loop",
      source: "human_loop",
    };
  }

  const reason = `final review blocked: ${input.finalResolution.reason}`;
  return {
    content: buildBlockedFinalReply(input.content.trim(), input.finalResolution.action),
    shouldSendFinal: true,
    reason,
    source: "blocked",
  };
}

export function shouldStartEarlyProgressBeforeParse(body: any) {
  const hasImageInMixed = (items: any[] = []) => items.some(item => item?.msgtype === "image");
  return body?.msgtype === MessageType.Image
    || body?.msgtype === MessageType.Video
    || body?.msgtype === MessageType.File
    || (body?.msgtype === "mixed" && hasImageInMixed(body?.mixed?.msg_item || []))
    || body?.quote?.msgtype === "image"
    || (body?.quote?.msgtype === "mixed" && hasImageInMixed(body?.quote?.mixed?.msg_item || []));
}

/**
 * 将企业微信消息解析为智能体可理解的文本描述或多模态内容
 */
export async function parseWeComMessage(
  body: any,
  bot: WSClient,
  imageAnalyzer: VisionImageAnalyzer = analyzeImageForQuestion,
): Promise<string | ParsedWeComContentItem[]> {
  const msgType = body.msgtype;
  const fromUser = body.from?.userid || "unknown";
  const imageQuestionContext = buildImageQuestionContext(body);
  
  // 1. 解析主消息内容
  let mainItems: ParsedWeComContentItem[] = [];
  switch (msgType) {
    case MessageType.Text:
      mainItems.push({ type: "text", text: body.text.content });
      break;

    case MessageType.Image:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一张图片]` });
      await appendImageWithAnalysis(mainItems, bot, body.image, imageQuestionContext, "主消息图片", imageAnalyzer);
      break;

    case MessageType.Voice:
      const recognition = body.voice?.recognition || "";
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一段语音] ${recognition ? `(识别结果: ${recognition})` : "(未识别到文字)"}` });
      break;

    case MessageType.Video:
      const videoPath = await downloadMediaFile(bot, body.video?.url, body.video?.aeskey, '.mp4');
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个视频] (链接: ${body.video?.url})，已下载至本地临时路径: ${videoPath}` });
      break;

    case MessageType.File:
      const fileExt = body.file?.fileext ? `.${body.file.fileext}` : '.bin';
      const filePath = await downloadMediaFile(bot, body.file?.url, body.file?.aeskey, fileExt);
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个文件] 名称: ${body.file?.filename || "未知"}, 大小: ${body.file?.size || "未知"}，已下载至本地临时路径: ${filePath}` });
      break;

    case "location":
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个位置] 地址: ${body.location?.address}, 经纬度: ${body.location?.lat},${body.location?.lng}` });
      break;

    case "mixed":
      // 图文混排
      const items = body.mixed?.msg_item || [];
      for (const [index, item] of items.entries()) {
        if (item.msgtype === "text") {
          mainItems.push({ type: "text", text: item.text?.content });
        } else if (item.msgtype === "image") {
          await appendImageWithAnalysis(mainItems, bot, item.image, imageQuestionContext, `主消息图文混排第${index + 1}项`, imageAnalyzer);
        }
      }
      break;

    default:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了未处理的消息类型: ${msgType}]` });
      break;
  }

  // 2. 解析引用内容 (Quote)
  let quoteItems: ParsedWeComContentItem[] = [];
  if (body.quote) {
    const qType = body.quote.msgtype;
    if (qType === "text") {
      quoteItems.push({ type: "text", text: body.quote.text?.content });
    } else if (qType === "image") {
      await appendImageWithAnalysis(quoteItems, bot, body.quote.image, imageQuestionContext, "引用图片", imageAnalyzer);
    } else if (qType === "mixed") {
      const qMixedItems = body.quote.mixed?.msg_item || [];
      for (const [index, item] of qMixedItems.entries()) {
        if (item.msgtype === "text") {
          quoteItems.push({ type: "text", text: item.text?.content });
        } else if (item.msgtype === "image") {
          await appendImageWithAnalysis(quoteItems, bot, item.image, imageQuestionContext, `引用图文混排第${index + 1}项`, imageAnalyzer);
        }
      }
    } else {
      quoteItems.push({ type: "text", text: `[${qType} 消息]` });
    }
  }

  // 3. 组合与合并
  const hasImage = mainItems.some(i => i.type === "image_url") || quoteItems.some(i => i.type === "image_url");

  if (!hasImage) {
    // 纯文本模式：返回字符串
    const mainText = mainItems.map(i => i.text).filter(Boolean).join("\n");
    if (quoteItems.length > 0) {
      const quoteText = quoteItems.map(i => i.text).filter(Boolean).join(" ");
      return `[引用内容: ${quoteText}]\n\n${mainText}`;
    }
    return mainText;
  } else {
    // 多模态模式：返回数组
    const result: any[] = [];
    if (quoteItems.length > 0) {
      result.push({ type: "text", text: "[引用内容]:" });
      quoteItems.forEach(item => {
        if (item.type === "text") result.push({ type: "text", text: `> ${item.text}` });
        else result.push(item);
      });
      result.push({ type: "text", text: "\n" });
    }
    result.push(...mainItems);
    return result;
  }
}

export async function startBot(botConfig: BotConfig) {
  const bot = new WSClient({
    botId: botConfig.botId,
    secret: botConfig.secret,
    wsUrl: botConfig.wsUrl, 
  });
  const reconnectState: BotReconnectState = { reconnectExhaustedTimer: null, reconnectWatchdogTimer: null };

  // 用于消息去重的简单缓存（在多实例部署时建议改用 Redis）
  const processedMsgs = new Set<string>();
  const MAX_CACHE_SIZE = 1000;
  const activeTasks = new Map<string, ActiveTaskState>();

  // 监听所有消息类型
  bot.on("message", async (frame) => {
    const { body } = frame;
    if (!body || !body.msgid) return;
    
    // 1. 消息去重，防止企业微信重试导致重复处理
    if (processedMsgs.has(body.msgid)) {
      console.log(`[${botConfig.name}] [Deduplication] Message ${body.msgid} already processed, skipping.`);
      return;
    }
    processedMsgs.add(body.msgid);
    
    // 维持缓存大小
    if (processedMsgs.size > MAX_CACHE_SIZE) {
      const first = processedMsgs.values().next().value;
      if (first) processedMsgs.delete(first);
    }

    const chatType = body.chattype; // 'single' 或 'group'
    const fromUser = body.from?.userid;
    const chatId = body.chatid;
    const sessionKey = chatType === "group" && chatId && fromUser
      ? `group:${chatId}:${fromUser}`
      : fromUser
        ? `single:${fromUser}`
        : chatId || fromUser || "unknown";
    let session = sessionManager.getOrCreateSession(sessionKey, true);
    const activeMcpHeaderCommand = sessionManager.resolveActiveMcpHeaderCommand(sessionKey);
    const withMcpEnvironmentNotice = (content: string) => prependMcpEnvironmentQueryNotice(
      content,
      activeMcpHeaderCommand,
      botConfig.defaultMcpHeaderCommand,
    );

    const sensitiveRequestText = extractSensitiveRequestPreflightText(body);
    const sensitiveRequestDecision = await judgeSensitiveRequestByModel(sensitiveRequestText);
    if (sensitiveRequestDecision.blocked) {
      const auditEvent = buildSensitiveRequestAuditEvent({
        botName: botConfig.name,
        botId: botConfig.botId,
        msgId: body.msgid,
        sessionKey,
        ...(fromUser ? { userId: fromUser } : {}),
        ...(chatId ? { chatId } : {}),
        ...(chatType ? { chatType } : {}),
      }, sensitiveRequestDecision);
      console.warn(`[SECURITY_AUDIT] ${JSON.stringify(auditEvent)}`);
      await bot.replyStreamWithCard(
        frame,
        body.msgid,
        withMcpEnvironmentNotice(buildSensitiveRequestBlockedReply()),
        true,
        {
          templateCard: {
            card_type: "text_notice",
            main_title: { title: "敏感请求已拦截", desc: "本次未调用任何查询工具" },
            task_id: `task_${body.msgid}`,
          },
        },
      );
      return;
    }

    const streamId = generateReqId("stream");
    const streamStartedAt = Date.now();
    const startEarlyProgress = shouldStartEarlyProgressBeforeParse(body);
    let earlyProgressQueue = Promise.resolve();
    let earlyProgressTimer: NodeJS.Timeout | undefined;
    const sendEarlyProgress = (content: string) => {
      const task = earlyProgressQueue.then(
        () => bot.replyStream(frame, streamId, content, false),
        () => bot.replyStream(frame, streamId, content, false),
      ).catch(error => {
        console.error(`[${botConfig.name}] Early progress update failed for ${body.msgid}:`, error);
      });
      earlyProgressQueue = task.then(() => undefined, () => undefined);
      return task;
    };

    if (startEarlyProgress) {
      await bot.replyStreamWithCard(frame, streamId, withMcpEnvironmentNotice(buildThinkingHeartbeatContent("", [], Date.now(), streamStartedAt)), false, {
        templateCard: {
          card_type: 'text_notice',
          main_title: { title: '任务处理中', desc: '正在理解你的消息...' },
          task_id: `task_${body.msgid}`,
        }
      });
      earlyProgressTimer = setInterval(() => {
        void sendEarlyProgress(withMcpEnvironmentNotice(buildThinkingHeartbeatContent("", [], Date.now(), streamStartedAt)));
      }, THINKING_HEARTBEAT_INTERVAL_MS);
    }

    let parsedContent: Awaited<ReturnType<typeof parseWeComMessage>>;
    let stopThinkingHeartbeat = () => {};
    try {
      parsedContent = await parseWeComMessage(body, bot);
    } finally {
      if (earlyProgressTimer) clearInterval(earlyProgressTimer);
      await earlyProgressQueue;
    }
    // --- Session Handling Start ---
    const memoryGraphBeforeCurrentTurn = session.memoryGraph;

    // Handle high-priority system commands (Exact match only)
    const commandText = body.msgtype === MessageType.Text
      ? body.text?.content || ""
      : extractTextContent(parsedContent as any);
    const isHelp = isHelpCommand(commandText);
    const isHardcodedNew = isClearSessionCommand(commandText);
    const replyModeCommand = detectReplyModeCommand(commandText);
    const activeTask = activeTasks.get(sessionKey);
    const activeText = stripBoundaryMentions(commandText);
    const mcpHeaderCommand = parseMcpHeaderCommand(commandText, config.mcpServers);
    let followupQuestion = "";

    if (mcpHeaderCommand) {
      const projects = extractProjectsFromMcpHeaders(mcpHeaderCommand.headersByServer);
      sessionManager.setMcpHeaderOverrides(sessionKey, mcpHeaderCommand.headersByServer);
      sessionManager.setActiveMcpHeaderCommand(sessionKey, mcpHeaderCommand.command);
      sessionManager.setRepoHints(sessionKey, projects);
      await bot.replyStreamWithCard(
        frame,
        body.msgid,
        buildMcpHeaderSwitchReply(mcpHeaderCommand),
        true,
        {
          templateCard: {
            card_type: "text_notice",
            main_title: { title: "MCP 配置已切换", desc: mcpHeaderCommand.command },
            task_id: `task_${body.msgid}`,
          },
        }
      );
      return;
    }

    if (activeTask && !activeTask.cancelled) {
      const activeIntent = detectActiveMessageIntent(activeText);
      if (activeIntent === "stop") {
        activeTask.cancelled = true;
        await bot.replyStreamWithCard(
          frame,
          body.msgid,
          "已停止当前任务。",
          true,
          {
            templateCard: {
              card_type: "text_notice",
              main_title: { title: "任务已停止", desc: "当前会话的上一轮回答已取消" },
              task_id: `task_${body.msgid}`,
            },
          }
        );
        return;
      }

      if (activeIntent === "continue_current") {
        await bot.replyStreamWithCard(
          frame,
          body.msgid,
          "当前任务仍在继续处理，请稍候。",
          true,
          {
            templateCard: {
              card_type: "text_notice",
              main_title: { title: "任务处理中", desc: "已收到继续处理指令" },
              task_id: `task_${body.msgid}`,
            },
          }
        );
        return;
      }

      followupQuestion = buildFollowupQuestion(activeTask.question, activeText);
      activeTask.cancelled = true;
    }

    if (isHelp) {
      await bot.replyStreamWithCard(
        frame,
        body.msgid,
        buildHelpReply(),
        true,
        {
          templateCard: {
            card_type: "text_notice",
            main_title: { title: "使用帮助", desc: "常用指令和提问技巧" },
            task_id: `task_${body.msgid}`,
          },
        }
      );
      return;
    }

    if (isHardcodedNew) {
      sessionManager.clearSession(sessionKey);
      processedMsgs.add(body.msgid);
      await bot.replyStreamWithCard(
        frame,
        body.msgid,
        "已为您清理所有会话记录，我们可以开始新的对话了。",
        true,
        {
          templateCard: {
            card_type: "text_notice",
            main_title: { title: "会话已重置", desc: "历史记录已清理" },
            task_id: `task_${body.msgid}`,
          },
        }
      );
      return;
    }

    // 会话级回复模式切换：/dev 或 /business
    if (replyModeCommand.modeSwitch) {
      const previousMode = sessionManager.getReplyMode(sessionKey);
      const newMode = replyModeCommand.modeSwitch;
      sessionManager.setReplyMode(sessionKey, newMode);

      const modeLabel = newMode === "dev" ? "开发者模式" : "业务回答模式";
      console.log(`[${botConfig.name}] Reply mode switched for ${sessionKey}: ${previousMode} -> ${newMode}`);

      // 如果携带了新问题，正常处理（后续流程会使用新 mode）
      if (replyModeCommand.strippedText) {
        // strippedText 会在后续 currentQuestion 中被使用
      } else {
        // 无问题：仅切换模式 + 重新格式化上条回答
        const lastRaw = sessionManager.getLastRawAnswer(sessionKey);
        if (!lastRaw) {
          await bot.replyStreamWithCard(frame, body.msgid, `已切换到${modeLabel}。暂无可重新格式化的回答。`, true, {
            templateCard: { card_type: "text_notice", main_title: { title: "模式已切换", desc: modeLabel }, task_id: `task_${body.msgid}` },
          });
          return;
        }

        let reformatted: string;
        if (newMode === "dev") {
          // dev 模式：直接返回原始回答
          reformatted = lastRaw;
        } else {
          // business 模式：重新走业务重写
          try {
            reformatted = await rewriteAnswerForBusiness("", lastRaw);
          } catch {
            reformatted = lastRaw;
          }
        }

        await bot.replyStreamWithCard(frame, body.msgid, `已切换到${modeLabel}。\n\n${reformatted}`, true, {
          templateCard: { card_type: "text_notice", main_title: { title: "模式已切换", desc: modeLabel }, task_id: `task_${body.msgid}` },
        });
        return;
      }
    }

    const originalUserQuestion = typeof parsedContent === "string"
      ? stripBoundaryMentions(parsedContent)
      : extractTextContent(parsedContent as any);
    let effectiveParsedContent: typeof parsedContent = parsedContent;
    const pendingHumanLoop = sessionManager.getPendingHumanLoop(sessionKey);
    const pendingText = stripBoundaryMentions(commandText);
    const currentTurnText = stripBoundaryMentions(extractTextContent(parsedContent as any));
    const historyRelevanceText = currentTurnText || pendingText;
    const activePendingHumanLoop = pendingHumanLoop && !isHumanLoopExpired(pendingHumanLoop)
      ? pendingHumanLoop
      : undefined;
    const isStreamPauseResume = isStreamPauseResumeRequest(activePendingHumanLoop);
    const hasDirectEvidence = hasDirectEvidenceAnchors(originalUserQuestion);

    if (pendingHumanLoop && !activePendingHumanLoop) {
      sessionManager.clearPendingHumanLoop(sessionKey);
    }

    if (
      activePendingHumanLoop
      && !isQueryableProjectsQuestion(originalUserQuestion)
      && isAmbiguousNewTopicWhilePending(pendingText)
    ) {
      await bot.replyStreamWithCard(
        frame,
        body.msgid,
        "当前还有一个等待补充信息的任务。请回复“继续”并带上补充结果，我会接着处理；如需开启新问题，请先发送“清理会话”。",
        true,
        {
          templateCard: {
            card_type: "text_notice",
            main_title: { title: "等待确认", desc: "当前会话存在未完成的人工补充步骤" },
            task_id: `task_${body.msgid}`,
          },
        }
      );
      return;
    }

    if (activePendingHumanLoop) {
      effectiveParsedContent = buildHumanLoopResumeContent(activePendingHumanLoop, pendingText || extractTextContent(parsedContent as any));
      sessionManager.incrementPendingHumanLoopResume(sessionKey);
    } else if (followupQuestion) {
      effectiveParsedContent = followupQuestion;
    } else if (session.messages.length > 0 && pendingText) {
      const historyItems: ConversationContextItem[] = session.messages
        .slice(-6)
        .map(message => {
          if (message instanceof HumanMessage) {
            return { role: "user", content: extractTextContent(message.content as any) };
          }
          if (message instanceof AIMessage) {
            return { role: "assistant", content: stringifyModelContent(message.content) };
          }
          return { role: "system", content: stringifyModelContent(message.content) };
        });
      const relevance = classifyHistoryRelevance(historyItems, historyRelevanceText);
      if (relevance.decision === "independent") {
        console.log(`[Session] Auto clearing unrelated history for ${sessionKey}: ${relevance.reason}`);
        const retainedProfileRepoHints = extractProjectsFromMcpHeaders(sessionManager.resolveMcpHeaders(sessionKey));
        sessionManager.clearConversationHistory(sessionKey, retainedProfileRepoHints);
        session = sessionManager.getOrCreateSession(sessionKey, true);
      } else {
        effectiveParsedContent = buildQuestionWithHistory(historyItems, historyRelevanceText);
      }
    }
    // --- Session Handling End ---

    try {
      if (isQueryableProjectsQuestion(originalUserQuestion)) {
        const sessionMcpHeaderOverrides = sessionManager.resolveMcpHeaders(sessionKey);
        const defaultMcpHeaderCommand = botConfig.defaultMcpHeaderCommand
          ? resolveMcpHeaderCommand(botConfig.defaultMcpHeaderCommand, config.mcpServers)
          : null;
        const effectiveMcpHeaders = Object.keys(sessionMcpHeaderOverrides).length > 0
          ? sessionMcpHeaderOverrides
          : defaultMcpHeaderCommand?.headersByServer ?? {};
        const queryableProjects = extractProjectsFromMcpHeaders(effectiveMcpHeaders);
        const directReply = withMcpEnvironmentNotice(buildQueryableProjectsReply(queryableProjects));
        console.log(`[${botConfig.name}] direct project scope fast path for ${body.msgid}: ${queryableProjects.join(",") || "none"}`);
        await sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: parsedContent as any }),
          new AIMessage(directReply),
        ]);
        await bot.replyStreamWithCard(frame, streamId, directReply, true, {
          templateCard: {
            card_type: "text_notice",
            main_title: {
              title: "当前可查询项目",
              desc: activeMcpHeaderCommand || botConfig.defaultMcpHeaderCommand || "当前环境",
            },
            task_id: `task_${body.msgid}`,
          },
        });
        return;
      }

      const rawQuestion = typeof effectiveParsedContent === "string"
        ? stripBoundaryMentions(effectiveParsedContent)
        : extractTextContent(effectiveParsedContent as any);
      const currentQuestion = replyModeCommand.modeSwitch && replyModeCommand.strippedText
        ? replyModeCommand.strippedText
        : rawQuestion;
      const currentTask: ActiveTaskState = { msgid: body.msgid, cancelled: false, question: currentQuestion };
      activeTasks.set(sessionKey, currentTask);
      const runtimeTodoList = createRuntimeTodoList();
      startTodoItem(runtimeTodoList, "message_parsed");
      completeTodoItem(runtimeTodoList, "message_parsed", `msgid=${body.msgid}, type=${body.msgtype}`);

      if (!startEarlyProgress) {
        // 发送初始进度卡片
        await bot.replyStreamWithCard(frame, streamId, withMcpEnvironmentNotice("正在处理你的问题，请稍候。"), false, {
          templateCard: {
            card_type: 'text_notice',
            main_title: { title: '任务处理中', desc: '正在理解你的问题...' },
            task_id: `task_${body.msgid}`,
          }
        });
      }

      const shouldStopCurrentTask = () => activeTasks.get(sessionKey) !== currentTask || currentTask.cancelled;

      let fullContent = "";
      let flowControl = createDefaultFlowControl();
      let flowControlStreamState = createFlowControlStreamState();
      let coverNextVisibleContent = false;
      const applyFlowControlPatch = (patch: FlowControlPatch) => {
        flowControl = mergeFlowControl(flowControl, patch);
        if (patch.stream?.coverPrevious || patch.stream?.mode === "replace") {
          coverNextVisibleContent = true;
        }
      };
      let finalContentForPrompt: any = effectiveParsedContent;
      let intermediateMessages: BaseMessage[] = [];
      const toolContextRecords: ToolContextRecord[] = [];
      const toolCallMap = new Map<string, { name: string; args: string; notified: boolean; completed: boolean }>();
      const agentProgressGuard = createAgentProgressGuard({
        maxToolResults: getMaxAgentToolResultsPerTurn(),
      });
      let autoVerificationAgent: any = null;
      let autoVerificationScopedEvidenceTools: any[] = [];
      let repoHints: string[] = [];
      let recoveryAuditReason = "";
      let toolErrorLimitReached = false;
      let toolProgressLimitReached = false;
      let lastUpdateTime = 0;
      let heartbeatInFlight = false;
      let lastHeartbeatTime = 0;
      let heartbeatTimer: NodeJS.Timeout | undefined;
      // 阶段耗时打点：用于定位「整理分析结果」慢段
      const logPhaseDuration = (phase: string, startedAt: number) => {
        console.log(`[${botConfig.name}] Phase duration for ${body.msgid}: ${phase}=${Date.now() - startedAt}ms`);
      };
      const UPDATE_INTERVAL = 2000;
      let expiredStreamFinalSent = false;
      let expiredStreamHistorySaved = false;
      let replyAckTimeoutReconnectTriggered = false;
      let replyStreamQueue = Promise.resolve();
      const visibleStreamSnapshots: string[] = [];
      let visiblePlanSteps: readonly UserFacingTodoStep[] | undefined;
      let lastPlanSnapshot = "";
      const rememberVisibleStreamSnapshot = (content: string) => {
        const visible = collapseProgressUpdates(stripProtocolNoise(content)).trim();
        if (!visible) return;
        const lastVisible = visibleStreamSnapshots[visibleStreamSnapshots.length - 1];
        if (lastVisible === visible) return;
        visibleStreamSnapshots.push(visible);
        if (visibleStreamSnapshots.length > 20) {
          visibleStreamSnapshots.shift();
        }
      };
      const saveExpiredStreamHistory = async () => {
        if (expiredStreamHistorySaved) return;
        expiredStreamHistorySaved = true;
        // 保存当前计划状态，供「继续」时复用：只处理未完成项
        if (visiblePlanSteps && visiblePlanSteps.length > 0) {
          const statusMap = new Map(runtimeTodoList.items.map(item => [item.id, item.status]));
          sessionManager.setLastPlanSteps(sessionKey, visiblePlanSteps.map(step => ({
            id: step.id,
            task: step.task,
            status: statusMap.get(step.id) || "pending",
          })));
          console.log(`[${botConfig.name}] Saved plan steps for ${body.msgid}: ${visiblePlanSteps.length} steps`);
        }
        const toolContextSummary = buildToolContextSummary(toolContextRecords);
        const pauseResumeRequest = toStoredHumanLoopRequest(
          buildStreamPauseResumeRequest({
            userQuestion: currentQuestion,
            currentQuestion,
            partialAnswer: collapseProgressUpdates(stripEmptyProtocolContent(fullContent)),
            toolContextSummary,
            repoHints,
          }),
          body.msgid,
        );
        sessionManager.setPendingHumanLoop(sessionKey, pauseResumeRequest);
        await sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: effectiveParsedContent as any }),
          ...(toolContextSummary ? [new SystemMessage(toolContextSummary)] : []),
          new AIMessage(STREAM_EXPIRED_MESSAGE),
        ]);
      };
      type StreamReplyMode = "normal" | "plan";
      let sendPlanSnapshot: (now?: number) => Promise<boolean>;
      const safeReplyStreamNow = async (content: string, final = false, mode: StreamReplyMode = "normal") => {
        if (shouldStopCurrentTask()) return false;
        const safeContent = stripEmptyProtocolContent(content).trim();
        if (!safeContent && !final) return false;
        const replyContent = final
          ? withMcpEnvironmentNotice(safeContent || "未获取到有效回复")
          : mode === "plan"
            ? safeContent
            : buildIntermediateStreamContent(safeContent);
        if (isStreamExpired(streamStartedAt)) {
          await saveExpiredStreamHistory();
          currentTask.cancelled = true;
          if (!expiredStreamFinalSent) {
            expiredStreamFinalSent = true;
            try {
              await bot.replyStream(frame, streamId, withMcpEnvironmentNotice(STREAM_EXPIRED_MESSAGE), true);
            } catch (error) {
              if (!isWeComStreamExpiredError(error)) throw error;
              console.warn(`[${botConfig.name}] WeCom stream already expired for ${body.msgid}; skip final pause update.`);
            }
          }
          return false;
        }

        try {
          await bot.replyStream(frame, streamId, replyContent, final);
          if (!final && mode !== "plan") {
            rememberVisibleStreamSnapshot(safeContent);
          }
          return true;
        } catch (error) {
          if (isWeComStreamExpiredError(error)) {
            await saveExpiredStreamHistory();
            currentTask.cancelled = true;
            expiredStreamFinalSent = true;
            console.warn(`[${botConfig.name}] WeCom stream expired for ${body.msgid}; stop updating old streamId.`);
            return false;
          }
          if (isWeComReplyAckTimeoutError(error)) {
            currentTask.cancelled = true;
            if (!replyAckTimeoutReconnectTriggered) {
              replyAckTimeoutReconnectTriggered = true;
              reconnectBotAfterReplyAckTimeout(bot, botConfig.name, body.msgid);
            }
            return false;
          }
          throw error;
        }
      };
      const safeReplyStream = (content: string, final = false, mode: StreamReplyMode = "normal") => {
        if (!final && mode === "normal" && visiblePlanSteps) {
          return sendPlanSnapshot();
        }
        const replyTask = replyStreamQueue.then(
          () => safeReplyStreamNow(content, final, mode),
          () => safeReplyStreamNow(content, final, mode),
        );
        replyStreamQueue = replyTask.then(() => undefined, () => undefined);
        return replyTask;
      };
      const buildPlanSnapshot = (now = Date.now()) => {
        if (!visiblePlanSteps) return "";
        const todoSteps = renderTodoStepsForHeartbeat(runtimeTodoList, getProcessingFrame(now), visiblePlanSteps);
        if (!todoSteps) return "";
        return `处理进度 · 已用时 ${formatElapsedDuration(streamStartedAt, now)}\n\n${todoSteps}`;
      };
      sendPlanSnapshot = async (now = Date.now()) => {
        const snapshot = buildPlanSnapshot(now);
        if (!snapshot || snapshot === lastPlanSnapshot) return false;
        lastPlanSnapshot = snapshot;
        const sent = await safeReplyStream(snapshot, false, "plan");
        if (!sent && lastPlanSnapshot === snapshot) lastPlanSnapshot = "";
        return sent;
      };

      const sendStageProgress = async (content: string, force = false) => {
        if (shouldStopCurrentTask()) return;
        if (!force && Date.now() - lastUpdateTime <= 1000) return;
        await safeReplyStream(buildProgressStreamContent(content), false);
        lastUpdateTime = Date.now();
      };
      const getActiveToolCalls = () => Array.from(toolCallMap.values())
        .filter(c => c.name && !c.completed)
        .map(c => `> 🔍 正在调用: ${getToolDisplay(c.name, c.args)}...`);
      stopThinkingHeartbeat = () => {
        if (!heartbeatTimer) return;
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      };
      const stopThinkingHeartbeatAndDrain = async () => {
        stopThinkingHeartbeat();
        await replyStreamQueue;
      };
      heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight || shouldStopCurrentTask()) return;
        const now = Date.now();
       if (now - lastHeartbeatTime < THINKING_HEARTBEAT_INTERVAL_MS) return;
       heartbeatInFlight = true;
        const heartbeatTask = visiblePlanSteps
          ? sendPlanSnapshot(now)
          : safeReplyStream(buildThinkingHeartbeatContent(fullContent, getActiveToolCalls(), now, streamStartedAt), false);
        console.log(`[${botConfig.name}] Heartbeat sent for ${body.msgid}: elapsed=${formatElapsedDuration(streamStartedAt, now)}, planMode=${Boolean(visiblePlanSteps)}`);
        void heartbeatTask.then(sent => {
         if (sent) lastHeartbeatTime = Date.now();
       }).catch(error => {
         console.error(`[${botConfig.name}] Thinking heartbeat failed for ${body.msgid}:`, error);
       }).finally(() => {
         heartbeatInFlight = false;
       });
     }, THINKING_HEARTBEAT_INTERVAL_MS);

      // --- Planner Logic Start ---
      let plannerResult: Awaited<ReturnType<typeof runPlanner>> = null;
      const runtimeTodoInstruction = `系统提示：【运行时 TodoList 工具要求】
当前回答由运行时 TodoList 控制流程完成度，TodoList 是动态计划，不是固定审核清单。
如果当前工具列表存在 runtime_todolist_update，只需要维护当前问题实际需要的审核节点；不要为了无关节点补“不适用”，也不要输出内部 TodoList 内容。
如果你需要核对用户整合后的问题，或怀疑历史整合、上下文压缩、提示词增强导致问题失真，必须调用 original_user_question_get 获取整合后的用户问题后再继续分析。
如果当前问题是“继续”、追问上一轮、需要继承历史里的项目/接口/方法/文件/表字段/已分析行号范围，或担心短时记忆压缩导致锚点丢失，必须先调用 session_memory_graph_query 获取相关历史图索引；不要因为默认上下文里没看到历史细节就要求用户补充。
测试环境/dev 环境排障硬约束：如果用户已提供接口 URL、query 参数、请求体、返回体，或明确说“可以直接查库/测试环境可查库”，禁止在查询前询问用户补充 type 含义、状态字段、业务节点、同类型正常样本或数据库连接信息。必须先使用可用工具、代码检索、参数映射和测试库只读查询确认；只有这些查询后仍无法确认，或工具/测试库不可达，才允许 Human Loop，并且必须说明已尝试的工具、SQL 或代码证据。
Human Loop 严格门槛：所有可由 LLM 工具、代码检索、调用链、已保存工具证据、测试/dev 库只读查询验证的信息，都必须先自主核实；只有所有可用路径都核实完仍无法回答，才允许对用户提问。触发 Human Loop 前必须在 context_snapshot.known_facts 写清已核实节点、已分析代码范围、已尝试 SQL/工具/检索条件和剩余最小缺口。
用户意图边界：每轮先判断用户是在要事实取值、用途解释、上下游定位、流程梳理、取数语句、排障原因、处理方案还是代码修改，并只完成当前明确要求的任务。当用户问“是什么/做什么用/作用是什么/哪里来的到哪里去/谁推送谁消费/谁写入谁读取/谁调用被谁调用/值从哪里来/显示条件是什么”时，只查对象用途、来源去向、上下游、读写点、触发位置和代码证据；适用对象包括 Topic、Redis key、接口、按钮、权限码、字段、表、枚举、配置、定时任务、脚本、页面、模块、服务、类、方法、日志 source、消息模板和第三方回调，不局限于 MQ 队列。即使用户附带异常背景、堆积量、监控截图、日志片段或历史结论，也不得主动升级为异常根因、堆积原因、消费失败、发布变更、配置异常、性能瓶颈或处理建议，除非用户明确问为什么、原因、异常、失败、没生效、怎么处理或怎么修。
提问前证据门槛：遇到问题默认先查、先论证，实在查不到、查不准或继续查有真实风险时再问；不得把澄清提问当成检索或论证的前置动作。只要用户已经给出对象名、队列/Topic、vhost、Redis key、接口路径、按钮文案、权限码、字段名、表名、配置 key、日志关键词、错误文案、截图 URL、页面路由、类名、方法名或任务名，必须先用这些锚点自主检索、查配置、查调用链或查可用工具；项目、模块或业务归属未知时，先跨项目/全局检索锚点，不得在检索前询问“这是哪个系统/哪个模块/谁负责”。只有已经尝试可用检索路径后仍出现多个无法消歧的候选、锚点完全无结果、工具不可用、或继续操作存在生产数据/写操作风险时，才允许提问；提问必须说明已查锚点、命中候选或无结果原因、剩余最小歧义。
动态审核节点规则：
1. 代码/项目/接口/页面/仓库类问题：维护 project_scope_audited，证据写明目标范围和命中的入口一致性。
2. 最终回答输出 SQL、生产取数 SQL 或声明 dev 校验：维护 sql_correctness_audited；若 dev 库无对应表，evidence 必须写“dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构”。
3. 需要基于工具、代码、数据库或业务规则下结论：维护 evidence_audited，证据写明核心结论来自哪些已核实事实。
4. 涉及接口链路、按钮显示、状态流转、回调、MQ、外部推送、缺失日志、下游触达条件或异常拦截：维护 execution_flow_audited。
5. 只有涉及代码缺陷、配置异常、流程实现归属、历史逻辑归属或需要推动修复时，才维护 owner_contact_audited，并且联系人线索只能来自最终结论实际引用证据。
没有证据时将当前相关节点标记 blocked 并触发 Human Loop 或说明最小缺口；无关节点不要处理。`;
      const flowControlInstruction = `系统提示：【流程控制 JSON 协议】
当你已经能确定下游节点是否需要继续执行某个步骤时，可以输出流程控制协议。协议必须单独放在 <flow_control>...</flow_control> 中，运行时会剥离，用户不可见。
格式：
<flow_control>{"next":{"runSqlAudit":false,"skipAuditItems":["execution_flow_audited","owner_contact_audited"]},"stream":{"coverPrevious":true}}</flow_control>
字段含义：
- next.runSqlAudit=false：当前最终回答不涉及 SQL 输出或 SQL 审核不适用，下游跳过 SQL 正确性审核；不确定时不要输出该字段，默认继续审核。
- next.skipAuditItems：当上游已经明确判断某些后续审核节点不需要处理时，列出要跳过的 itemId；运行时只会影响当前动态计划里已经存在的节点。可选值：project_scope_audited、sql_correctness_audited、evidence_audited、execution_flow_audited、owner_contact_audited、final_format_audited。只有明确不适用时才输出；如果最终回答包含 SQL 或声明 dev 校验，不能用 skipAuditItems 跳过 sql_correctness_audited。
- stream.coverPrevious=true：下一段真实可见内容应覆盖前面已展示的阶段性流式内容；不确定时不要输出该字段，默认追加。
只输出明确需要改变默认行为的字段，不要把 flow_control 写进最终业务结论。`;

      // 提取文本内容进行 Planner 分析
      let textToPlan = "";
      if (typeof effectiveParsedContent === 'string') {
        textToPlan = stripBoundaryMentions(effectiveParsedContent);
      } else if (Array.isArray(effectiveParsedContent)) {
        const textItem = effectiveParsedContent.find(i => i.type === 'text');
        if (textItem) textToPlan = stripBoundaryMentions(textItem.text || "");
      }

      // 分流决策在 planner 意图分析之后产生（见 Planner Logic End 后的 classifyQuestionDifficulty）
      let questionDifficulty: QuestionDifficulty = "complex";

      if (isStreamPauseResume) {
        startTodoItem(runtimeTodoList, "planner_checked");
        completeTodoItem(runtimeTodoList, "planner_checked", "stream pause resume: skipped planner/prelude to avoid restarting from head");
        // 复用暂停前保存的计划：已完成项保持 ✓，只处理未完成项
        const storedPlanSteps = sessionManager.getLastPlanSteps(sessionKey);
        let planResumeInstruction = "";
        if (storedPlanSteps && storedPlanSteps.length > 0) {
          for (const step of storedPlanSteps) {
            if (step.status === "done" && hasTodoItem(runtimeTodoList, step.id)) {
              completeTodoItem(runtimeTodoList, step.id, "resumed from saved plan");
            }
          }
          visiblePlanSteps = storedPlanSteps.map(step => ({ id: step.id, task: step.task }));
          const planProgressText = storedPlanSteps
            .map(step => `${step.status === "done" ? "✓" : "○"} ${step.task}`)
            .join("\n");
          planResumeInstruction = `\n\n系统提示：【断点恢复计划】\n暂停前计划进度：\n${planProgressText}\n已完成项无需重新处理，只继续未完成项。`;
          console.log(`[${botConfig.name}] Restored saved plan for ${body.msgid}: ${storedPlanSteps.length} steps (${storedPlanSteps.filter(step => step.status === "done").length} done)`);
          // 恢复的计划立即以快照呈现给用户
          void sendPlanSnapshot();
        }
        if (typeof effectiveParsedContent === 'string') {
          finalContentForPrompt = `${runtimeTodoInstruction}\n\n${flowControlInstruction}\n\n${buildStreamPauseResumeRuntimeInstruction()}${planResumeInstruction}\n\n${effectiveParsedContent}`;
        } else if (Array.isArray(effectiveParsedContent)) {
          finalContentForPrompt = [
            { type: 'text', text: `${runtimeTodoInstruction}\n\n${flowControlInstruction}\n\n${buildStreamPauseResumeRuntimeInstruction()}${planResumeInstruction}\n\n` },
            ...effectiveParsedContent,
          ];
        }
      } else if (textToPlan.trim().length > 0) {
        try {
          startTodoItem(runtimeTodoList, "planner_checked");
          await sendStageProgress("已收到问题，正在识别意图和检索锚点，继续核实中。", true);
          plannerResult = await runPlanner(textToPlan);
          if (plannerResult) {
            completeTodoItem(runtimeTodoList, "planner_checked", `intent=${plannerResult.intent || "unknown"}`);
            syncRuntimeAuditTodoPlan(runtimeTodoList, {
              question: currentQuestion,
              plannerIntent: plannerResult.intent,
              secondaryIntents: plannerResult.secondary_intents,
            });
            const initialVisiblePlanSteps = snapshotUserFacingTodoSteps(runtimeTodoList);
            if (initialVisiblePlanSteps.length > 0) {
              visiblePlanSteps = initialVisiblePlanSteps;
              await sendPlanSnapshot();
            }
            const queryLimit = isDirectMatchIntent(plannerResult.intent) ? 1 : 16;
            const queries = plannerResult.queries?.slice(0, queryLimit).map(q => `- ${q.query} (${q.type}, 优先级: ${q.priority})`).join('\n') || '';
            const hypotheses = plannerResult.hypotheses?.map(h => `- ${h.title} (推荐查询: ${h.queries?.join(', ') || ''})`).join('\n') || '';
            
            // 优先使用去实例化检索词，避免品牌/租户/完整文案干扰代码搜索。
            const rawCodeTerms = plannerResult.code_terms?.combined || "";
            let cleanCodeTerms = plannerResult.code_terms?.stripped_combined || "";
            if (!cleanCodeTerms) {
              const allTerms = [
                ...(plannerResult.code_terms?.english || []),
                ...(plannerResult.code_terms?.chinese || []),
                ...(plannerResult.code_terms?.mixed || [])
              ].filter(t => t && t.length > 0);
              cleanCodeTerms = Array.from(new Set(allTerms)).join(' ');
            }
            
            const intents = [plannerResult.intent, ...(plannerResult.secondary_intents || [])].filter(Boolean).join(', ');
            const smsTemplateEvidenceHint = /短信|模板|文案|推送|发送|通知/.test(textToPlan)
              ? `

【短信/模板/推送来源通用证据规则】
当前问题涉及短信、模板、文案、推送、发送或通知来源。必须按证据优先排查：
1. 先从用户问题中提取“消息正文/模板正文”的稳定片段，剔除品牌、租户、人名、手机号、订单号、验证码、时间等实例值。
2. 工具选择、参数名和跨库方式必须以当前 MCP tool description/schema 为准；不要调用不存在的工具名，也不要编造 \`repoFilter\` 等未出现在 schema 中的参数。
3. 首轮检索应保留跨项目发现能力：除非用户明确指定“只查某仓库/某项目”，不得把上下文项目名、历史命中项目或默认项目作为过滤参数。
4. 一旦命中代码文件，必须继续读取触发方法、模板配置读取、文案拼接和发送调用附近证据。
5. 如果多个项目同时命中，必须优先判断用户明确指定的项目、上下文指向的项目或当前业务实际使用项目；旧项目、历史项目或相似项目证据只能作为对比，不能覆盖目标项目结论。
6. 同一业务场景在老系统、新系统或不同技术栈项目中可能存在多套实现。必须分别核实所有命中项目中的入口、模板配置读取、文案拼接和发送调用，再给出当前应以哪个项目为准。
7. 证据优先级：当前目标项目中的“稳定文案片段或文案拼接逻辑 + 发送调用” > 当前目标项目中的“模板配置读取 + 占位符替换 + 发送调用” > 其他项目同场景直接证据 > 统一发送接口 > 业务经验推断。
8. 如果已经命中当前目标项目的直接证据，必须停止扩散检索，直接组织答案；不要继续跨项目枚举相似流程。
9. 最终回答必须引用已命中的仓库、文件、方法和发送调用；没有直接代码/配置证据时，只能说明“未核实到直接来源”，禁止按业务经验猜测具体系统或流程。`
              : "";

            // 提供结构化的搜索建议，引导大模型按 MCP 要求进行高效率查询
            const searchPlanHint = `系统提示：【检索与分析规划建议】
意图识别: ${intents} (置信度: ${plannerResult.confidence})
标准问题: ${plannerResult.normalized_question}

【纯净逻辑检索词 (stripped_combined，优先用于 Zoekt/GitNexus 代码检索)】
${cleanCodeTerms}

【原始业务词 (combined，仅用于理解上下文，禁止直接作为代码检索词)】
${rawCodeTerms}

【推荐查询 (Queries)】
${queries}

【问题假设与排查方向】
${hypotheses}

【核心红线】
* 工具选择、调用顺序、参数名和跨库方式以当前 MCP tools 的 description/schema 为准；系统提示只提供业务检索词和证据约束，不替代工具说明。
* 首轮代码检索必须保持跨项目发现能力：除非用户明确要求“只查某仓库/某项目”，否则不得把项目名作为过滤参数；如果用户明确指定 GitNexus repo 且工具 schema 支持 repo 参数，当次查询必须携带该 repo。
* 严禁在代码检索中包含人名、商品名、租户名、订单号等实例数据。
* 如果意图模糊，参考问题假设进行进一步排查。
* GitNexus query 成本较高，必须合并查询条件：把项目、核心业务词、动作词、接口/文件锚点尽量放入一次 query/zoekt；同一问题原则上不超过 16 次 query，命中候选文件后改用 code_snippet/context 或已有证据回答。
* 严禁拆分关键词进行多次循环搜索。${smsTemplateEvidenceHint}`;
            
            if (typeof effectiveParsedContent === 'string') {
              finalContentForPrompt = `${runtimeTodoInstruction}\n\n${flowControlInstruction}\n\n${hasDirectEvidence ? `${buildDirectEvidenceRuntimeInstruction()}\n\n` : ""}${searchPlanHint}\n\n${effectiveParsedContent}`;
            } else if (Array.isArray(effectiveParsedContent)) {
              finalContentForPrompt = [
                { type: 'text', text: `${runtimeTodoInstruction}\n\n${flowControlInstruction}\n\n${hasDirectEvidence ? `${buildDirectEvidenceRuntimeInstruction()}\n\n` : ""}${searchPlanHint}\n\n` },
                ...effectiveParsedContent.map(item => item.type === 'text' ? { ...item, text: stripBoundaryMentions(item.text || '') } : item)
              ];
            }
          } else {
            completeTodoItem(runtimeTodoList, "planner_checked", "planner returned empty result, fallback to original question");
          }
        } catch (err) {
          console.error("Planner execution failed:", err);
          completeTodoItem(runtimeTodoList, "planner_checked", `planner failed, fallback to original question: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        startTodoItem(runtimeTodoList, "planner_checked");
        completeTodoItem(runtimeTodoList, "planner_checked", "empty text, planner skipped");
      }
      if (typeof finalContentForPrompt === 'string') {
        finalContentForPrompt = finalContentForPrompt.includes("runtime_todolist_update")
          ? finalContentForPrompt
          : `${runtimeTodoInstruction}\n\n${flowControlInstruction}\n\n${finalContentForPrompt}`;
      } else if (Array.isArray(finalContentForPrompt)) {
        const hasInstruction = finalContentForPrompt.some(item => item.type === "text" && item.text?.includes("runtime_todolist_update"));
        if (!hasInstruction) {
          finalContentForPrompt = [
            { type: "text", text: `${runtimeTodoInstruction}\n\n${flowControlInstruction}\n\n` },
            ...finalContentForPrompt,
          ];
        }
      }
      // --- Planner Logic End ---

      // planner 意图分析后的分流：queries=0 简单直接答；1-2 中等一次查询；>2 复杂完整流程
      questionDifficulty = isStreamPauseResume ? "complex" : classifyQuestionDifficulty(plannerResult);
      const useFastPath = questionDifficulty === "simple";
      // 直接匹配型：SQL/CONFIG/DOC/AUTH 意图，走 agent 但仅提示词区别（关键词匹配、命中即答）
      const DIRECT_MATCH_REACT_LOOP_CONTROL = {
        maxToolActions: 4,
        maxQueryToolActions: 1,
        maxRepeatedToolActions: 1,
      };
      const useDirectMatch = !isStreamPauseResume
        && !useFastPath
        && isDirectMatchIntent(plannerResult?.intent);
      // 直接匹配型无需验证推理链，始终跳过自动验证
      const skipVerification = questionDifficulty !== "complex" || useDirectMatch;
      console.log(`[${botConfig.name}] Question difficulty for ${body.msgid}: ${questionDifficulty} (queries=${plannerResult?.queries?.length ?? 0}, directMatch=${useDirectMatch}, intent=${plannerResult?.intent ?? "unknown"})`);

      const ensureAutoVerificationAgent = async () => {
        if (autoVerificationAgent) {
          return {
            agent: autoVerificationAgent,
            scopedEvidenceTools: autoVerificationScopedEvidenceTools,
          };
        }

        const sessionMcpHeaderOverrides = sessionManager.resolveMcpHeaders(sessionKey);
        const defaultMcpHeaderCommand = botConfig.defaultMcpHeaderCommand
          ? resolveMcpHeaderCommand(botConfig.defaultMcpHeaderCommand, config.mcpServers)
          : null;
        const mcpHeaderOverrides = Object.keys(sessionMcpHeaderOverrides).length > 0
          ? sessionMcpHeaderOverrides
          : defaultMcpHeaderCommand?.headersByServer ?? {};
        const toolsLoadStartedAt = Date.now();
        const tools = await getAllMcpTools(botConfig, mcpHeaderOverrides);
        logPhaseDuration(`tools_load(count=${tools.length})`, toolsLoadStartedAt);
        const defaultRepoHints = extractProjectsFromMcpHeaders(mcpHeaderOverrides);
        const explicitRepoHints = extractExplicitRepoHints(textToPlan, defaultRepoHints);
        repoHints = sessionManager.resolveRepoHints(sessionKey, explicitRepoHints, defaultRepoHints);
        autoVerificationScopedEvidenceTools = scopeToolsToRepo(tools, repoHints);
        syncRuntimeAuditTodoPlan(runtimeTodoList, {
          question: currentQuestion,
          repoHints,
          ...(plannerResult?.intent ? { plannerIntent: plannerResult.intent } : {}),
          ...(plannerResult?.secondary_intents ? { secondaryIntents: plannerResult.secondary_intents } : {}),
        });
        const agentTools = [
          ...autoVerificationScopedEvidenceTools,
          buildOriginalQuestionTool({
            originalUserQuestion,
            currentQuestion,
            sessionMessages: session.messages,
          }),
          buildSessionMemoryGraphTool({
            graph: session.memoryGraph,
            currentQuestion,
          }),
          buildRuntimeTodoTool(runtimeTodoList),
          buildToolResultFileReadTool(),
        ];
        completeTodoItem(runtimeTodoList, "tools_loaded", `tools=${agentTools.length}, repoHints=${repoHints.join(",") || "none"}`);
        console.log(`[${botConfig.name}] Agent tool budget for ${body.msgid}: directMatch=${useDirectMatch}, maxToolActions=${useDirectMatch ? DIRECT_MATCH_REACT_LOOP_CONTROL.maxToolActions : "default"}, maxQueryToolActions=${useDirectMatch ? DIRECT_MATCH_REACT_LOOP_CONTROL.maxQueryToolActions : "default"}`);
        autoVerificationAgent = await initializeAgent(agentTools, plannerResult, {
          reactLoopControl: useDirectMatch
            ? DIRECT_MATCH_REACT_LOOP_CONTROL
            : undefined,
        });
        return {
          agent: autoVerificationAgent,
          scopedEvidenceTools: autoVerificationScopedEvidenceTools,
        };
      };

      const runAutoVerificationAgentRound = async (
        userContent: any,
        resetCandidate: boolean,
        signal?: AbortSignal,
      ): Promise<AutoVerificationRoundResult> => {
        if (signal?.aborted || shouldStopCurrentTask()) {
          throw new Error(STREAM_EXPIRED_MESSAGE);
        }
        const { agent } = await ensureAutoVerificationAgent();
        const roundToolRecordStart = toolContextRecords.length;
        if (resetCandidate) {
          fullContent = "";
          toolCallMap.clear();
          flowControlStreamState = createFlowControlStreamState();
        }

        const stream = await agent.stream({
          messages: buildMessagesForCurrentTurn({
            sessionMessages: session.messages,
            userContent,
            repoHint: repoHints,
          }),
        }, {
          recursionLimit: useDirectMatch
            ? Math.min(config.llm.recursionLimit, 8)
            : config.llm.recursionLimit,
          streamMode: "messages",
          ...(signal ? { signal } : {}),
        });

        for await (const [message, metadata] of stream) {
          const streamMetadata = metadata as AgentStreamMetadata | undefined;
          if (signal?.aborted || shouldStopCurrentTask()) {
            fullContent = "";
            throw new Error(STREAM_EXPIRED_MESSAGE);
          }
          if (streamMetadata?.answerReview?.resetContent) {
            fullContent = "";
            visibleStreamSnapshots.length = 0;
          }
          if (streamMetadata?.flowControl) {
            applyFlowControlPatch(streamMetadata.flowControl);
          }
          if (streamMetadata?.answerReview?.progress) {
            await sendStageProgress(stringifyModelContent(message.content), true);
            continue;
          }
          const msg = message as BaseMessage;
          intermediateMessages.push(msg);

          const type = (msg as any)._getType?.() || msg.constructor.name;
          if (type === "tool" || type === "ToolMessage") {
            const toolMsg = msg as any;
            const id = toolMsg.tool_call_id;
            const entry = toolCallMap.get(id);
            if (entry) {
              entry.completed = true;
            }
            const toolRecord: ToolContextRecord = {
              id,
              name: entry?.name || toolMsg.name || "unknown_tool",
              args: entry?.args || "",
              content: stringifyModelContent(toolMsg.content),
              ...(toolMsg.status === "success" || toolMsg.status === "error"
                ? { status: toolMsg.status }
                : {}),
            };
            toolContextRecords.push(toolRecord);
            toolMsg.content = filterToolResultForCurrentTurn(toolRecord);
            console.log(`[Tool Call Result] Name: ${toolRecord.name}, Status: ${toolRecord.status || "unknown"}, Args: ${toolRecord.args}, Result Size: ${stringifyModelContent(toolMsg.content).length}`);
            const guardDecision = agentProgressGuard.recordToolResult(toolRecord);
            if (guardDecision.shouldStop) {
              if (guardDecision.errorCode === "AGENT_TOOL_ERROR_LIMIT") {
                throw createAgentToolErrorLimitError(guardDecision.reason);
              }
              throw createAgentProgressLimitError(guardDecision.reason);
            }
            continue;
          }

          if (type === "ai" || type === "AIMessage" || type === "AIMessageChunk") {
            const aiMsg = msg as any;
            if (aiMsg.tool_call_chunks && aiMsg.tool_call_chunks.length > 0) {
              for (const chunk of aiMsg.tool_call_chunks) {
                const id = chunk.id;
                if (!id) continue;
                if (!toolCallMap.has(id)) {
                  toolCallMap.set(id, { name: "", args: "", notified: false, completed: false });
                }
                const entry = toolCallMap.get(id)!;
                if (chunk.name) entry.name = chunk.name;
                if (chunk.args) entry.args += chunk.args;

                const activeCalls = getActiveToolCalls();
                if (activeCalls.length > 0) {
                  const statusMsg = buildProgressStreamContent(fullContent, activeCalls);
                  if (Date.now() - lastUpdateTime > 1000) {
                    if (!shouldStopCurrentTask()) {
                      await safeReplyStream(statusMsg, false);
                    }
                    lastUpdateTime = Date.now();
                  }
                }
              }
              continue;
            }

            if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
              for (const tool of aiMsg.tool_calls) {
                if (!tool.name) continue;
                const id = tool.id || `${tool.name}-${Date.now()}`;
                toolCallMap.set(id, {
                  name: tool.name,
                  args: JSON.stringify(tool.args || {}),
                  notified: true,
                  completed: false,
                });
                console.log(`[Tool Call] Name: ${tool.name}, Args: ${JSON.stringify(tool.args)}`);
                const statusMsg = buildProgressStreamContent(fullContent, [
                  `> 🔍 正在调用: ${getToolDisplay(tool.name, tool.args)}...`,
                ]);
                if (!shouldStopCurrentTask()) {
                  await safeReplyStream(statusMsg, false);
                }
              }
              continue;
            }

            if (aiMsg.content) {
              const extractedDelta = consumeFlowControlDelta(
                stripEmptyProtocolContent(stringifyModelContent(aiMsg.content)),
                flowControlStreamState,
              );
              if (extractedDelta.hasControl) {
                applyFlowControlPatch(extractedDelta.control);
              }
              const delta = extractedDelta.content;
              if (delta.trim().length > 0) {
                if (coverNextVisibleContent) {
                  fullContent = delta;
                  coverNextVisibleContent = false;
                } else if (fullContent && delta.startsWith(fullContent)) {
                  fullContent = delta;
                } else {
                  fullContent += delta;
                }

                if (fullContent && Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
                  if (!shouldStopCurrentTask()) {
                    await safeReplyStream(collapseProgressUpdates(fullContent), false);
                  }
                  lastUpdateTime = Date.now();
                }
              }
            }
          }
        }

        for (const [id, entry] of toolCallMap.entries()) {
          if (!entry.completed && entry.name) {
            console.log(`[Tool Call Pending/Final] Name: ${entry.name}, Args: ${entry.args}`);
          }
        }

        return {
          content: fullContent,
          evidenceGaps: [],
          toolRecords: toolContextRecords.slice(roundToolRecordStart),
        };
      };
      const runAgentRoundWithTiming = async (
        userContent: any,
        resetCandidate: boolean,
        signal?: AbortSignal,
      ): Promise<AutoVerificationRoundResult> => {
        const startedAt = Date.now();
        const result = await runAutoVerificationAgentRound(userContent, resetCandidate, signal);
        logPhaseDuration(`agent_round(reset=${resetCandidate})`, startedAt);
        return result;
      };

      // 简单问题快速路径：planner 已分析（queries=0），跳过 MCP 工具与搜索循环，直接 LLM 回答
      let fastPathAnswer = "";
      if (useFastPath) {
        startTodoItem(runtimeTodoList, "tools_loaded");
        completeTodoItem(runtimeTodoList, "tools_loaded", "fast path: skipped MCP tool loading");
        startTodoItem(runtimeTodoList, "analysis_finished");
        try {
          const businessPrompt = await getBusinessPrompt(plannerResult);
          const baseModel = await getBaseModel();
          const fastPathStart = Date.now();
          const fastPathResponse = await baseModel.invoke([
            new SystemMessage(businessPrompt),
            ...buildMessagesForCurrentTurn({
              sessionMessages: session.messages,
              userContent: currentQuestion,
              repoHint: [],
            }),
          ]);
          const candidate = stringifyModelContent(fastPathResponse.content);
          const fastPathDuration = formatElapsedDuration(fastPathStart);
          if (hasUncertaintyMarkers(candidate)) {
            console.log(`[${botConfig.name}] Fast path uncertainty detected for ${body.msgid}: falling back to full pipeline (duration=${fastPathDuration})`);
            completeTodoItem(runtimeTodoList, "analysis_finished", "fast path uncertainty markers detected, fallback to full pipeline");
            questionDifficulty = "complex";
          } else {
            fastPathAnswer = candidate;
            console.log(`[${botConfig.name}] Fast path completed for ${body.msgid}: duration=${fastPathDuration}, contentLength=${fastPathAnswer.length}`);
            completeTodoItem(runtimeTodoList, "analysis_finished", `fast path contentLength=${fastPathAnswer.length}, duration=${fastPathDuration}`);
          }
        } catch (fastPathError) {
          console.error(`[${botConfig.name}] Fast path failed for ${body.msgid}, falling back to full pipeline:`, fastPathError);
          completeTodoItem(runtimeTodoList, "analysis_finished", "fast path error, fallback to full pipeline");
          questionDifficulty = "complex";
        }
      }

      // 直接匹配型提示词注入：走 agent，但提示只做关键词匹配、命中即答、不扩展推理
      if (useDirectMatch && plannerResult) {
        const directMatchInstruction = `系统提示：【直接匹配回答】
当前问题可以通过关键词直接匹配代码、配置或数据得到答案，不需要多步逻辑推理。
1. 优先用规划阶段给出的检索词直接查询，命中即基于证据组织答案
2. 本次最多执行一次关键词检索，后续只允许读取命中证据所需的最小上下文
3. 不要扩展检索范围、不要推理因果链、不要多轮假设验证
4. 证据不足时明确说明未找到，不要推理猜测
5. 回答中保留关键取值（字段名、参数值、枚举值、错误码、配置值）原文`;
        if (typeof finalContentForPrompt === 'string') {
          finalContentForPrompt = `${directMatchInstruction}\n\n${finalContentForPrompt}`;
        } else if (Array.isArray(finalContentForPrompt)) {
          finalContentForPrompt = [
            { type: 'text', text: `${directMatchInstruction}\n\n` },
            ...finalContentForPrompt,
          ];
        }
        console.log(`[${botConfig.name}] Direct match instruction injected for ${body.msgid}: intent=${plannerResult.intent}`);
      }

      // 明确入口问题：先精确定位入口/板块，再拉图信息，从代码整理答案。
      // 入口锚点由 planner 模型节点识别（entry_anchors），不用正则。
      const entryAnchors = plannerResult?.entry_anchors?.filter(Boolean) ?? [];
      const useEntryAnchor = !useFastPath
        && !isStreamPauseResume
        && entryAnchors.length > 0;
      if (useEntryAnchor) {
        const anchorListText = entryAnchors.map(anchor => `- ${anchor}`).join("\n");
        const entryAnchorInstruction = `${buildEntryAnchorGraphInstruction()}\n已识别的入口锚点：\n${anchorListText}`;
        if (typeof finalContentForPrompt === 'string') {
          finalContentForPrompt = `${entryAnchorInstruction}\n\n${finalContentForPrompt}`;
        } else if (Array.isArray(finalContentForPrompt)) {
          finalContentForPrompt = [
            { type: 'text', text: `${entryAnchorInstruction}\n\n` },
            ...finalContentForPrompt,
          ];
        }
        console.log(`[${botConfig.name}] Entry anchor instruction injected for ${body.msgid}: ${entryAnchors.length} anchors`);
      }

      // 记录流式过程中的所有消息，用于容错恢复
      try {
        if (fastPathAnswer) {
          fullContent = fastPathAnswer;
        // 快路径只看用户本轮原始输入，避免拼接历史 AI 输出（含"原因分析/调用链/代码位置"等 section）误触发跳过工具加载。
        } else if (!useFastPath && shouldUseWeComDirectEvidenceFastPath(originalUserQuestion)) {
          startTodoItem(runtimeTodoList, "tools_loaded");
          completeTodoItem(runtimeTodoList, "tools_loaded", "direct evidence fast path: skipped MCP tool loading");
          startTodoItem(runtimeTodoList, "analysis_finished");
          const businessPrompt = await getBusinessPrompt(plannerResult);
          const baseModel = await getBaseModel();
          const fastPathResponse = await baseModel.invoke([
            new SystemMessage(`${businessPrompt}\n\n${buildDirectEvidenceFastPathInstruction()}`),
            new HumanMessage(typeof finalContentForPrompt === "string" ? finalContentForPrompt : currentQuestion),
          ]);
          fullContent = ensureRecoverySqlAuditMarker(stringifyModelContent(fastPathResponse.content));
          completeTodoItem(runtimeTodoList, "analysis_finished", `direct evidence fast path contentLength=${fullContent.length}`);
        } else {
        startTodoItem(runtimeTodoList, "tools_loaded");
        await sendStageProgress("正在加载 MCP 工具和项目范围，继续核实中。", true);
        const { scopedEvidenceTools } = await ensureAutoVerificationAgent();
        await sendStageProgress("已加载可用工具，正在判断是否需要预检索，继续核实中。", true);

        if (!isStreamPauseResume && !hasDirectEvidence && !useDirectMatch && plannerResult && textToPlan.trim().length > 0) {
          await sendStageProgress("正在执行预检索以缩小证据范围，继续核实中。", true);
          const prelude = await runSearchLoopPrelude({
            userQuestion: textToPlan,
            plannerResult,
            tools: scopedEvidenceTools,
            repoHint: repoHints,
          });

          if (prelude) {
            if (typeof finalContentForPrompt === 'string') {
              finalContentForPrompt = `${prelude}\n\n${finalContentForPrompt}`;
            } else if (Array.isArray(finalContentForPrompt)) {
              finalContentForPrompt = [
                { type: 'text', text: `${prelude}\n\n` },
                ...finalContentForPrompt,
              ];
            }
          }
        }

        startTodoItem(runtimeTodoList, "analysis_finished");
        await sendStageProgress("正在启动业务分析节点，继续核实中。", true);
        await sendStageProgress("业务分析节点已启动，正在调用模型和工具核实证据，继续核实中。", true);
        await runAgentRoundWithTiming(finalContentForPrompt, false);
        completeTodoItem(runtimeTodoList, "analysis_finished", `contentLength=${fullContent.length}, toolResults=${toolContextRecords.length}`);
        }

      } catch (err: any) {
        console.error(`Agent execution error for ${body.msgid}:`, err);
        blockTodoItem(runtimeTodoList, "analysis_finished", err instanceof Error ? err.message : String(err));
        
        if (err.lc_error_code === "AGENT_TOOL_ERROR_LIMIT") {
          toolErrorLimitReached = true;
          fullContent = buildAgentToolErrorLimitReply(err.message || "工具查询多次失败");
          completeTodoItem(runtimeTodoList, "analysis_finished", "tool error limit reached, sent direct user feedback");
        // 特别处理递归超限错误 (GRAPH_RECURSION_LIMIT)
        } else if (err.lc_error_code === 'GRAPH_RECURSION_LIMIT' || err.lc_error_code === 'AGENT_TOOL_PROGRESS_LIMIT' || err.message?.includes('Recursion limit')) {
          toolProgressLimitReached = true;
          try {
            console.log(`[${botConfig.name}] [Recovery] Agent progress limit reached for ${body.msgid}, attempting fallback synthesis...`);
            const baseModel = await getBaseModel();
            const businessPrompt = await getBusinessPrompt(plannerResult);

            // 构造恢复提示词：将已有的所有中间历史（包括工具调用和结果）发给不带 tools 的大模型进行总结
            const recoveryMessages = [
              new SystemMessage(buildProgressLimitRecoverySystemPrompt(businessPrompt)),
              ...buildMessagesForCurrentTurn({
                sessionMessages: session.messages,
                userContent: finalContentForPrompt,
                repoHint: repoHints,
              }),
              ...(buildToolContextSummary(toolContextRecords)
                ? [new SystemMessage(buildToolContextSummary(toolContextRecords))]
                : intermediateMessages)
            ];

            const recoveryResponse = await baseModel.invoke(recoveryMessages);
            fullContent = ensureRecoverySqlAuditMarker(stringifyModelContent(recoveryResponse.content));
            recoveryAuditReason = err.lc_error_code === "AGENT_TOOL_PROGRESS_LIMIT"
              ? "工具调用达到进展守卫上限后的恢复总结"
              : "LangGraph 递归上限后的恢复总结";
            completeTodoItem(runtimeTodoList, "analysis_finished", `recovery contentLength=${fullContent.length}`);
          } catch (recoveryErr) {
            console.error(`Recovery synthesis failed for ${body.msgid}:`, recoveryErr);
            const errorFallback = `${buildUserFacingErrorReply(err)}

${buildUserFacingErrorReply(recoveryErr, "恢复处理时发生异常")}`;
            fullContent = fullContent ? `${fullContent}

${errorFallback}` : errorFallback;
            completeTodoItem(runtimeTodoList, "analysis_finished", "recovery failed, sent actual error fallback");
          }
        } else {
          const errorFallback = buildUserFacingErrorReply(err);
          fullContent = fullContent ? `${fullContent}

${errorFallback}` : errorFallback;
          completeTodoItem(runtimeTodoList, "analysis_finished", "agent error, sent actual error fallback");
        }
      }

      // 自动续查和最终评审期间继续维持心跳，终态发送前再统一停止。

      // --- Update Session History ---
      if (fullContent) {
        const extractedFullContent = extractFlowControl(stripEmptyProtocolContent(fullContent));
        fullContent = extractedFullContent.content;
        if (extractedFullContent.hasControl) {
          flowControl = mergeFlowControl(flowControl, extractedFullContent.control);
        }
      }

      if (shouldStopCurrentTask()) {
        fullContent = "";
      }

      if (toolErrorLimitReached && fullContent) {
        fullContent = collapseProgressUpdates(stripEmptyProtocolContent(fullContent));
        const toolContextSummary = buildToolContextSummary(toolContextRecords);
        await sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: effectiveParsedContent as any }),
          ...(toolContextSummary ? [new SystemMessage(toolContextSummary)] : []),
          new AIMessage(fullContent),
        ]);
        stopThinkingHeartbeat();
        if (!shouldStopCurrentTask()) {
          await safeReplyStream(fullContent, true);
        }
        if (activeTasks.get(sessionKey) === currentTask) {
          activeTasks.delete(sessionKey);
        }
        return;
      }

      if (fullContent) {
        const missingPriorityAnchors = typeof finalContentForPrompt === "string"
          ? getMissingPriorityAnswerAnchors(finalContentForPrompt, fullContent)
          : [];
        if (missingPriorityAnchors.length > 0) {
          try {
            const baseModel = await getBaseModel();
            fullContent = await repairAnswerForMissingPriorityAnchors({
              model: baseModel,
              questionWithHistory: finalContentForPrompt,
              answer: fullContent,
            });
            if (hasTodoItem(runtimeTodoList, "evidence_audited")) {
              completeTodoItem(runtimeTodoList, "evidence_audited", `已补齐历史优先锚点覆盖：${missingPriorityAnchors.join(", ")}`);
            }
          } catch (anchorRepairError) {
            console.error(`[${botConfig.name}] Failed to repair answer priority anchors for ${body.msgid}:`, anchorRepairError);
          }
        }

        const humanLoopRequest = detectHumanLoopRequest(fullContent);
        const proposedHumanLoopReply = humanLoopRequest ? buildHumanLoopReply(humanLoopRequest) : "";
        const repeatedHumanLoopOutput = hasRepeatedInputOutput(
          memoryGraphBeforeCurrentTurn,
          currentQuestion,
          proposedHumanLoopReply,
        );
        if (humanLoopRequest && repeatedHumanLoopOutput) {
          const storedRequest = toStoredHumanLoopRequest(humanLoopRequest, body.msgid);
          sessionManager.setPendingHumanLoop(sessionKey, storedRequest);
          fullContent = buildHumanLoopReply(storedRequest);
        } else if (humanLoopRequest) {
          fullContent = "当前信息仍未形成最终结论，且图记忆未检测到重复输入输出，将继续基于现有线索核实。";
        } else if (activePendingHumanLoop) {
          sessionManager.clearPendingHumanLoop(sessionKey);
        }

      }

      // 发送最终结果
      fullContent = collapseProgressUpdates(stripEmptyProtocolContent(fullContent));

      const sqlAuditEvidence = buildSqlAuditEvidence(fullContent, toolContextRecords, summarizeTodoList(runtimeTodoList));
      syncRuntimeAuditTodoPlan(runtimeTodoList, {
        question: currentQuestion,
        answer: fullContent,
        repoHints,
        toolResultCount: toolContextRecords.length,
        sqlAuditEvidence,
        skipAuditItems: flowControl.next.skipAuditItems,
        ...(plannerResult?.intent ? { plannerIntent: plannerResult.intent } : {}),
        ...(plannerResult?.secondary_intents ? { secondaryIntents: plannerResult.secondary_intents } : {}),
      });
      const skipAuditItems = new Set(flowControl.next.skipAuditItems);
      const shouldSkipSqlAudit = !flowControl.next.runSqlAudit || skipAuditItems.has("sql_correctness_audited");
      if (hasTodoItem(runtimeTodoList, "sql_correctness_audited")) {
        if (shouldSkipSqlAudit && !isSqlAuditEvidenceBlocking(sqlAuditEvidence)) {
          console.log(`[${botConfig.name}] FlowControl skipped SQL audit for ${body.msgid}: ${sqlAuditEvidence}`);
          completeTodoItem(runtimeTodoList, "sql_correctness_audited", `flow_control: 上游声明不需要 SQL 审核；${sqlAuditEvidence}`);
        } else {
          applySqlAuditEvidence(runtimeTodoList, sqlAuditEvidence);
        }
      }
      completeSkippedAuditItems(runtimeTodoList, flowControl.next.skipAuditItems);
      if (recoveryAuditReason) {
        completeRecoveryAuditItems(runtimeTodoList, {
          question: currentQuestion,
          answer: fullContent,
          repoHints,
          toolResultCount: toolContextRecords.length,
          reason: recoveryAuditReason,
        });
      }
      completeAnswerSupportedAuditItems(runtimeTodoList, {
        question: currentQuestion,
        answer: fullContent,
        repoHints,
        toolResultCount: toolContextRecords.length,
        sqlAuditEvidence,
        skipAuditItems: flowControl.next.skipAuditItems,
        ...(plannerResult?.intent ? { plannerIntent: plannerResult.intent } : {}),
        ...(plannerResult?.secondary_intents ? { secondaryIntents: plannerResult.secondary_intents } : {}),
      });
      const incompleteAuditItems = getIncompleteAuditTodoItems(runtimeTodoList);
      const auditPassed = incompleteAuditItems.length === 0;
      if (!auditPassed && !skipVerification) {
        const auditFailureMessage = buildIncompleteAuditTodoMessage(incompleteAuditItems);
        console.error(`[${botConfig.name}] Runtime TodoList audit incomplete for ${body.msgid}: ${summarizeTodoList(runtimeTodoList)}\n${auditFailureMessage}`);
        // 已有实质回答时保留正文并附一句缺口提示，不用审核兜底模板替换掉真实答案
        if (fullContent.trim().length >= 200) {
          const blockedItemCount = incompleteAuditItems.filter(item => item.status === "blocked").length;
          fullContent = `${fullContent}\n\n（提示：${blockedItemCount > 0 ? "部分结论因查询预算受限未完全核实" : "部分审核项未完成"}，如需要可继续追问核实。）`;
          console.log(`[${botConfig.name}] Audit incomplete but kept substantive answer for ${body.msgid}: contentLength=${fullContent.length}`);
        } else {
          const auditFallbackModel = await getBaseModel();
          fullContent = await generateUserFacingAuditFallbackMessage({
            question: currentQuestion,
            items: incompleteAuditItems,
            model: auditFallbackModel,
          });
        }
      } else if (!auditPassed) {
        console.log(`[${botConfig.name}] Skipped audit fallback for ${body.msgid}: difficulty=${questionDifficulty}, incompleteItems=${incompleteAuditItems.length}`);
      }

      startTodoItem(runtimeTodoList, "final_checked");
      const initialCandidate = fullContent;
      const initialToolRecords = [...toolContextRecords];
      const finalReviewModel = await getBaseModel();
      let initialRoundPending = true;
      let latestCandidate = initialCandidate;
      let autoVerificationResult: Awaited<ReturnType<typeof runAutoVerificationLoop>>;
      const verificationStartedAt = Date.now();

      if (skipVerification && !shouldStopCurrentTask()) {
        // 简单/中等难度问题跳过自动验证与最终评审闸门，直接发送
        const skipResolution: FinalReplyResolutionResult = {
          ready: true,
          action: "send",
          answer: initialCandidate,
          reason: `skipped verification for ${questionDifficulty} question`,
          source: "candidate",
          review: {
            ready: true,
            action: "send",
            reason: `skipped verification for ${questionDifficulty} question`,
          },
        };
        autoVerificationResult = {
          content: initialCandidate,
          finalResolution: skipResolution,
          exitReason: "passthrough",
          rounds: 0,
          toolRecords: initialToolRecords,
          evidenceGaps: [],
        };
        console.log(`[${botConfig.name}] Skipped auto verification for ${body.msgid}: difficulty=${questionDifficulty}`);
      } else {

      try {
        if (shouldStopCurrentTask()) {
          throw new Error(STREAM_EXPIRED_MESSAGE);
        }
        autoVerificationResult = await runAutoVerificationLoop({
          startedAt: streamStartedAt,
          now: Date.now,
          async runRound(context: AutoVerificationRoundContext) {
            if (shouldStopCurrentTask()) {
              throw new Error(STREAM_EXPIRED_MESSAGE);
            }
            if (initialRoundPending) {
              initialRoundPending = false;
              return {
                content: initialCandidate,
                evidenceGaps: [],
                toolRecords: initialToolRecords,
              };
            }

            const continuationPrompt = buildAutoVerificationContinuationPrompt({
              question: currentQuestion,
              candidate: latestCandidate,
              evidenceGaps: context.evidenceGaps,
              usedToolCalls: context.usedToolCalls,
              accumulatedEvidenceSummary: buildToolContextSummary([...context.accumulatedToolRecords]),
              correction: context.correction,
            });
            await sendStageProgress(
              context.correction
                ? "上一轮未产生新证据，正在调整工具参数后执行一次纠偏查询。"
                : "最终评审仍缺少直接证据，正在继续调用工具核实。",
              true,
            );
            const roundResult = await runAgentRoundWithTiming(continuationPrompt, true, context.signal);
            latestCandidate = roundResult.content;
            return {
              ...roundResult,
              evidenceGaps: [...context.evidenceGaps],
            };
          },
          canContinue: () => !toolProgressLimitReached,
          async reviewFinal({ content, signal }) {
            if (signal.aborted || shouldStopCurrentTask()) {
              throw new Error(STREAM_EXPIRED_MESSAGE);
            }
            return resolveFinalReplyWithModel({
              question: currentQuestion,
              answer: content,
              streamSnapshots: visibleStreamSnapshots,
              model: finalReviewModel,
              memoryGraph: memoryGraphBeforeCurrentTurn,
            });
          },
        });
      } catch (autoVerificationError: any) {
        let errorContent: string;
        let errorReason: string;

        if (autoVerificationError?.lc_error_code === "AGENT_TOOL_ERROR_LIMIT") {
          errorReason = autoVerificationError.message || "工具查询多次失败";
          errorContent = buildAgentToolErrorLimitReply(errorReason);
        } else if (
          autoVerificationError?.lc_error_code === "AGENT_TOOL_PROGRESS_LIMIT"
          || autoVerificationError?.lc_error_code === "GRAPH_RECURSION_LIMIT"
          || autoVerificationError?.message?.includes("Recursion limit")
        ) {
          errorReason = autoVerificationError.message || "工具调用达到进展保护上限";
          try {
            const businessPrompt = await getBusinessPrompt(plannerResult);
            const recoveryResponse = await finalReviewModel.invoke([
              new SystemMessage(buildProgressLimitRecoverySystemPrompt(businessPrompt)),
              ...buildMessagesForCurrentTurn({
                sessionMessages: session.messages,
                userContent: finalContentForPrompt,
                repoHint: repoHints,
              }),
              ...(buildToolContextSummary(toolContextRecords)
                ? [new SystemMessage(buildToolContextSummary(toolContextRecords))]
                : intermediateMessages),
            ]);
            errorContent = ensureRecoverySqlAuditMarker(stringifyModelContent(recoveryResponse.content));
          } catch (recoveryError) {
            errorContent = `${buildUserFacingErrorReply(autoVerificationError)}

${buildUserFacingErrorReply(recoveryError, "恢复处理时发生异常")}`;
          }
        } else {
          errorReason = autoVerificationError instanceof Error
            ? autoVerificationError.message
            : String(autoVerificationError);
          errorContent = buildUserFacingErrorReply(autoVerificationError);
        }

        const errorResolution: FinalReplyResolutionResult = {
          ready: false,
          action: "continue",
          answer: errorContent,
          reason: errorReason,
          source: "error",
          review: {
            ready: false,
            action: "continue",
            reason: errorReason,
          },
        };
        autoVerificationResult = {
          content: errorContent,
          finalResolution: errorResolution,
          exitReason: "passthrough",
          rounds: 0,
          toolRecords: [...toolContextRecords],
          evidenceGaps: [errorReason],
        };
      }
      }
      logPhaseDuration(`auto_verification(rounds=${autoVerificationResult.rounds}, exit=${autoVerificationResult.exitReason})`, verificationStartedAt);

      fullContent = autoVerificationResult.content;
      const finalResolution = autoVerificationResult.finalResolution;
      const isResumeTurn = (activePendingHumanLoop?.resumeCount ?? 0) > 0;
      const repeatedClarificationOutput = hasRepeatedInputOutput(
        memoryGraphBeforeCurrentTurn,
        currentQuestion,
        fullContent,
      );
      const clarificationRequest = shouldSendFinalReply(finalResolution) || isResumeTurn || !repeatedClarificationOutput
        ? null
        : detectClarificationContent(fullContent, currentQuestion);
      let humanLoopReply: string | null = null;
      if (clarificationRequest) {
        console.log(`[${botConfig.name}] Clarification content detected without human_loop protocol, converting to Human Loop for ${body.msgid}`);
        const storedClarification = toStoredHumanLoopRequest(clarificationRequest, body.msgid);
        sessionManager.setPendingHumanLoop(sessionKey, storedClarification);
        humanLoopReply = buildHumanLoopReply(storedClarification);
      }
      const finalDeliveryInput: FinalReplyDeliveryInput = {
        content: fullContent,
        finalResolution,
        humanLoopReply,
        userQuestion: currentQuestion,
      };
      const finalDelivery: FinalReplyDeliveryResult = autoVerificationResult.exitReason === "no-progress"
        ? {
          content: AUTO_VERIFICATION_NO_PROGRESS_REPLY,
          shouldSendFinal: true,
          reason: "auto verification correction produced no new evidence",
          source: "no_progress",
        }
        : resolveFinalReplyDelivery(finalDeliveryInput);
      if (finalDelivery.source === "blocked" && finalResolution.action === "human_loop") {
        sessionManager.setPendingHumanLoop(
          sessionKey,
          toStoredHumanLoopRequest(buildBlockedFinalHumanLoopRequest(finalDeliveryInput), body.msgid),
        );
      }
      fullContent = finalDelivery.content;

      // 存原始回答，供模式切换时重新格式化
      if (fullContent && !shouldStopCurrentTask()) {
        sessionManager.setLastRawAnswer(sessionKey, fullContent);
      }

      // 默认业务回答模式：将技术回答转为业务语言；dev 模式跳过；错误回复保留原貌
      const currentReplyMode = sessionManager.getReplyMode(sessionKey);
      const isErrorReply = finalDelivery.source === "error";
      if (fullContent && currentReplyMode === "business" && !isErrorReply && !shouldStopCurrentTask()) {
        try {
          const rewriteStart = Date.now();
          const rewritten = await rewriteAnswerForBusiness(currentQuestion, fullContent);
          const rewriteDuration = formatElapsedDuration(rewriteStart);
          console.log(`[${botConfig.name}] Business answer rewrite completed for ${body.msgid}: duration=${rewriteDuration}, originalLength=${fullContent.length}, rewrittenLength=${rewritten.length}`);
          fullContent = rewritten;
        } catch (rewriteError) {
          console.error(`[${botConfig.name}] Business answer rewrite failed for ${body.msgid}, using original answer:`, rewriteError);
        }
      } else if (fullContent && (currentReplyMode === "dev" || isErrorReply)) {
        console.log(`[${botConfig.name}] Skipped business rewrite for ${body.msgid}: mode=${currentReplyMode}, isErrorReply=${isErrorReply}, contentLength=${fullContent.length}`);
      }

      if (fullContent && !shouldStopCurrentTask()) {
        const finalToolContextSummary = buildToolContextSummary(toolContextRecords);
        await sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: effectiveParsedContent as any }),
          ...(finalToolContextSummary ? [new SystemMessage(finalToolContextSummary)] : []),
          new AIMessage(fullContent),
        ]);
      }
      if (finalDelivery.shouldSendFinal) {
        completeTodoItem(runtimeTodoList, "final_checked", `finalLength=${fullContent.trim().length}; source=${finalDelivery.source}; review=${finalDelivery.reason}`);
      } else {
        console.error(`[${botConfig.name}] Final reply blocked for ${body.msgid}: ${summarizeTodoList(runtimeTodoList)}; ${finalDelivery.reason}`);
        completeTodoItem(runtimeTodoList, "final_checked", finalDelivery.reason);
      }
      if (auditPassed) {
        assertTodoListComplete(runtimeTodoList);
        console.log(`[${botConfig.name}] Runtime TodoList completed for ${body.msgid}: ${summarizeTodoList(runtimeTodoList)}`);
      }
      await stopThinkingHeartbeatAndDrain();
      if (!shouldStopCurrentTask() && fullContent) {
        console.log(`[${botConfig.name}] Final reply for ${body.msgid}: totalElapsed=${formatElapsedDuration(streamStartedAt)}`);
        await safeReplyStream(fullContent || "未获取到有效回复", true);
      }
      // 恢复轮完成后清理保存的计划，避免后续普通轮次误复用
      if (isStreamPauseResume && sessionManager.getLastPlanSteps(sessionKey)) {
        sessionManager.clearLastPlanSteps(sessionKey);
      }
      if (activeTasks.get(sessionKey) === currentTask) {
        activeTasks.delete(sessionKey);
      }
    } catch (error) {
      stopThinkingHeartbeat();
      console.error(`Outer error processing message ${body.msgid}:`, error);
      const activeTaskAfterError = activeTasks.get(sessionKey);
      if (activeTaskAfterError?.msgid === body.msgid) {
        activeTasks.delete(sessionKey);
      }
    }
  });

  bot.on("connected", () => console.log(`[${botConfig.name}] WeCom WebSocket connected.`));
  bot.on("authenticated", () => {
    if (reconnectState.reconnectWatchdogTimer) {
      clearTimeout(reconnectState.reconnectWatchdogTimer);
      reconnectState.reconnectWatchdogTimer = null;
    }
    console.log(`[${botConfig.name}] WeCom Authentication successful.`);
  });
  bot.on("error", (err) => {
    console.error(`[${botConfig.name}] WeCom WebSocket error:`, err);
    if (isWsReconnectExhaustedError(err)) {
      scheduleReconnectAfterReconnectExhausted(bot, botConfig.name, reconnectState);
    }
  });

  bot.connect();
  const contextWindow = getModelContextWindow();
  console.log(`[${botConfig.name}] WeCom Bot starting... Model: ${config.llm.modelName}, Recursion Limit: ${config.llm.recursionLimit}, Context Window: ${contextWindow} tokens`);
}

export async function startBots() {
  await Promise.all(config.bots.map(botConfig => startBot(botConfig)));
}
