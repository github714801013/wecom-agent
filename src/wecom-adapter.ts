import { WSClient, MessageType, generateReqId } from "@wecom/aibot-node-sdk";
import { initializePiAgent as initializePrimaryPiAgent, runPlanner, getModelContextWindow, extractExplicitRepoHints, buildMessagesForCurrentTurn, scopeToolsToRepo } from "./graph.js";
import { config, type BotConfig } from "./config.js";
import { HumanMessage, AIMessage, BaseMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { sessionManager, type ReplyMode } from "./session-manager.js";
import { fetchImageAsBase64, downloadMediaFile } from "./media-helper.js";
import { analyzeImageForQuestion, type VisionImageAnalyzer } from "./vision-analyzer.js";
import { buildMcpHeaders, filterToolsForKnownProjectScope, getAllMcpTools } from "./mcp-client.js";
import {
  buildHumanLoopReply,
  buildHumanLoopResumeContent,
  detectHumanLoopRequest,
  isAmbiguousNewTopicWhilePending,
  isHumanLoopExpired,
  toStoredHumanLoopRequest,
  type HumanLoopRequest,
} from "./human-loop.js";
import { rewriteAnswerForBusiness } from "./business-answer-rewrite.js";
import { buildIntermediateStreamContent, buildProgressStreamContent, buildThinkingHeartbeatContent, collapseProgressUpdates, formatElapsedDuration, getProcessingFrame, PROGRESS_KEYWORDS, stripProtocolNoise } from "./progress-updates.js";
import {
  consumeFlowControlDelta,
  createDefaultFlowControl,
  createFlowControlStreamState,
  extractFlowControl,
  type FlowControlPatch,
  mergeFlowControl,
} from "./flow-control.js";
import { isStreamExpired, isWeComReplyAckTimeoutError, isWeComStreamExpiredError, STREAM_EXPIRED_MESSAGE, STREAM_SAFE_TTL_MS } from "./stream-ttl.js";
import {
  type AutoVerificationRoundResult,
} from "./auto-verification-loop.js";
import { buildToolContextSummary, type ToolContextRecord } from "./tool-context-filter.js";
import { buildToolResultFileReadTool } from "./tool-result-store.js";
import { buildOriginalQuestionTool } from "./original-question-tool.js";
import { stringifyModelContent } from "./model-content.js";
import { buildUserFacingErrorReply, getErrorMessage } from "./error-response.js";
import { buildRequestRawTrace, isRequestRawLoggingEnabled, redactSensitiveValues } from "./request-raw-trace.js";
import { filterPiAgentTools, type PiAgentEvent } from "./pi-agent-runtime.js";
import { resetPiCodingAgentSession } from "./pi-coding-agent-runtime.js";
import {
  createRequestTimingRecord,
  formatRequestTimingLog,
  monotonicNowMs,
  shouldSampleRequest,
  type RequestTerminalStatus,
} from "./request-timing.js";
import {
  createAgentSlotScheduler,
  AgentSlotCancelledError,
  type AgentSlotLease,
} from "./agent-slot-scheduler.js";
import {
  createReplyScheduler,
  type ReplyScheduler,
} from "./reply-scheduler.js";
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
  buildDirectEvidenceRuntimeInstruction,
  buildEntryAnchorGraphInstruction,
  hasDirectEvidenceAnchors,
} from "./direct-evidence.js";
import {
  buildLatestMessageContext,
  detectActiveMessageIntent,
} from "./interaction-control.js";
import {
  buildSensitiveRequestAuditEvent,
  buildSensitiveRequestBlockedReply,
  extractSensitiveRequestPreflightText,
  judgeSensitiveRequestByModel,
} from "./sensitive-request-guard.js";
import type { FinalReplyResolutionResult } from "./runtime-todolist.js";
interface ActiveTaskHandoff {
  question: string;
  partialAnswer: string;
  toolContextSummary: string;
  repoHints: string[];
  updatedAt: number;
}

interface ActiveTaskState {
  msgid: string;
  cancelled: boolean;
  streamExpired?: boolean;
  streamExpiryMessageSent?: boolean;
  abortController?: AbortController;
  cancel?: () => void;
  terminalState?: "open" | "cancelled" | "expired" | "final_sent";
  question: string;
  handoff?: ActiveTaskHandoff;
}

interface VisiblePlanStep {
  id: string;
  task: string;
  status: string;
}

function renderVisiblePlanSteps(steps: readonly VisiblePlanStep[], heartbeatFrame: string) {
  if (steps.length === 0) return "";
  const lines = steps.map(step => {
    const marker = step.status === "done"
      ? "✓"
      : step.status === "in_progress" && heartbeatFrame
        ? heartbeatFrame
        : "○";
    return `${marker} ${step.task}`;
  });
  return `【处理进度】\n${lines.join("\n")}`;
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

function extractAssistantText(message: unknown) {
  if (!message || typeof message !== "object") return "";
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant") return "";
  return stringifyModelContent(record.content);
}

export function extractPiAgentEndContent(event: PiAgentEvent) {
  if (event.type !== "agent_end") return "";
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || typeof lastMessage !== "object") return "";
  const record = lastMessage as { role?: unknown; stopReason?: unknown };
  if (record.role !== "assistant" || record.stopReason !== "stop") return "";
  return extractAssistantText(lastMessage);
}

export interface PiAgentEndFailure {
  reason: "error" | "aborted";
  rawStopReason?: string;
  errorMessage?: string;
}

export function extractPiAgentEndFailure(event: PiAgentEvent): PiAgentEndFailure | null {
  if (event.type !== "agent_end") return null;
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || typeof lastMessage !== "object") return null;
  const record = lastMessage as { role?: unknown; stopReason?: unknown; rawStopReason?: unknown; errorMessage?: unknown };
  if (record.role !== "assistant" || (record.stopReason !== "error" && record.stopReason !== "aborted")) return null;
  const rawStopReason = typeof record.rawStopReason === "string" ? normalizeLifecycleDetail(record.rawStopReason, 80) : "";
  const errorMessage = typeof record.errorMessage === "string" ? normalizeLifecycleDetail(record.errorMessage, 500) : "";
  return {
    reason: record.stopReason,
    ...(rawStopReason ? { rawStopReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function normalizeLifecycleDetail(value: string, maxLength: number) {
  return redactSensitiveValues(value).replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

export function buildPrimaryPiAgentTools(
  scopedEvidenceTools: any[],
  originalQuestionTool: any,
  sessionMemoryTool: any,
  resultFileReadTool: any,
) {
  return filterPiAgentTools([scopedEvidenceTools, originalQuestionTool, sessionMemoryTool, resultFileReadTool].flat());
}

function eventToLegacyMessage(event: PiAgentEvent): BaseMessage | null {
  if (event.type === "agent_end") {
    const content = extractPiAgentEndContent(event);
    return content ? new AIMessage(content) : null;
  }
  if (event.type === "tool_execution_update") {
    return new AIMessage(`正在执行工具 ${event.toolName}...`);
  }
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return new AIMessage(event.assistantMessageEvent.delta);
  }
  if (event.type === "tool_execution_start") {
    return new AIMessage({
      content: "",
      tool_calls: [{ id: event.toolCallId, name: event.toolName, args: event.args }],
    });
  }
  if (event.type === "tool_execution_end") {
    return new ToolMessage({
      content: stringifyModelContent(event.result?.content || event.result),
      tool_call_id: event.toolCallId,
      name: event.toolName,
      status: event.isError ? "error" : "success",
    });
  }
  return null;
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
 * 格式化工具调用显示，不回显工具参数。
 */
function getToolArgumentLength(args: unknown) {
  if (typeof args === "string") return args.length;
  try {
    const serialized = JSON.stringify(args);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 0;
  }
}

function getToolDisplay(name: string, _args: unknown): string {
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
  source: "reviewed" | "candidate" | "human_loop" | "blocked" | "error" | "no_progress";
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
  if (input.finalResolution.ready && input.finalResolution.action === "send") {
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

function withRequestAbort<T>(operation: () => Promise<T>, signal: AbortSignal, message = "请求已取消"): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(message));
  const operationPromise = Promise.resolve().then(() => {
    if (signal.aborted) throw new Error(message);
    return operation();
  });
  void operationPromise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(message));
    signal.addEventListener("abort", abort, { once: true });
    operationPromise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export interface BotRuntimeDependencies {
  judgeSensitiveRequestByModel?: typeof judgeSensitiveRequestByModel;
  getAllMcpTools?: typeof getAllMcpTools;
  initializeAgent?: typeof initializePrimaryPiAgent;
  requestTimeoutMs?: number;
}

export async function startBot(botConfig: BotConfig, client?: WSClient, dependencies: BotRuntimeDependencies = {}) {
  const bot = client ?? new WSClient({
    botId: botConfig.botId,
    secret: botConfig.secret,
    wsUrl: botConfig.wsUrl,
  });
  const judgeSensitiveRequest = dependencies.judgeSensitiveRequestByModel || judgeSensitiveRequestByModel;
  const loadMcpTools = dependencies.getAllMcpTools || getAllMcpTools;
  const initializePiAgent = dependencies.initializeAgent || initializePrimaryPiAgent;
  const requestDeadlineMs = dependencies.requestTimeoutMs ?? config.llm.requestTimeoutMs;
  const reconnectState: BotReconnectState = { reconnectExhaustedTimer: null, reconnectWatchdogTimer: null };
  const replyScheduler: ReplyScheduler = createReplyScheduler();
  const expiryReplyScheduler: ReplyScheduler = createReplyScheduler();
  const agentSlotScheduler = createAgentSlotScheduler(config.llm.maxConcurrentRequests);
  const failedFinalReplies = new Set<string>();
  const replyErrorHandlers = new Map<string, (error: unknown) => void>();
  const replyOwnerChecks = new Map<string, () => boolean>();
  const sendCard = (
    frame: any,
    streamId: string,
    content: string,
    final = false,
    options?: any,
    shouldRun?: () => boolean,
  ) => {
    const ownerCheck = shouldRun || replyOwnerChecks.get(streamId);
    const send = () => options === undefined
      ? bot.replyStreamWithCard(frame, streamId, content, final)
      : bot.replyStreamWithCard(frame, streamId, content, final, options);
    const replyPromise = ownerCheck
      ? replyScheduler.scheduleIf(ownerCheck, send, final ? "final" : "progress")
      : replyScheduler.schedule(send, final ? "final" : "progress");
    return replyPromise.catch(error => {
      replyErrorHandlers.get(streamId)?.(error);
      if (final) failedFinalReplies.add(streamId);
      console.error(`[${botConfig.name}] Card reply failed for ${streamId}:`, error);
      return undefined;
    });
  };

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

    const requestStartedAt = monotonicNowMs();
    let requestExecutionError = false;
    let requestTimingFinished = false;
    let requestStreamId = body.msgid;
    let requestTurnCount = 0;
    let requestModelCallCount = 0;
    let requestToolNames: string[] = [];
    let requestRawInput = "";
    let requestRawError = "";
    const requestToolRecords: ToolContextRecord[] = [];
    const recordRequestRawError = (error: unknown) => {
      if (!isRequestRawLoggingEnabled() || requestRawError) return;
      requestRawError = getErrorMessage(error);
    };
    let preStreamExpired = false;
    let preStreamExpiryTimer: NodeJS.Timeout | undefined;
    let preStreamExpiryDeliveryPromise: Promise<void> | undefined;
    let deliverPreStreamExpiry: (() => Promise<void>) | undefined;
    const schedulePreStreamExpiryDelivery = () => {
      if (!deliverPreStreamExpiry) return Promise.resolve();
      if (!preStreamExpiryDeliveryPromise) {
        preStreamExpiryDeliveryPromise = deliverPreStreamExpiry().catch(error => {
          console.error(`[${botConfig.name}] Failed to deliver pre-stream expiry for ${body.msgid}:`, error);
        });
      }
      return preStreamExpiryDeliveryPromise;
    };
    let admissionTask: ActiveTaskState | undefined;
    let replacedTask: ActiveTaskState | undefined;
    let requestTaskOwner: ActiveTaskState | undefined;
    const ownsRequestTask = () => Boolean(
      requestTaskOwner && activeTasks.get(sessionKey) === requestTaskOwner,
    );
    const requestTiming: {
      sensitivePrecheckMs: number | null;
      mediaProcessingMs: number | null;
      mcpLoadMs: number | null;
      piModelRoundMs: number | null;
      toolCallMs: number | null;
      replyQueueMs: number | null;
      finalSendMs: number | null;
      agentQueueMs: number | null;
      activeAgentRequests: number;
      queuedAgentRequests: number;
      replyActive: number;
      replyQueued: number;
      modelCalls: number;
    } = {
      sensitivePrecheckMs: null,
      mediaProcessingMs: null,
      mcpLoadMs: null,
      piModelRoundMs: null,
      toolCallMs: null,
      replyQueueMs: null,
      finalSendMs: null,
      agentQueueMs: null,
      activeAgentRequests: 0,
      queuedAgentRequests: 0,
      replyActive: 0,
      replyQueued: 0,
      modelCalls: 0,
    };
    const finishRequestTiming = (terminalStatus: RequestTerminalStatus, errorCategory: string | null = null) => {
      if (requestTimingFinished) return;
      requestTimingFinished = true;
      if (preStreamExpiryTimer) clearTimeout(preStreamExpiryTimer);
      const finalDeliveryFailed = failedFinalReplies.delete(requestStreamId);
      const bodyFinalDeliveryFailed = requestStreamId === body.msgid
        ? false
        : failedFinalReplies.delete(body.msgid);
      const hadFinalDeliveryFailure = finalDeliveryFailed || bodyFinalDeliveryFailed;
      const requestReplaced = Boolean(
        admissionTask && !ownsRequestTask(),
      );
      replyErrorHandlers.delete(requestStreamId);
      replyErrorHandlers.delete(body.msgid);
      replyOwnerChecks.delete(requestStreamId);
      replyOwnerChecks.delete(body.msgid);
      if (requestTaskOwner && activeTasks.get(sessionKey) === requestTaskOwner) {
        activeTasks.delete(sessionKey);
      }
      const effectiveTerminalStatus = requestReplaced
        ? "cancelled"
        : requestReplyAckFailed
          ? "cancelled"
          : hadFinalDeliveryFailure && terminalStatus === "completed" ? "error" : terminalStatus;
      const effectiveErrorCategory = requestReplaced
        ? "task_replaced"
        : requestReplyAckFailed
          ? "reply_ack_timeout"
          : hadFinalDeliveryFailure && !errorCategory ? "final_card_delivery_failed" : errorCategory;
      const record = createRequestTimingRecord({
        requestId: generateReqId("request"),
        botName: botConfig.name,
        modelName: config.llm.modelName,
        toolNames: requestToolNames,
        totalMs: Math.max(0, monotonicNowMs() - requestStartedAt),
        turns: requestTurnCount,
        terminalStatus: effectiveTerminalStatus,
        errorCategory: effectiveErrorCategory,
        ...requestTiming,
        rawTrace: buildRequestRawTrace({
          userInput: requestRawInput,
          ...(requestRawError ? { error: requestRawError } : {}),
          toolRecords: requestToolRecords,
        }, isRequestRawLoggingEnabled()),
        activeAgentRequests: agentSlotScheduler.activeCount,
        queuedAgentRequests: agentSlotScheduler.queuedCount,
        replyActive: replyScheduler.activeCount,
        replyQueued: replyScheduler.queuedCount,
        modelCalls: requestModelCallCount,
      });
      if (isRequestRawLoggingEnabled() || shouldSampleRequest(record)) {
        try {
          console.log(formatRequestTimingLog(record));
        } catch {
          // 指标记录失败不得影响业务请求。
        }
      }
    };

    const requestAbortController = new AbortController();
    let requestReplyAckFailed = false;
    const handleRequestReplyError = (error: unknown) => {
      recordRequestRawError(error);
      if (!isWeComReplyAckTimeoutError(error)) return;
      requestReplyAckFailed = true;
      requestAbortController.abort();
      console.warn(`[${botConfig.name}] Reply ack timeout for ${body.msgid}; cancelling only this request.`);
    };
    replyErrorHandlers.set(body.msgid, handleRequestReplyError);
    const incomingText = body.msgtype === MessageType.Text ? body.text?.content || "" : "";
    requestRawInput = incomingText;
    const incomingIntent = detectActiveMessageIntent(stripBoundaryMentions(incomingText));
    const controlTargetTask = incomingIntent === "stop" || incomingIntent === "continue_current"
      ? activeTasks.get(sessionKey)
      : undefined;
    admissionTask = incomingIntent === "stop" || incomingIntent === "continue_current"
      ? undefined
      : {
        msgid: body.msgid,
        cancelled: false,
        question: extractSensitiveRequestPreflightText(body).trim(),
        abortController: requestAbortController,
        terminalState: "open" as const,
        cancel: () => requestAbortController.abort(),
      };
    replacedTask = admissionTask ? activeTasks.get(sessionKey) : undefined;
    const requestOwnerCheck = () => ownsRequestTask()
      && !requestAbortController.signal.aborted
      && !preStreamExpired
      && !requestTimingFinished;
    if (admissionTask) {
      requestTaskOwner = admissionTask;
      replacedTask?.cancel?.();
      activeTasks.set(sessionKey, admissionTask);
      replyOwnerChecks.set(body.msgid, requestOwnerCheck);
    }
    if (incomingIntent === "stop") {
      const targetStillActive = controlTargetTask && activeTasks.get(sessionKey) === controlTargetTask;
      if (targetStillActive) controlTargetTask.cancel?.();
      await sendCard(frame, body.msgid, targetStillActive ? "已停止当前任务。" : "当前没有正在执行的任务。", true);
      finishRequestTiming("cancelled", targetStillActive ? "task_stopped" : "no_active_task");
      return;
    }
    const streamId = generateReqId("stream");
    requestStreamId = streamId;
    replyErrorHandlers.set(streamId, handleRequestReplyError);
    if (admissionTask) replyOwnerChecks.set(streamId, requestOwnerCheck);
    const streamStartedAt = Date.now();
    let earlyProgressTimer: NodeJS.Timeout | undefined;
    const preStreamExpiryDelay = Math.max(0, STREAM_SAFE_TTL_MS - (Date.now() - streamStartedAt));
    preStreamExpiryTimer = setTimeout(() => {
      preStreamExpired = true;
      const task = requestTaskOwner;
      if (task && activeTasks.get(sessionKey) === task) {
        task.streamExpired = true;
        task.terminalState = "expired";
        task.cancelled = true;
      }
      requestAbortController.abort();
      void schedulePreStreamExpiryDelivery();
      if (earlyProgressTimer) clearInterval(earlyProgressTimer);
    }, preStreamExpiryDelay);
    const startEarlyProgress = shouldStartEarlyProgressBeforeParse(body);
    let earlyProgressQueue = Promise.resolve();
    const sendEarlyProgress = (content: string) => {
      if (preStreamExpired || requestAbortController.signal.aborted) return Promise.resolve();
      const task = earlyProgressQueue.then(
        () => replyScheduler.scheduleLatest(
          streamId,
          () => bot.replyStreamNonBlocking(frame, streamId, content, false),
          () => requestOwnerCheck(),
        ),
        () => replyScheduler.scheduleLatest(
          streamId,
          () => bot.replyStreamNonBlocking(frame, streamId, content, false),
          () => requestOwnerCheck(),
        ),
      ).catch(error => {
        handleRequestReplyError(error);
        console.error(`[${botConfig.name}] Early progress update failed for ${body.msgid}:`, error);
      });
      earlyProgressQueue = task.then(() => undefined, () => undefined);
      return task;
    };
    const sensitiveStartedAt = monotonicNowMs();
    const sensitiveRequestText = extractSensitiveRequestPreflightText(body);
    requestRawInput = sensitiveRequestText;
    const saveFailedRequestQuestion = async (content: unknown) => {
      const question = stringifyModelContent(content).trim();
      if (!question) return;
      try {
        await sessionManager.addMessages(sessionKey, [new HumanMessage({ content: question })]);
      } catch (saveError) {
        console.error(`[${botConfig.name}] Failed to persist request question for ${body.msgid}:`, saveError);
      }
    };
    const savePreStreamExpiry = async () => {
      if ((!preStreamExpired && requestAbortController.signal.aborted) || !ownsRequestTask()) return false;
      const question = sensitiveRequestText.trim();
      if (!question) return false;
      const pauseRequest = toStoredHumanLoopRequest(
        buildStreamPauseResumeRequest({
          userQuestion: question,
          currentQuestion: question,
          partialAnswer: "",
          toolContextSummary: "",
          repoHints: [],
        }),
        body.msgid,
      );
      const historyPromise = sessionManager.addMessages(sessionKey, [
        new HumanMessage({ content: question }),
        new AIMessage(STREAM_EXPIRED_MESSAGE),
      ]);
      if ((!preStreamExpired && requestAbortController.signal.aborted) || !ownsRequestTask()) return false;
      sessionManager.setPendingHumanLoop(sessionKey, pauseRequest);
      await historyPromise;
      return true;
    };
    deliverPreStreamExpiry = async () => {
      const saved = await savePreStreamExpiry().catch(error => {
        console.error(`[${botConfig.name}] Failed to save pre-stream expiry context for ${body.msgid}:`, error);
        return false;
      });
      if (!saved || !ownsRequestTask()) {
        finishRequestTiming("cancelled", "task_replaced");
        return;
      }
      try {
        const sent = await expiryReplyScheduler.scheduleIf(
          () => ownsRequestTask() && !requestReplyAckFailed,
          () => bot.replyStreamWithCard(frame, streamId, STREAM_EXPIRED_MESSAGE, true),
          "final",
        );
        finishRequestTiming(
          sent === undefined ? "cancelled" : "ttl_expired",
          sent === undefined ? "task_replaced" : "stream_expired_before_agent",
        );
      } catch (error) {
        if (isWeComReplyAckTimeoutError(error)) {
          handleRequestReplyError(error);
        } else {
          failedFinalReplies.add(streamId);
          console.error(`[${botConfig.name}] Failed to send pre-stream expiry for ${body.msgid}:`, error);
        }
        finishRequestTiming("ttl_expired", "stream_expired_before_agent");
      }
    };
    if (preStreamExpired) void schedulePreStreamExpiryDelivery();
    let sensitiveRequestDecision: Awaited<ReturnType<typeof judgeSensitiveRequestByModel>>;
    try {
      sensitiveRequestDecision = await withRequestAbort(
        () => judgeSensitiveRequest(sensitiveRequestText),
        requestAbortController.signal,
        "敏感请求预检已取消",
      );
      requestTiming.sensitivePrecheckMs = Math.max(0, monotonicNowMs() - sensitiveStartedAt);
    } catch (error) {
      recordRequestRawError(error);
      requestTiming.sensitivePrecheckMs = Math.max(0, monotonicNowMs() - sensitiveStartedAt);
      if (preStreamExpired && !requestReplyAckFailed) {
        await schedulePreStreamExpiryDelivery();
        return;
      }
      if (requestAbortController.signal.aborted || (admissionTask && activeTasks.get(sessionKey) !== admissionTask)) {
        finishRequestTiming("cancelled", requestReplyAckFailed ? "reply_ack_timeout" : "task_cancelled");
        return;
      }
      try {
        await sendCard(frame, body.msgid, "本次请求暂时无法处理，请稍后重试。", true);
      } catch (replyError) {
        console.error(`[${botConfig.name}] Failed to send sensitive precheck error reply for ${body.msgid}:`, replyError);
      }
      finishRequestTiming("error", "sensitive_precheck_error");
      return;
    }
    if (requestAbortController.signal.aborted || (admissionTask && activeTasks.get(sessionKey) !== admissionTask)) {
      finishRequestTiming("cancelled", requestReplyAckFailed ? "reply_ack_timeout" : "task_cancelled");
      return;
    }
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
      await sendCard(
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
      finishRequestTiming("completed", "sensitive_request_blocked");
      return;
    }

    if (startEarlyProgress) {
      try {
        await withRequestAbort(
          () => sendCard(frame, streamId, withMcpEnvironmentNotice(buildThinkingHeartbeatContent("", [], Date.now(), streamStartedAt)), false, {
            templateCard: {
              card_type: "text_notice",
              main_title: { title: "任务处理中", desc: "正在理解你的消息..." },
              task_id: `task_${body.msgid}`,
            },
          }),
          requestAbortController.signal,
          "早期回复已取消",
        );
      } catch (error) {
        if (preStreamExpired && !requestReplyAckFailed) {
          await schedulePreStreamExpiryDelivery();
        } else if (requestAbortController.signal.aborted || !ownsRequestTask()) {
          finishRequestTiming("cancelled", requestReplyAckFailed ? "reply_ack_timeout" : "task_replaced");
        } else {
          throw error;
        }
        return;
      }
      earlyProgressTimer = setInterval(() => {
        void sendEarlyProgress(withMcpEnvironmentNotice(buildThinkingHeartbeatContent("", [], Date.now(), streamStartedAt)));
      }, THINKING_HEARTBEAT_INTERVAL_MS);
    }

    let parsedContent: Awaited<ReturnType<typeof parseWeComMessage>>;
    const mediaStartedAt = monotonicNowMs();
    let stopThinkingHeartbeat = () => {};
    try {
      parsedContent = await withRequestAbort(
        () => parseWeComMessage(body, bot),
        requestAbortController.signal,
        "消息解析已取消",
      );
      if (typeof parsedContent === "string") requestRawInput = parsedContent;
      requestTiming.mediaProcessingMs = Math.max(0, monotonicNowMs() - mediaStartedAt);
    } catch (error) {
      recordRequestRawError(error);
      if (preStreamExpired) {
        await schedulePreStreamExpiryDelivery();
        return;
      }
      if (requestAbortController.signal.aborted || (admissionTask && activeTasks.get(sessionKey) !== admissionTask)) {
        finishRequestTiming("cancelled", requestReplyAckFailed ? "reply_ack_timeout" : "task_replaced");
        return;
      }
      await sendCard(frame, streamId, "本次消息暂时无法解析，请稍后重试。", true);
      finishRequestTiming("error", "message_parse_error");
      return;
    } finally {
      if (earlyProgressTimer) clearInterval(earlyProgressTimer);
      await earlyProgressQueue;
    }
    if (preStreamExpired) {
      await schedulePreStreamExpiryDelivery();
      return;
    }
    if (requestReplyAckFailed) {
      finishRequestTiming("cancelled", "reply_ack_timeout");
      return;
    }
    if (admissionTask && activeTasks.get(sessionKey) !== admissionTask) {
      finishRequestTiming("cancelled", "task_replaced");
      return;
    }

    // --- Session Handling Start ---

    // Handle high-priority system commands (Exact match only)
    const commandText = body.msgtype === MessageType.Text
      ? body.text?.content || ""
      : extractTextContent(parsedContent as any);
    const isHelp = isHelpCommand(commandText);
    const isHardcodedNew = isClearSessionCommand(commandText);
    const replyModeCommand = detectReplyModeCommand(commandText);
    const activeTask = controlTargetTask;
    const activeText = stripBoundaryMentions(commandText);
    const mcpHeaderCommand = parseMcpHeaderCommand(commandText, config.mcpServers);
    let followupQuestion = "";
    if (incomingIntent === "continue_current" && controlTargetTask && activeTasks.get(sessionKey) !== controlTargetTask) {
      await sendCard(frame, body.msgid, "当前任务已被新的请求替换，请稍后重试。", true);
      finishRequestTiming("cancelled", "task_replaced");
      return;
    }
    if (admissionTask && replacedTask?.question) {
      followupQuestion = replacedTask.question;
    }

    if (mcpHeaderCommand) {
      const projects = extractProjectsFromMcpHeaders(mcpHeaderCommand.headersByServer);
      resetPiCodingAgentSession(sessionKey);
      sessionManager.setMcpHeaderOverrides(sessionKey, mcpHeaderCommand.headersByServer);
      sessionManager.setActiveMcpHeaderCommand(sessionKey, mcpHeaderCommand.command);
      sessionManager.setRepoHints(sessionKey, projects);
      await sendCard(
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
      finishRequestTiming("completed", "mcp_header_switch");
      return;
    }

    if (activeTask && activeTasks.get(sessionKey) === activeTask && !activeTask.cancelled) {
      const activeIntent = detectActiveMessageIntent(activeText);
      if (activeIntent === "stop") {
        activeTask.cancel?.();
        await sendCard(
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
        finishRequestTiming("cancelled", "task_stopped");
        return;
      }

      if (activeIntent === "continue_current") {
        await sendCard(
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
        finishRequestTiming("completed", "continue_current");
        return;
      }

      followupQuestion = activeTask.question;
      activeTask.cancel?.();
    }

    if (isHelp) {
      await sendCard(
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
      finishRequestTiming("completed", "help_command");
      return;
    }

    if (isHardcodedNew) {
      resetPiCodingAgentSession(sessionKey);
      sessionManager.clearSession(sessionKey);
      processedMsgs.add(body.msgid);
      await sendCard(
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
      finishRequestTiming("completed", "session_reset");
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
          await sendCard(frame, body.msgid, `已切换到${modeLabel}。暂无可重新格式化的回答。`, true, {
            templateCard: { card_type: "text_notice", main_title: { title: "模式已切换", desc: modeLabel }, task_id: `task_${body.msgid}` },
          });
          finishRequestTiming("completed", "reply_mode_switch");
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

        await sendCard(frame, body.msgid, `已切换到${modeLabel}。\n\n${reformatted}`, true, {
          templateCard: { card_type: "text_notice", main_title: { title: "模式已切换", desc: modeLabel }, task_id: `task_${body.msgid}` },
        });
        finishRequestTiming("completed", "reply_mode_switch");
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
      await sendCard(
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
      finishRequestTiming("completed", "human_loop_confirmation_required");
      return;
    }

    if (activePendingHumanLoop) {
      effectiveParsedContent = buildHumanLoopResumeContent(activePendingHumanLoop, pendingText || extractTextContent(parsedContent as any));
      sessionManager.incrementPendingHumanLoopResume(sessionKey);
    } else if (followupQuestion) {
      effectiveParsedContent = currentTurnText || pendingText;
    } else if (session.messages.length > 0 && pendingText) {
      effectiveParsedContent = currentTurnText || pendingText;
    }
    // --- Session Handling End ---
    let cleanupStreamExpiry = async () => {};
    let cleanupActiveTask = () => {};
    let requestWasStreamExpired = false;

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
        const sent = await sendCard(frame, streamId, directReply, true, {
          templateCard: {
            card_type: "text_notice",
            main_title: {
              title: "当前可查询项目",
              desc: activeMcpHeaderCommand || botConfig.defaultMcpHeaderCommand || "当前环境",
            },
            task_id: `task_${body.msgid}`,
          },
        });
        if (sent !== undefined && ownsRequestTask()) {
          await sessionManager.addMessages(sessionKey, [
            new HumanMessage({ content: parsedContent as any }),
            new AIMessage(directReply),
          ]);
        }
        finishRequestTiming("completed", "queryable_projects");
        return;
      }

      const rawQuestion = typeof effectiveParsedContent === "string"
        ? stripBoundaryMentions(effectiveParsedContent)
        : extractTextContent(effectiveParsedContent as any);
      const currentQuestion = replyModeCommand.modeSwitch && replyModeCommand.strippedText
        ? replyModeCommand.strippedText
        : rawQuestion;
      const streamAbortController = requestAbortController;
      if (admissionTask && activeTasks.get(sessionKey) !== admissionTask) {
        finishRequestTiming("cancelled", "task_replaced");
        return;
      }
      const previousTask = activeTasks.get(sessionKey);
      if (previousTask && previousTask !== admissionTask) {
        previousTask.cancel?.();
      }
      const taskBase: ActiveTaskState = admissionTask
        ? { ...admissionTask, question: currentQuestion }
        : {
          msgid: body.msgid,
          cancelled: false,
          question: currentQuestion,
          abortController: streamAbortController,
          terminalState: "open",
        };
      let streamExpired = false;
      let streamExpiryPromise: Promise<void> | undefined;
      let streamExpiryTimer: NodeJS.Timeout | undefined;
      let taskRef: ActiveTaskState | undefined;
      const cancelCurrentTask = () => {
        const task = taskRef;
        if (!task) return;
        task.cancelled = true;
        if (task.terminalState !== "final_sent" && task.terminalState !== "expired") task.terminalState = "cancelled";
        if (streamExpiryTimer) clearTimeout(streamExpiryTimer);
        if (!streamAbortController.signal.aborted) streamAbortController.abort();
      };
      const currentTask: ActiveTaskState = { ...taskBase, cancel: cancelCurrentTask };
      taskRef = currentTask;
      requestTaskOwner = currentTask;
      activeTasks.set(sessionKey, currentTask);
      if (!admissionTask) replyOwnerChecks.set(streamId, requestOwnerCheck);
      const taskAbortListener = () => {
        const task = taskRef;
        if (!task) return;
        task.cancelled = true;
        if (task.terminalState === "open" && !preStreamExpired) task.terminalState = "cancelled";
        if (streamExpiryTimer) clearTimeout(streamExpiryTimer);
      };
      streamAbortController.signal.addEventListener("abort", taskAbortListener, { once: true });
      if (streamAbortController.signal.aborted) taskAbortListener();
      let agentSlotLease: AgentSlotLease | undefined;
      cleanupActiveTask = () => {
        agentSlotLease?.release();
        agentSlotLease = undefined;
        if (requestTaskOwner === currentTask) requestTaskOwner = undefined;
        if (activeTasks.get(sessionKey) === currentTask) {
          activeTasks.delete(sessionKey);
        }
      };
      if (preStreamExpired && !requestReplyAckFailed) {
        currentTask.streamExpired = true;
        currentTask.terminalState = "expired";
        currentTask.cancelled = true;
        await schedulePreStreamExpiryDelivery();
        return;
      }
      if (!startEarlyProgress) {
        // 发送初始进度卡片
        try {
          await withRequestAbort(
            () => sendCard(frame, streamId, withMcpEnvironmentNotice("正在处理你的问题，请稍候。"), false, {
              templateCard: {
                card_type: 'text_notice',
                main_title: { title: '任务处理中', desc: '正在理解你的问题...' },
                task_id: `task_${body.msgid}`,
              }
            }),
            requestAbortController.signal,
            "初始回复已取消",
          );
        } catch (error) {
          if (preStreamExpired && !requestReplyAckFailed) {
            await schedulePreStreamExpiryDelivery();
          } else if (requestAbortController.signal.aborted || !ownsRequestTask()) {
            finishRequestTiming("cancelled", requestReplyAckFailed ? "reply_ack_timeout" : "task_replaced");
          } else {
            throw error;
          }
          return;
        }
      }
      if (requestReplyAckFailed) {
        finishRequestTiming("cancelled", "reply_ack_timeout");
        return;
      }
      if (preStreamExpired) {
        await schedulePreStreamExpiryDelivery();
        return;
      }
      if (!ownsRequestTask()) {
        finishRequestTiming("cancelled", "task_replaced");
        return;
      }
      const ownsCurrentTask = () => activeTasks.get(sessionKey) === currentTask;
      const shouldStopCurrentTask = () => activeTasks.get(sessionKey) !== currentTask || currentTask.cancelled;

      let fullContent = "";
      let piAgentEnded = false;
      let piAgentEndFailure: PiAgentEndFailure | null = null;
      let piAgentWasAborted = false;
      // 时间上限降级用：累计模型已经流出的助手文本，避免超时后整轮成果丢失。
      let partialAssistantText = "";
      let flowControl = createDefaultFlowControl();
      let flowControlStreamState = createFlowControlStreamState();
      const toolContextRecords: ToolContextRecord[] = [];
      let repoHints: string[] = [];
      const updateActiveTaskHandoff = () => {
        if (!ownsCurrentTask()) return;
        currentTask.handoff = {
          question: currentQuestion,
          partialAnswer: collapseProgressUpdates(stripEmptyProtocolContent(partialAssistantText || fullContent)).slice(-8_000),
          toolContextSummary: buildToolContextSummary(toolContextRecords).slice(-12_000),
          repoHints: [...repoHints].slice(0, 20),
          updatedAt: Date.now(),
        };
      };
      const applyFlowControlPatch = (patch: FlowControlPatch) => {
        flowControl = mergeFlowControl(flowControl, patch);
      };
      const toolCallMap = new Map<string, { name: string; args: string; notified: boolean; completed: boolean; startedAt: number }>();
      let autoVerificationAgent: any = null;
      let autoVerificationScopedEvidenceTools: any[] = [];
      const handoff = replacedTask?.handoff ?? (followupQuestion ? {
        question: followupQuestion,
        partialAnswer: "",
        toolContextSummary: "",
        repoHints: [] as string[],
        updatedAt: Date.now(),
      } : undefined);
      let finalContentForPrompt: any = buildLatestMessageContext(
        stringifyModelContent(effectiveParsedContent),
        handoff ? {
          previousQuestion: handoff.question,
          partialAnswer: handoff.partialAnswer,
          toolContextSummary: handoff.toolContextSummary,
          repoHints: handoff.repoHints,
        } : undefined,
      );
      let lastUpdateTime = 0;
      let heartbeatInFlight = false;
      let lastHeartbeatTime = 0;
      let heartbeatTimer: NodeJS.Timeout | undefined;
      // 阶段耗时打点：用于定位「整理分析结果」慢段
      const logPhaseDuration = (phase: string, startedAt: number) => {
        console.log(`[${botConfig.name}] Phase duration for ${body.msgid}: ${phase}=${Date.now() - startedAt}ms`);
      };
      const UPDATE_INTERVAL = 2000;
      let expiredStreamHistorySaved = false;
      let replyStreamQueue = Promise.resolve();
      let finalReplySent = false;
      let terminalReplyClaim: "open" | "final_pending" | "final_in_flight" | "final_sent" | "expired" = "open";
      let finalReplyPromise: Promise<unknown> | undefined;
      let finalReplyDelivered = false;
      let expiryPromise: Promise<void> | undefined;
      let expiryReplyPromise: Promise<unknown> | undefined;
      const visibleStreamSnapshots: string[] = [];
      let visiblePlanSteps: readonly VisiblePlanStep[] | undefined;
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
        if (expiredStreamHistorySaved || !ownsCurrentTask() || currentTask.terminalState !== "expired") return;
        // 保存当前计划状态，供「继续」时复用：只处理未完成项
        if (visiblePlanSteps && visiblePlanSteps.length > 0) {
          sessionManager.setLastPlanSteps(sessionKey, visiblePlanSteps.map(step => ({ ...step })));
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
        await sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: effectiveParsedContent as any }),
          ...(toolContextSummary ? [new SystemMessage(toolContextSummary)] : []),
          new AIMessage(STREAM_EXPIRED_MESSAGE),
        ]);
        if (!ownsCurrentTask() || currentTask.terminalState !== "expired") return;
        sessionManager.setPendingHumanLoop(sessionKey, pauseResumeRequest);
        expiredStreamHistorySaved = true;
      };
      type StreamReplyMode = "normal" | "plan";
      let sendPlanSnapshot: (now?: number) => Promise<boolean>;
      let expireStreamOnce: (waitForPendingReplies?: boolean) => Promise<void>;
      const safeReplyStreamNow = async (content: string, final = false, mode: StreamReplyMode = "normal") => {
        if (streamExpired || currentTask.streamExpired) return false;
        if (shouldStopCurrentTask()) return false;
        const safeContent = stripEmptyProtocolContent(content).trim();
        if (!safeContent && !final) return false;
        const replyContent = final
          ? withMcpEnvironmentNotice(safeContent || "未获取到有效回复")
          : mode === "plan"
            ? safeContent
            : buildIntermediateStreamContent(safeContent);
        if (isStreamExpired(streamStartedAt)) {
          await expireStreamOnce(false);
          return false;
        }

        if (final) {
          if (terminalReplyClaim !== "open") return false;
          terminalReplyClaim = "final_pending";
        }
        try {
          const sendReply = () => {
            if (final) {
              if (isStreamExpired(streamStartedAt)) {
                return Promise.reject(new Error("stream message update expired"));
              }
              terminalReplyClaim = "final_in_flight";
              finalReplyPromise = bot.replyStream(frame, streamId, replyContent, true);
              return finalReplyPromise;
            }
            return bot.replyStreamNonBlocking(frame, streamId, replyContent, false);
          };
          const canRunReply = () => !streamExpired
            && !currentTask.streamExpired
            && !shouldStopCurrentTask()
            && (!final || terminalReplyClaim === "final_pending");
          const replyResult = final
            ? await replyScheduler.scheduleIf(canRunReply, sendReply, "final")
            : await replyScheduler.scheduleLatest(streamId, sendReply, canRunReply);
          if (replyResult === undefined || replyResult === "skipped") {
            if (final && terminalReplyClaim === "final_pending" && !streamExpired) {
              terminalReplyClaim = "open";
            }
            return false;
          }
          if (final) {
            finalReplyPromise = undefined;
            finalReplyDelivered = true;
            terminalReplyClaim = "final_sent";
            currentTask.terminalState = "final_sent";
            if (streamExpiryTimer) clearTimeout(streamExpiryTimer);
          }
          if (!final && mode !== "plan") {
            rememberVisibleStreamSnapshot(safeContent);
          }
          return true;
        } catch (error) {
          if (final) {
            finalReplyPromise = undefined;
            if (terminalReplyClaim === "final_in_flight") terminalReplyClaim = "open";
          }
          if (isWeComStreamExpiredError(error)) {
            await expireStreamOnce(false);
            console.warn(`[${botConfig.name}] WeCom stream expired for ${body.msgid}; stop updating old streamId.`);
            return false;
          }
          if (isWeComReplyAckTimeoutError(error)) {
            handleRequestReplyError(error);
            return false;
          }
          throw error;
        }
      };
      const safeReplyStream = (content: string, final = false, mode: StreamReplyMode = "normal") => {
        if (!final && mode === "normal" && visiblePlanSteps) {
          return sendPlanSnapshot();
        }
        const queuedAt = monotonicNowMs();
        const replyTask = replyStreamQueue.then(
          () => {
            requestTiming.replyQueueMs = (requestTiming.replyQueueMs || 0) + Math.max(0, monotonicNowMs() - queuedAt);
            return safeReplyStreamNow(content, final, mode);
          },
          () => {
            requestTiming.replyQueueMs = (requestTiming.replyQueueMs || 0) + Math.max(0, monotonicNowMs() - queuedAt);
            return safeReplyStreamNow(content, final, mode);
          },
        );
        replyStreamQueue = replyTask.then(() => undefined, () => undefined);
        return replyTask;
      };
      expireStreamOnce = (_waitForPendingReplies = true) => {
        if (!ownsCurrentTask() || currentTask.terminalState === "cancelled" || currentTask.terminalState === "final_sent") return Promise.resolve();
        if (expiryPromise) return expiryPromise;
        expiryPromise = (async () => {
        if (finalReplyDelivered || terminalReplyClaim === "final_sent" || terminalReplyClaim === "expired") return;
        const finalInFlight = terminalReplyClaim === "final_in_flight" ? finalReplyPromise : undefined;
        if (!streamExpired) {
          requestWasStreamExpired = true;
          streamExpired = true;
          currentTask.streamExpired = true;
          currentTask.terminalState = "expired";
          currentTask.cancelled = true;
          streamAbortController.abort();
        }
        if (finalInFlight) {
          try {
            await finalInFlight;
          } catch {
            // 终态发送失败后继续发送暂停通知。
          }
          if (finalReplyDelivered) return;
          if (!ownsCurrentTask() || currentTask.terminalState !== "expired") return;
          if (terminalReplyClaim === "final_in_flight") terminalReplyClaim = "open";
        }
        if (!ownsCurrentTask() || currentTask.terminalState !== "expired") return;
        terminalReplyClaim = "expired";
        const historyPromise = saveExpiredStreamHistory().catch(error => {
          console.error(`[${botConfig.name}] Failed to save stream pause context for ${body.msgid}:`, error);
        });
        if (currentTask.streamExpiryMessageSent) {
          await historyPromise;
          return;
        }
        currentTask.streamExpiryMessageSent = true;
        try {
          if (!ownsCurrentTask() || currentTask.terminalState !== "expired") return;
          expiryReplyPromise = expiryReplyScheduler.scheduleIf(
            () => ownsCurrentTask() && currentTask.terminalState === "expired",
            () => bot.replyStream(frame, streamId, withMcpEnvironmentNotice(STREAM_EXPIRED_MESSAGE), true),
            "final",
          );
          try {
            await expiryReplyPromise;
          } finally {
            expiryReplyPromise = undefined;
          }
          console.warn(`[${botConfig.name}] Proactively stopped WeCom stream for ${body.msgid} at ${formatElapsedDuration(streamStartedAt)}.`);
        } catch (error) {
          await historyPromise;
          if (isWeComReplyAckTimeoutError(error)) {
            handleRequestReplyError(error);
            return;
          }
          if (!isWeComStreamExpiredError(error)) throw error;
          console.warn(`[${botConfig.name}] WeCom stream expired while sending pause notice for ${body.msgid}.`);
        }
      })();
        return expiryPromise;
      };
      const scheduleStreamExpiry = () => {
        if (streamExpiryPromise) return;
        streamExpiryPromise = expireStreamOnce().catch(error => {
          console.error(`[${botConfig.name}] Failed to send stream pause notice for ${body.msgid}:`, error);
        });
      };
      const streamExpiryDelay = Math.max(0, STREAM_SAFE_TTL_MS - (Date.now() - streamStartedAt));
      streamExpiryTimer = setTimeout(scheduleStreamExpiry, streamExpiryDelay);
      if (preStreamExpired || streamExpiryDelay === 0) scheduleStreamExpiry();
      if (preStreamExpiryTimer) {
        clearTimeout(preStreamExpiryTimer);
        preStreamExpiryTimer = undefined;
      }
      cleanupStreamExpiry = async () => {
        if (streamExpiryTimer) clearTimeout(streamExpiryTimer);
        await streamExpiryPromise;
      };
      const buildPlanSnapshot = (now = Date.now()) => {
        if (!visiblePlanSteps) return "";
        const planSteps = renderVisiblePlanSteps(visiblePlanSteps, getProcessingFrame(now));
        if (!planSteps) return "";
        return `处理进度 · 已用时 ${formatElapsedDuration(streamStartedAt, now)}\n\n${planSteps}`;
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
        await Promise.race([
          replyStreamQueue,
          new Promise<void>(resolve => setTimeout(resolve, 5000)),
        ]);
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

      const acquireAgentSlot = async () => {
        const queuedAt = monotonicNowMs();
        const isQueued = agentSlotScheduler.activeCount >= config.llm.maxConcurrentRequests;
        if (isQueued) {
          await withRequestAbort(
            () => sendCard(frame, streamId, withMcpEnvironmentNotice("当前请求较多，正在排队等待分析资源。"), false),
            streamAbortController.signal,
            "排队提示已取消",
          );
        }
        agentSlotLease = await agentSlotScheduler.acquire(streamAbortController.signal);
        requestTiming.agentQueueMs = Math.max(0, monotonicNowMs() - queuedAt);
      };
      await acquireAgentSlot();
      if (shouldStopCurrentTask()) {
        finishRequestTiming("cancelled", requestReplyAckFailed ? "reply_ack_timeout" : "task_replaced");
        return;
      }

      // --- Planner Logic Start ---
      let plannerResult: Awaited<ReturnType<typeof runPlanner>> = null;
      const runtimeEvidenceInstruction = `系统提示：【证据核实要求】
优先使用可用工具、代码检索、已保存证据和测试/dev 库只读查询核实结论；只有所有可用路径都无法确认时才触发 Human Loop，并说明最小缺口。
如果需要核对整合后的用户问题，调用 original_user_question_get；如果是继续或追问上一轮，调用 session_memory_graph_query 获取相关历史锚点。
测试环境或 dev 环境已提供 URL、参数或明确允许查库时，不要先询问可由工具确认的字段含义、状态或连接信息。
每轮只完成用户明确要求的事实取值、用途解释、上下游定位、流程梳理、取数语句、排障原因、处理方案或代码修改；项目范围未知时先使用明确锚点检索，证据充分后立即收敛，不重复宽搜。
最终结论必须能追溯到用户输入、工具结果、代码证据、数据库结果或明确业务规则；不确定时只说明尚缺的最小证据。`;
      const flowControlInstruction = `系统提示：【流式内容控制协议】
如需让下一段真实可见内容覆盖前面的阶段性流式内容，可输出单独的 <flow_control>{"stream":{"coverPrevious":true}}</flow_control>；运行时会剥离该协议，用户不可见。`;

      // 提取文本内容进行 Planner 分析
      let textToPlan = "";
      if (typeof effectiveParsedContent === 'string') {
        textToPlan = stripBoundaryMentions(effectiveParsedContent);
      } else if (Array.isArray(effectiveParsedContent)) {
        const textItem = effectiveParsedContent.find(i => i.type === 'text');
        if (textItem) textToPlan = stripBoundaryMentions(textItem.text || "");
      }

      // 分流决策在 planner 意图分析之后产生（见 Planner Logic End 后的 classifyQuestionDifficulty）
      const ENABLE_LEGACY_PLANNER = process.env.ENABLE_LEGACY_PLANNER === "true";
      if (isStreamPauseResume) {
        // 复用暂停前保存的计划：已完成项保持 ✓，只处理未完成项
        const storedPlanSteps = sessionManager.getLastPlanSteps(sessionKey);
        let planResumeInstruction = "";
        if (storedPlanSteps && storedPlanSteps.length > 0) {
          visiblePlanSteps = storedPlanSteps.map(step => ({ ...step }));
          const planProgressText = storedPlanSteps
            .map(step => `${step.status === "done" ? "✓" : "○"} ${step.task}`)
            .join("\n");
          planResumeInstruction = `\n\n系统提示：【断点恢复计划】\n暂停前计划进度：\n${planProgressText}\n已完成项无需重新处理，只继续未完成项。`;
          console.log(`[${botConfig.name}] Restored saved plan for ${body.msgid}: ${storedPlanSteps.length} steps (${storedPlanSteps.filter(step => step.status === "done").length} done)`);
          // 恢复的计划立即以快照呈现给用户
          void sendPlanSnapshot();
        }
        if (typeof effectiveParsedContent === 'string') {
          finalContentForPrompt = `${buildStreamPauseResumeRuntimeInstruction()}${planResumeInstruction}\n\n${effectiveParsedContent}`;
        } else if (Array.isArray(effectiveParsedContent)) {
          finalContentForPrompt = [
            { type: 'text', text: `${buildStreamPauseResumeRuntimeInstruction()}${planResumeInstruction}\n\n` },
            ...effectiveParsedContent,
          ];
        }
      } else if (ENABLE_LEGACY_PLANNER && textToPlan.trim().length > 0) {
        try {
          await sendStageProgress("已收到问题，正在识别意图和检索锚点，继续核实中。", true);
          plannerResult = await runPlanner(textToPlan);
          if (plannerResult) {
            visiblePlanSteps = [
              { id: "planner_checked", task: "分析处理思路", status: "done" },
              { id: "tools_loaded", task: "查询相关信息", status: "pending" },
              { id: "analysis_finished", task: "整理分析结果", status: "pending" },
            ];
            await sendPlanSnapshot();
            const queries = plannerResult.queries?.map(q => `- ${q.query} (${q.type}, 优先级: ${q.priority})`).join('\n') || '';
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
* GitNexus query 成本较高，优先合并查询条件；命中候选文件后改用 code_snippet/context 或已有证据回答。
* 严禁拆分关键词进行多次循环搜索。${smsTemplateEvidenceHint}`;
            
            if (typeof effectiveParsedContent === 'string') {
              finalContentForPrompt = `${hasDirectEvidence ? `${buildDirectEvidenceRuntimeInstruction()}\n\n` : ""}${searchPlanHint}\n\n${effectiveParsedContent}`;
            } else if (Array.isArray(effectiveParsedContent)) {
              finalContentForPrompt = [
                { type: 'text', text: `${hasDirectEvidence ? `${buildDirectEvidenceRuntimeInstruction()}\n\n` : ""}${searchPlanHint}\n\n` },
                ...effectiveParsedContent.map(item => item.type === 'text' ? { ...item, text: stripBoundaryMentions(item.text || '') } : item)
              ];
            }
          }
        } catch (err) {
          console.error("Planner execution failed:", err);
        }
      }
      if (typeof finalContentForPrompt === 'string') {
        finalContentForPrompt = `${runtimeEvidenceInstruction}\n\n${flowControlInstruction}\n\n${finalContentForPrompt}`;
      } else if (Array.isArray(finalContentForPrompt)) {
        finalContentForPrompt = [
          { type: "text", text: `${runtimeEvidenceInstruction}\n\n${flowControlInstruction}\n\n` },
          ...finalContentForPrompt,
        ];
      }
      // --- Planner Logic End ---

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
        const toolsLoadMonotonicStartedAt = monotonicNowMs();
        const tools = await loadMcpTools(botConfig, mcpHeaderOverrides);
        requestTiming.mcpLoadMs = Math.max(0, monotonicNowMs() - toolsLoadMonotonicStartedAt);
        logPhaseDuration(`tools_load(count=${tools.length})`, toolsLoadStartedAt);
        const defaultRepoHints = extractProjectsFromMcpHeaders(mcpHeaderOverrides);
        const explicitRepoHints = extractExplicitRepoHints(textToPlan, defaultRepoHints);
        repoHints = sessionManager.resolveRepoHints(sessionKey, explicitRepoHints, defaultRepoHints);
        autoVerificationScopedEvidenceTools = scopeToolsToRepo(
          filterToolsForKnownProjectScope(tools, repoHints),
          repoHints,
        );
        const agentTools = buildPrimaryPiAgentTools(
          autoVerificationScopedEvidenceTools,
          buildOriginalQuestionTool({
            originalUserQuestion,
            currentQuestion,
            sessionMessages: session.messages,
          }),
          buildSessionMemoryGraphTool({
            graph: session.memoryGraph,
            currentQuestion,
          }),
          buildToolResultFileReadTool(),
        );
        autoVerificationAgent = await initializePiAgent(agentTools, plannerResult, sessionKey);
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

        const handoff = replacedTask?.handoff;
        const latestMessageContext = buildLatestMessageContext(
          stringifyModelContent(effectiveParsedContent),
          handoff ? {
            previousQuestion: handoff.question,
            partialAnswer: handoff.partialAnswer,
            toolContextSummary: handoff.toolContextSummary,
            repoHints: handoff.repoHints,
          } : undefined,
        );
        const agentUserContent = latestMessageContext;
        const agentPrompt = stringifyModelContent(userContent).includes("【最新消息处理】")
          ? userContent
          : typeof userContent === "string"
            ? `${userContent}\n\n${agentUserContent}`
            : userContent;
        const stream = agent.streamPiEvents(String(agentPrompt), {
          deadlineMs: requestDeadlineMs,
          signal: streamAbortController.signal,
          ...(signal ? { signal } : {}),
        }, buildMessagesForCurrentTurn({
          sessionMessages: session.messages,
          userContent: agentPrompt,
          repoHint: repoHints,
        }));

        for await (const event of stream) {
          updateActiveTaskHandoff();
          if (event.type === "turn_start") {
            requestTurnCount += 1;
            requestModelCallCount += 1;
          }
          if (event.type === "agent_end") {
            piAgentEndFailure = extractPiAgentEndFailure(event);
            if (piAgentEndFailure?.reason === "aborted") {
              piAgentWasAborted = true;
              throw new Error(piAgentEndFailure.errorMessage || "Pi Agent 执行已取消");
            }
            if (piAgentEndFailure?.reason === "error") {
              const detail = [piAgentEndFailure.errorMessage, piAgentEndFailure.rawStopReason].filter(Boolean).join("；");
              throw new Error(detail ? `Pi Agent 模型执行失败：${detail}` : "Pi Agent 模型执行失败");
            }
            const finalMessage = eventToLegacyMessage(event);
            const finalText = finalMessage ? stringifyModelContent(finalMessage.content) : "";
            piAgentEnded = Boolean(finalText.trim());
            if (piAgentEnded) {
              fullContent = finalText;
            }
            continue;
          }
          const message = eventToLegacyMessage(event);
          if (!message) {
            if (event.type === "error") throw new Error(event.message);
            if (event.type === "aborted") throw new Error(STREAM_EXPIRED_MESSAGE);
            continue;
          }
          const metadata: AgentStreamMetadata = {};
          const streamMetadata = metadata;
          if (signal?.aborted || streamAbortController.signal.aborted || shouldStopCurrentTask()) {
            if (streamExpired) throw new Error(STREAM_EXPIRED_MESSAGE);
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
          const type = (msg as any)._getType?.() || msg.constructor.name;
          if (type === "tool" || type === "ToolMessage") {
            const toolMsg = msg as any;
            const id = toolMsg.tool_call_id;
            const entry = toolCallMap.get(id);
            if (entry) {
              entry.completed = true;
              if (entry.startedAt > 0) {
                requestTiming.toolCallMs = (requestTiming.toolCallMs || 0) + Math.max(0, monotonicNowMs() - entry.startedAt);
              }
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
            updateActiveTaskHandoff();
            if (isRequestRawLoggingEnabled()) requestToolRecords.push({ ...toolRecord });
            if (toolRecord.name && !requestToolNames.includes(toolRecord.name)) requestToolNames = [...requestToolNames, toolRecord.name];
            console.log(`[Tool Call Result] Name: ${toolRecord.name}, Status: ${toolRecord.status || "unknown"}, ArgLength: ${toolRecord.args.length}, Result Size: ${stringifyModelContent(toolMsg.content).length}`);
            continue;
          }

          if (type === "ai" || type === "AIMessage" || type === "AIMessageChunk") {
            const aiMsg = msg as any;
            if (aiMsg.tool_call_chunks && aiMsg.tool_call_chunks.length > 0) {
              for (const chunk of aiMsg.tool_call_chunks) {
                const id = chunk.id;
                if (!id) continue;
                if (!toolCallMap.has(id)) {
                  toolCallMap.set(id, { name: "", args: "", notified: false, completed: false, startedAt: monotonicNowMs() });
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
                  startedAt: monotonicNowMs(),
                });
                console.log(`[Tool Call] Name: ${tool.name}, ArgLength: ${getToolArgumentLength(tool.args)}`);
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
              if (extractedDelta.content) {
                partialAssistantText = `${partialAssistantText}${extractedDelta.content}`.slice(-40_000);
                updateActiveTaskHandoff();
              }
              // 普通 assistant 文本可能只是“已定位候选/继续核实”等中间状态。
              // 最终正文只接受 agent_end，避免把中间状态当成用户最终回复。
            }
          }
        }

        for (const [id, entry] of toolCallMap.entries()) {
          if (!entry.completed && entry.name) {
            console.log(`[Tool Call Pending/Final] Name: ${entry.name}, ArgLength: ${entry.args.length}`);
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
        const monotonicStartedAt = monotonicNowMs();
        try {
          return await runAutoVerificationAgentRound(userContent, resetCandidate, signal);
        } finally {
          requestTiming.piModelRoundMs = (requestTiming.piModelRoundMs || 0) + Math.max(0, monotonicNowMs() - monotonicStartedAt);
          logPhaseDuration(`agent_round(reset=${resetCandidate})`, startedAt);
        }
      };

      // 明确入口问题：先精确定位入口/板块，再拉图信息，从代码整理答案。
      // 入口锚点由 planner 模型节点识别（entry_anchors），不用正则。
      const entryAnchors = plannerResult?.entry_anchors?.filter(Boolean) ?? [];
      const useEntryAnchor = !isStreamPauseResume
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

      // 时间上限降级交付：把本轮已产生的助手文本作为“部分结论”发出，而不是丢弃整轮成果。
      const deliverDeadlineDegradedReply = async () => {
        const partial = collapseProgressUpdates(stripEmptyProtocolContent(partialAssistantText)).trim();
        const progressOnly = !partial || PROGRESS_KEYWORDS.some(keyword => partial.endsWith(keyword));
        const elapsed = formatElapsedDuration(streamStartedAt);
        const degradedAnswer = progressOnly
          ? `⏱ 本次耗时 ${elapsed}，已到本轮时间上限，仍在核实中，暂未形成可交付结论。建议把问题缩小到具体项目、接口或页面后重试。`
          : `${partial}\n\n⏱ 本次耗时 ${elapsed}，已到本轮时间上限；以上为已确认的部分结论，未覆盖的部分尚未核实。`;
        console.warn(`[${botConfig.name}] Pi request deadline reached for ${body.msgid}: partialChars=${partial.length}, progressOnly=${progressOnly}`);
        await stopThinkingHeartbeatAndDrain();
        const sent = await safeReplyStream(degradedAnswer, true);
        if (sent && ownsCurrentTask()) {
          currentTask.terminalState = "final_sent";
          if (streamExpiryTimer) clearTimeout(streamExpiryTimer);
          fullContent = degradedAnswer;
          const degradedToolSummary = buildToolContextSummary(toolContextRecords);
          void sessionManager.addMessages(sessionKey, [
            new HumanMessage({ content: effectiveParsedContent as any }),
            ...(degradedToolSummary ? [new SystemMessage(degradedToolSummary)] : []),
            new AIMessage(degradedAnswer),
          ]).catch(error => {
            console.error(`[${botConfig.name}] Failed to persist degraded reply for ${body.msgid}:`, error);
          });
        }
        return Boolean(sent);
      };

      // Pi 生命周期负责工具选择、继续执行和正常完成。
      try {
        await sendStageProgress("正在加载 MCP 工具和项目范围，继续核实中。", true);
        await ensureAutoVerificationAgent();
        await sendStageProgress("已加载可用工具，继续由 Pi 直接分析问题。", true);
        await sendStageProgress("正在启动业务分析节点，继续核实中。", true);
        await sendStageProgress("业务分析节点已启动，正在调用模型和工具核实证据，继续核实中。", true);
        await runAgentRoundWithTiming(finalContentForPrompt, false);

        } catch (err: any) {
          recordRequestRawError(err);
          requestExecutionError = true;
          if (streamExpired) {
            await cleanupStreamExpiry();
            console.warn(`[${botConfig.name}] Pi stream stopped at the WeCom safety deadline for ${body.msgid}.`);
            finishRequestTiming("ttl_expired", "stream_expired");
            return;
          }
          if (piAgentWasAborted) {
            // SDK 在截止中止后仍可能补发 agent_end(aborted)：此时必须走降级交付，而不是静默结束。
            if (Date.now() - streamStartedAt >= requestDeadlineMs) {
              await deliverDeadlineDegradedReply();
              finishRequestTiming(
                currentTask.cancelled || !ownsCurrentTask() ? "cancelled" : "ttl_expired",
                requestReplyAckFailed ? "reply_ack_timeout" : "pi_request_timeout",
              );
              return;
            }
            finishRequestTiming("cancelled", "pi_agent_aborted");
            return;
          }
          if (currentTask.cancelled || requestAbortController.signal.aborted || shouldStopCurrentTask()) {
            finishRequestTiming("cancelled", requestReplyAckFailed ? "reply_ack_timeout" : "task_cancelled");
            return;
          }
          console.error(`Agent execution error for ${body.msgid}:`, err);
          await saveFailedRequestQuestion(effectiveParsedContent);
          fullContent = "";
          try {
            const sent = await sendCard(frame, streamId, "本次分析暂时失败，请稍后重试。", true, {
              templateCard: {
                card_type: "text_notice",
                main_title: { title: "处理失败", desc: "本次分析未能完成" },
                task_id: `task_${body.msgid}`,
              },
            },
            () => activeTasks.get(sessionKey) === currentTask
              && !currentTask.cancelled
              && !streamExpired,
          );
          if (sent !== undefined && ownsCurrentTask()) {
            currentTask.terminalState = "final_sent";
            if (streamExpiryTimer) clearTimeout(streamExpiryTimer);
          }
          } catch (replyError) {
            console.error(`[${botConfig.name}] Failed to send agent error reply for ${body.msgid}:`, replyError);
          }
          finishRequestTiming(
            currentTask.cancelled || !ownsCurrentTask() ? "cancelled" : "error",
            requestReplyAckFailed ? "reply_ack_timeout" : "agent_execution_error",
          );
          return;
        }

      if (streamExpired) {
        if (streamExpiryTimer) clearTimeout(streamExpiryTimer);
        await streamExpiryPromise;
        finishRequestTiming("ttl_expired", "stream_expired");
        return;
      }

      const sendInvalidPiLifecycleReply = async () => {
        console.error(`[${botConfig.name}] Pi agent_end did not contain a sendable final text for ${body.msgid}`);
        await saveFailedRequestQuestion(effectiveParsedContent);
        try {
          const sent = await sendCard(
            frame,
            streamId,
            "本次分析未返回有效最终结论，请稍后重试。",
            true,
            undefined,
            () => activeTasks.get(sessionKey) === currentTask
              && !currentTask.cancelled
              && !streamExpired,
          );
          if (sent !== undefined && ownsCurrentTask()) {
            currentTask.terminalState = "final_sent";
            if (streamExpiryTimer) clearTimeout(streamExpiryTimer);
          }
        } catch (replyError) {
          console.error(`[${botConfig.name}] Failed to send invalid lifecycle reply for ${body.msgid}:`, replyError);
        }
      };

      if (!piAgentEnded) {
        fullContent = "";
        if (currentTask.cancelled || requestAbortController.signal.aborted || shouldStopCurrentTask()) {
          finishRequestTiming("cancelled", requestReplyAckFailed ? "reply_ack_timeout" : "task_cancelled");
          return;
        }
        // 时间上限：交付已确认要点，而不是丢弃整轮成果。
        if (Date.now() - streamStartedAt >= requestDeadlineMs) {
          await deliverDeadlineDegradedReply();
          finishRequestTiming(
            currentTask.cancelled || !ownsCurrentTask() ? "cancelled" : "ttl_expired",
            requestReplyAckFailed ? "reply_ack_timeout" : "pi_request_timeout",
          );
          return;
        }
        await sendInvalidPiLifecycleReply();
        finishRequestTiming(
          currentTask.cancelled || !ownsCurrentTask() ? "cancelled" : "error",
          requestReplyAckFailed ? "reply_ack_timeout" : "pi_agent_end_stop_text_missing",
        );
        return;
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

      if (fullContent) {
        const humanLoopRequest = detectHumanLoopRequest(fullContent);
        if (humanLoopRequest) {
          const storedRequest = toStoredHumanLoopRequest(humanLoopRequest, body.msgid);
          sessionManager.setPendingHumanLoop(sessionKey, storedRequest);
          fullContent = buildHumanLoopReply(storedRequest);
        } else if (activePendingHumanLoop) {
          sessionManager.clearPendingHumanLoop(sessionKey);
        }

      }

      // 发送最终结果
      fullContent = collapseProgressUpdates(stripEmptyProtocolContent(fullContent));
      if (!fullContent) {
        if (currentTask.cancelled || requestAbortController.signal.aborted || shouldStopCurrentTask()) {
          finishRequestTiming("cancelled", requestReplyAckFailed ? "reply_ack_timeout" : "task_cancelled");
          return;
        }
        await sendInvalidPiLifecycleReply();
        finishRequestTiming(
          currentTask.cancelled || !ownsCurrentTask() ? "cancelled" : "error",
          requestReplyAckFailed ? "reply_ack_timeout" : "pi_agent_end_stop_text_missing",
        );
        return;
      }

      const finalDelivery: FinalReplyDeliveryResult = {
        content: fullContent,
        shouldSendFinal: Boolean(piAgentEnded && fullContent.trim() && !requestExecutionError),
        reason: piAgentEnded && fullContent.trim() && !requestExecutionError
          ? "Pi agent_end 已返回最终回答"
          : "Pi agent_end 未返回可发送的最终回答",
        source: "candidate",
      };
      fullContent = finalDelivery.content;

      // Pi 输出即为最终回答；终态发送通过共享调度器串行交付，TTL 仍保持有效。
      let finalHistoryPersisted = false;
      await stopThinkingHeartbeatAndDrain();
      if (finalDelivery.shouldSendFinal && !shouldStopCurrentTask() && !finalReplySent) {
        finalReplySent = true;
        console.log(`[${botConfig.name}] Final reply for ${body.msgid}: totalElapsed=${formatElapsedDuration(streamStartedAt)}`);
        const finalSendStartedAt = monotonicNowMs();
        const sent = await safeReplyStream(
          `${fullContent}\n\n⏱ 本次耗时 ${formatElapsedDuration(streamStartedAt)}`,
          true,
        );
        if (sent) {
          requestTiming.finalSendMs = Math.max(0, monotonicNowMs() - finalSendStartedAt);
          if (ownsCurrentTask()) {
            finalHistoryPersisted = true;
            sessionManager.setLastRawAnswer(sessionKey, fullContent);
            const finalToolContextSummary = buildToolContextSummary(toolContextRecords);
            void sessionManager.addMessages(sessionKey, [
              new HumanMessage({ content: effectiveParsedContent as any }),
              ...(finalToolContextSummary ? [new SystemMessage(finalToolContextSummary)] : []),
              new AIMessage(fullContent),
            ]).catch(error => {
              console.error(`[${botConfig.name}] Failed to persist final reply for ${body.msgid}:`, error);
            });
          }
          finishRequestTiming("completed", requestExecutionError ? "agent_execution_error" : null);
        } else {
          finishRequestTiming(streamExpired ? "ttl_expired" : "cancelled", streamExpired ? "stream_expired" : "final_send_skipped");
        }
      }
      if (
        fullContent
        && !finalHistoryPersisted
        && !shouldStopCurrentTask()
      ) {
        const finalToolContextSummary = buildToolContextSummary(toolContextRecords);
        void sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: effectiveParsedContent as any }),
          ...(finalToolContextSummary ? [new SystemMessage(finalToolContextSummary)] : []),
          new AIMessage(fullContent),
        ]).catch(error => {
          console.error(`[${botConfig.name}] Failed to persist final reply for ${body.msgid}:`, error);
        });
      }
      // 恢复轮完成后清理保存的计划，避免后续普通轮次误复用
      if (isStreamPauseResume && sessionManager.getLastPlanSteps(sessionKey)) {
        sessionManager.clearLastPlanSteps(sessionKey);
      }
      if (activeTasks.get(sessionKey) === currentTask) {
        activeTasks.delete(sessionKey);
      }
    } catch (error) {
      recordRequestRawError(error);
      if (error instanceof AgentSlotCancelledError) {
        finishRequestTiming(
          requestWasStreamExpired ? "ttl_expired" : "cancelled",
          requestWasStreamExpired ? "stream_expired" : "agent_queue_cancelled",
        );
        return;
      }
      finishRequestTiming("error", "request_processing_error");
      stopThinkingHeartbeat();
      console.error(`Outer error processing message ${body.msgid}:`, error);
      cleanupActiveTask();
    } finally {
      await cleanupStreamExpiry();
      stopThinkingHeartbeat();
      if (!requestTimingFinished) {
        finishRequestTiming("cancelled", "request_ended_without_final_reply");
      }
      cleanupActiveTask();
    }
  });

  bot.on("disconnected", reason => {
    console.warn(`[${botConfig.name}] WeCom WebSocket disconnected: ${reason}; cancelling active streams for this bot.`);
    for (const task of activeTasks.values()) {
      task.cancelled = true;
      task.abortController?.abort();
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
  console.log(`[${botConfig.name}] WeCom Bot starting... Model: ${config.llm.modelName}, Context Window: ${contextWindow} tokens`);
}

export async function startBots() {
  await Promise.all(config.bots.map(botConfig => startBot(botConfig)));
}
