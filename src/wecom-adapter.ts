import { WSClient, MessageType, generateReqId } from "@wecom/aibot-node-sdk";
import { initializeAgent, runPlanner, runSearchLoopPrelude, getModelContextWindow, getBaseModel, getBusinessPrompt, extractExplicitRepoHints, extractMcpProjectCandidates, buildMessagesForCurrentTurn, scopeToolsToRepo } from "./graph.js";
import { getMissingPriorityAnswerAnchors, repairAnswerForMissingPriorityAnchors } from "./answer-anchor-guard.js";
import { config, type BotConfig } from "./config.js";
import { HumanMessage, AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { sessionManager } from "./session-manager.js";
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
} from "./human-loop.js";
import { buildIntermediateStreamContent, buildProgressStreamContent, buildThinkingHeartbeatContent, collapseProgressUpdates, stripProtocolNoise } from "./progress-updates.js";
import {
  consumeFlowControlDelta,
  createDefaultFlowControl,
  createFlowControlStreamState,
  extractFlowControl,
  type FlowControlPatch,
  mergeFlowControl,
} from "./flow-control.js";
import { createAgentProgressGuard, createAgentProgressLimitError } from "./agent-progress-guard.js";
import { isStreamExpired, isWeComReplyAckTimeoutError, isWeComStreamExpiredError, STREAM_EXPIRED_MESSAGE } from "./stream-ttl.js";
import { buildToolContextSummary, filterToolResultForCurrentTurn, type ToolContextRecord } from "./tool-context-filter.js";
import { buildProgressLimitRecoverySystemPrompt, ensureRecoverySqlAuditMarker } from "./recovery-synthesis.js";
import { buildOriginalQuestionTool } from "./original-question-tool.js";
import { buildSessionMemoryGraphTool } from "./session-memory-graph.js";
import {
  buildStreamPauseResumeRequest,
  buildStreamPauseResumeRuntimeInstruction,
  isStreamPauseResumeRequest,
} from "./stream-pause-resume.js";
import {
  extractProjectsFromHeaders,
  extractProjectsFromMcpHeaders,
  listMcpHeaderCommands,
  parseMcpHeaderCommand,
  resolveMcpHeaderCommand,
} from "./mcp-header-commands.js";
import {
  buildDirectEvidenceFastPathInstruction,
  buildDirectEvidenceRuntimeInstruction,
  hasDirectEvidenceAnchors,
  shouldUseDirectEvidenceFastPath,
} from "./direct-evidence.js";
import {
  buildFollowupQuestion,
  buildQuestionWithHistory,
  classifyHistoryRelevance,
  detectActiveMessageIntent,
  type ConversationContextItem,
} from "./interaction-control.js";
import {
  applySqlAuditEvidence,
  appendIncompleteFinalNotice,
  assertTodoListComplete,
  blockTodoItem,
  buildIncompleteAuditTodoMessage,
  generateUserFacingAuditFallbackMessage,
  buildRuntimeTodoTool,
  buildSqlAuditEvidence,
  completeRecoveryAuditItems,
  completeSkippedAuditItems,
  completeTodoItem,
  createRuntimeTodoList,
  getIncompleteAuditTodoItems,
  hasTodoItem,
  isFinalAnswerReady,
  isSqlAuditEvidenceBlocking,
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

const THINKING_HEARTBEAT_INTERVAL_MS = 15000;

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

export function buildHelpReply(headerCommands = listMcpHeaderCommands(config.mcpServers)) {
  const commandText = headerCommands.length > 0
    ? `发送 ${headerCommands.map(command => `\`${command.command}\``).join("、")} 切换 MCP header 配置。`
    : "也可以直接说明“不要沿用上个项目，改查 <项目名>”。";
  return [
    "使用帮助",
    "",
    "1. 提问方式",
    "直接描述业务问题、接口、报错、页面路径、项目名或截图。我会优先定位项目范围，再核实代码、SQL 或配置证据。",
    "",
    "2. 清理会话",
    "发送“清理会话”“清空上下文”“重置对话”或 `/new`，可以清除当前会话历史。",
    "",
    "3. 清理项目限制",
    "发送“清理会话”后重新提问，不带历史项目范围；也可以直接说明“不要沿用上个项目，改查 <项目名>”。",
    commandText,
    "",
    "4. 继续或停止",
    "任务处理中发送“继续”可确认继续等待；发送“停止”可取消当前任务。",
    "",
    "5. SQL 参数",
    "如果需要 SQL，我会把需要你填写的参数统一放在 SQL 最前面的变量区，并用一句话列出需要提供的信息。",
  ].join("\n");
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
      await bot.replyStreamWithCard(frame, streamId, buildThinkingHeartbeatContent("", [], Date.now()), false, {
        templateCard: {
          card_type: 'text_notice',
          main_title: { title: '任务处理中', desc: 'AI 助手正在读取消息内容...' },
          task_id: `task_${body.msgid}`,
        }
      });
      earlyProgressTimer = setInterval(() => {
        void sendEarlyProgress(buildThinkingHeartbeatContent("", [], Date.now()));
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
    const chatType = body.chattype; // 'single' 或 'group'
    const fromUser = body.from?.userid;
    const chatId = body.chatid;

    // 生成唯一的会话 Key
    let sessionKey = "";
    if (chatType === "group" && chatId && fromUser) {
      sessionKey = `group:${chatId}:${fromUser}`;
    } else if (fromUser) {
      sessionKey = `single:${fromUser}`;
    } else {
      sessionKey = chatId || fromUser || "unknown";
    }

    // --- Session Handling Start ---
    let session = sessionManager.getOrCreateSession(sessionKey, true);

    // Handle high-priority system commands (Exact match only)
    const commandText = body.msgtype === MessageType.Text
      ? body.text?.content || ""
      : extractTextContent(parsedContent as any);
    const isHelp = isHelpCommand(commandText);
    const isHardcodedNew = isClearSessionCommand(commandText);
    const activeTask = activeTasks.get(sessionKey);
    const activeText = stripBoundaryMentions(commandText);
    const mcpHeaderCommand = parseMcpHeaderCommand(commandText, config.mcpServers);
    let followupQuestion = "";

    if (mcpHeaderCommand) {
      const projects = extractProjectsFromMcpHeaders(mcpHeaderCommand.headersByServer);
      sessionManager.setMcpHeaderOverrides(sessionKey, mcpHeaderCommand.headersByServer);
      sessionManager.setRepoHints(sessionKey, projects);
      await bot.replyStreamWithCard(
        frame,
        body.msgid,
        `已切换到 ${mcpHeaderCommand.label} 配置：${projects.length > 0 ? projects.join(", ") : JSON.stringify(mcpHeaderCommand.headersByServer)}`,
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

    const originalUserQuestion = typeof parsedContent === "string"
      ? stripBoundaryMentions(parsedContent)
      : extractTextContent(parsedContent as any);
    let effectiveParsedContent: typeof parsedContent = parsedContent;
    const pendingHumanLoop = sessionManager.getPendingHumanLoop(sessionKey);
    const pendingText = stripBoundaryMentions(commandText);
    const activePendingHumanLoop = pendingHumanLoop && !isHumanLoopExpired(pendingHumanLoop)
      ? pendingHumanLoop
      : undefined;
    const isStreamPauseResume = isStreamPauseResumeRequest(activePendingHumanLoop);
    const hasDirectEvidence = hasDirectEvidenceAnchors(originalUserQuestion);

    if (pendingHumanLoop && !activePendingHumanLoop) {
      sessionManager.clearPendingHumanLoop(sessionKey);
    }

    if (activePendingHumanLoop && isAmbiguousNewTopicWhilePending(pendingText)) {
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
            return { role: "assistant", content: message.content.toString() };
          }
          return { role: "system", content: message.content.toString() };
        });
      const relevance = classifyHistoryRelevance(historyItems, pendingText);
      if (relevance.decision === "independent") {
        console.log(`[Session] Auto clearing unrelated history for ${sessionKey}: ${relevance.reason}`);
        sessionManager.clearSession(sessionKey);
        session = sessionManager.getOrCreateSession(sessionKey, true);
      } else {
        effectiveParsedContent = buildQuestionWithHistory(historyItems, pendingText);
      }
    }
    // --- Session Handling End ---

    try {
      const currentQuestion = typeof effectiveParsedContent === "string"
        ? stripBoundaryMentions(effectiveParsedContent)
        : extractTextContent(effectiveParsedContent as any);
      const currentTask: ActiveTaskState = { msgid: body.msgid, cancelled: false, question: currentQuestion };
      activeTasks.set(sessionKey, currentTask);
const runtimeTodoList = createRuntimeTodoList();
      startTodoItem(runtimeTodoList, "message_parsed");
      completeTodoItem(runtimeTodoList, "message_parsed", `msgid=${body.msgid}, type=${body.msgtype}`);

      if (!startEarlyProgress) {
        // 发送初始进度卡片
        await bot.replyStreamWithCard(frame, streamId, "AI 正在思考中...", false, {
          templateCard: {
            card_type: 'text_notice',
            main_title: { title: '任务处理中', desc: 'AI 助手正在分析您的请求...' },
            task_id: `task_${body.msgid}`,
          }
        });
      }

      const shouldStopCurrentTask = () => activeTasks.get(sessionKey) !== currentTask || currentTask.cancelled;

      let fullContent = "";
      let flowControl = createDefaultFlowControl();
      const flowControlStreamState = createFlowControlStreamState();
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
      let repoHints: string[] = [];
      let recoveryAuditReason = "";
      let lastUpdateTime = 0;
      let heartbeatInFlight = false;
      let lastHeartbeatTime = 0;
      let heartbeatTimer: NodeJS.Timeout | undefined;
      const UPDATE_INTERVAL = 2000;
      let expiredStreamFinalSent = false;
      let expiredStreamHistorySaved = false;
      let replyAckTimeoutReconnectTriggered = false;
      let replyStreamQueue = Promise.resolve();
      const saveExpiredStreamHistory = async () => {
        if (expiredStreamHistorySaved) return;
        expiredStreamHistorySaved = true;
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
      const safeReplyStreamNow = async (content: string, final = false) => {
        if (shouldStopCurrentTask()) return false;
        const safeContent = stripEmptyProtocolContent(content).trim();
        if (!safeContent && !final) return false;
        const replyContent = final
          ? (safeContent || "未获取到有效回复")
          : buildIntermediateStreamContent(safeContent);
        if (isStreamExpired(streamStartedAt)) {
          await saveExpiredStreamHistory();
          currentTask.cancelled = true;
          if (!expiredStreamFinalSent) {
            expiredStreamFinalSent = true;
            try {
              await bot.replyStream(frame, streamId, STREAM_EXPIRED_MESSAGE, true);
            } catch (error) {
              if (!isWeComStreamExpiredError(error)) throw error;
              console.warn(`[${botConfig.name}] WeCom stream already expired for ${body.msgid}; skip final pause update.`);
            }
          }
          return false;
        }

        try {
          await bot.replyStream(frame, streamId, replyContent, final);
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
      const safeReplyStream = (content: string, final = false) => {
        const replyTask = replyStreamQueue.then(
          () => safeReplyStreamNow(content, final),
          () => safeReplyStreamNow(content, final),
        );
        replyStreamQueue = replyTask.then(() => undefined, () => undefined);
        return replyTask;
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
      heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight || shouldStopCurrentTask()) return;
        const now = Date.now();
        if (now - lastHeartbeatTime < THINKING_HEARTBEAT_INTERVAL_MS) return;
        heartbeatInFlight = true;
        void safeReplyStream(
          buildThinkingHeartbeatContent(fullContent, getActiveToolCalls(), now),
          false,
        ).then(sent => {
          if (sent) lastHeartbeatTime = Date.now();
        }).catch(error => {
          console.error(`[${botConfig.name}] Thinking heartbeat failed for ${body.msgid}:`, error);
        }).finally(() => {
          heartbeatInFlight = false;
        });
      }, THINKING_HEARTBEAT_INTERVAL_MS);

      // --- Planner Logic Start ---
      let plannerResult = null;
      const runtimeTodoInstruction = `系统提示：【运行时 TodoList 工具要求】
当前回答由运行时 TodoList 控制流程完成度，TodoList 是动态计划，不是固定审核清单。
如果当前工具列表存在 runtime_todolist_update，只需要维护当前问题实际需要的审核节点；不要为了无关节点补“不适用”，也不要输出内部 TodoList 内容。
如果你需要核对用户整合后的问题，或怀疑历史整合、上下文压缩、提示词增强导致问题失真，必须调用 original_user_question_get 获取整合后的用户问题后再继续分析。
如果当前问题是“继续”、追问上一轮、需要继承历史里的项目/接口/方法/文件/表字段/已分析行号范围，或担心短时记忆压缩导致锚点丢失，必须先调用 session_memory_graph_query 获取相关历史图索引；不要因为默认上下文里没看到历史细节就要求用户补充。
测试环境/dev 环境排障硬约束：如果用户已提供接口 URL、query 参数、请求体、返回体，或明确说“可以直接查库/测试环境可查库”，禁止在查询前询问用户补充 type 含义、状态字段、业务节点、同类型正常样本或数据库连接信息。必须先使用可用工具、代码检索、参数映射和测试库只读查询确认；只有这些查询后仍无法确认，或工具/测试库不可达，才允许 Human Loop，并且必须说明已尝试的工具、SQL 或代码证据。
Human Loop 严格门槛：所有可由 LLM 工具、代码检索、调用链、已保存工具证据、测试/dev 库只读查询验证的信息，都必须先自主核实；只有所有可用路径都核实完仍无法回答，才允许对用户提问。触发 Human Loop 前必须在 context_snapshot.known_facts 写清已核实节点、已分析代码范围、已尝试 SQL/工具/检索条件和剩余最小缺口。
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

      if (isStreamPauseResume) {
        startTodoItem(runtimeTodoList, "planner_checked");
        completeTodoItem(runtimeTodoList, "planner_checked", "stream pause resume: skipped planner/prelude to avoid restarting from head");
        if (typeof effectiveParsedContent === 'string') {
          finalContentForPrompt = `${runtimeTodoInstruction}\n\n${flowControlInstruction}\n\n${buildStreamPauseResumeRuntimeInstruction()}\n\n${effectiveParsedContent}`;
        } else if (Array.isArray(effectiveParsedContent)) {
          finalContentForPrompt = [
            { type: 'text', text: `${runtimeTodoInstruction}\n\n${flowControlInstruction}\n\n${buildStreamPauseResumeRuntimeInstruction()}\n\n` },
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
            await sendStageProgress("已完成问题规划，正在整理检索词和候选方向，继续核实中。", true);
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

      // 记录流式过程中的所有消息，用于容错恢复
      try {
        if (shouldUseDirectEvidenceFastPath(currentQuestion)) {
          startTodoItem(runtimeTodoList, "tools_loaded");
          completeTodoItem(runtimeTodoList, "tools_loaded", "direct evidence fast path: skipped MCP tool loading");
          startTodoItem(runtimeTodoList, "analysis_finished");
          const businessPrompt = await getBusinessPrompt(plannerResult);
          const baseModel = await getBaseModel();
          const fastPathResponse = await baseModel.invoke([
            new SystemMessage(`${businessPrompt}\n\n${buildDirectEvidenceFastPathInstruction()}`),
            new HumanMessage(typeof finalContentForPrompt === "string" ? finalContentForPrompt : currentQuestion),
          ]);
          fullContent = ensureRecoverySqlAuditMarker(String(fastPathResponse.content || ""));
          completeTodoItem(runtimeTodoList, "analysis_finished", `direct evidence fast path contentLength=${fullContent.length}`);
        } else {
        startTodoItem(runtimeTodoList, "tools_loaded");
        await sendStageProgress("正在加载 MCP 工具和项目范围，继续核实中。", true);
        const sessionMcpHeaderOverrides = sessionManager.resolveMcpHeaders(sessionKey);
        const defaultMcpHeaderCommand = botConfig.defaultMcpHeaderCommand
          ? resolveMcpHeaderCommand(botConfig.defaultMcpHeaderCommand, config.mcpServers)
          : null;
        const mcpHeaderOverrides = Object.keys(sessionMcpHeaderOverrides).length > 0
          ? sessionMcpHeaderOverrides
          : defaultMcpHeaderCommand?.headersByServer ?? {};
        const tools = await getAllMcpTools(botConfig, mcpHeaderOverrides);
        const defaultRepoHints = extractProjectsFromMcpHeaders(mcpHeaderOverrides);
        const explicitRepoHints = extractExplicitRepoHints(
          textToPlan,
          Array.from(new Set([...extractMcpProjectCandidates(config.mcpServers), ...defaultRepoHints]))
        );
        repoHints = sessionManager.resolveRepoHints(sessionKey, explicitRepoHints, defaultRepoHints);
        const scopedEvidenceTools = scopeToolsToRepo(tools, repoHints);
        syncRuntimeAuditTodoPlan(runtimeTodoList, {
          question: currentQuestion,
          repoHints,
          ...(plannerResult?.intent ? { plannerIntent: plannerResult.intent } : {}),
          ...(plannerResult?.secondary_intents ? { secondaryIntents: plannerResult.secondary_intents } : {}),
        });
        const agentTools = [
          ...scopedEvidenceTools,
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
        ];
        completeTodoItem(runtimeTodoList, "tools_loaded", `tools=${agentTools.length}, repoHints=${repoHints.join(",") || "none"}`);
        await sendStageProgress("已加载可用工具，正在判断是否需要预检索，继续核实中。", true);

        if (!isStreamPauseResume && !hasDirectEvidence && plannerResult && textToPlan.trim().length > 0) {
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
        const agent = await initializeAgent(agentTools, plannerResult);
        await sendStageProgress("业务分析节点已启动，正在调用模型和工具核实证据，继续核实中。", true);
        const stream = await agent.stream({
          messages: buildMessagesForCurrentTurn({
            sessionMessages: session.messages,
            userContent: finalContentForPrompt,
            repoHint: repoHints,
          }),
        }, {
          recursionLimit: config.llm.recursionLimit,
          streamMode: "messages",
        });

        const agentProgressGuard = createAgentProgressGuard({
          maxToolResults: getMaxAgentToolResultsPerTurn(),
        });
        // 工具调用累加器：用于聚合流式的 tool_call_chunks
        for await (const [message, metadata] of stream) {
            const streamMetadata = metadata as AgentStreamMetadata | undefined;
            if (shouldStopCurrentTask()) {
              fullContent = "";
              break;
            }
            if (streamMetadata?.answerReview?.resetContent) {
              fullContent = "";
            }
            if (streamMetadata?.flowControl) {
              applyFlowControlPatch(streamMetadata.flowControl);
            }
            if (streamMetadata?.answerReview?.progress) {
              await sendStageProgress(message.content.toString(), true);
              continue;
            }
            const msg = message as BaseMessage;
            intermediateMessages.push(msg); // 记录中间过程

            const type = (msg as any)._getType?.() || msg.constructor.name;

            // 处理工具执行结果：记录完整调用日志
            if (type === "tool" || type === "ToolMessage") {
              const toolMsg = msg as any;
              const id = toolMsg.tool_call_id;
              const entry = toolCallMap.get(id);
              if (entry) {
                entry.completed = true;
                const toolRecord = {
                  id,
                  name: entry.name || "unknown_tool",
                  args: entry.args,
                  content: String(toolMsg.content),
                };
                toolContextRecords.push(toolRecord);
                toolMsg.content = filterToolResultForCurrentTurn(toolRecord);
                console.log(`[Tool Call Success] Name: ${entry.name}, Args: ${entry.args}, Result Size: ${String(toolMsg.content).length}`);
                const guardDecision = agentProgressGuard.recordToolResult(toolRecord);
                if (guardDecision.shouldStop) {
                  throw createAgentProgressLimitError(guardDecision.reason);
                }
              }
              continue;
            }

            if (type === "ai" || type === "AIMessage" || type === "AIMessageChunk") {
              const aiMsg = msg as any; // Cast to any to handle both AIMessage and AIMessageChunk

              // 处理工具调用：记录日志并发送状态反馈给企微
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

                  // 聚合当前所有正在活跃的调用（名字已知且未完成）
                  const activeCalls = getActiveToolCalls();

                  if (activeCalls.length > 0) {
                    const statusMsg = buildProgressStreamContent(fullContent, activeCalls);

                    // 节流推送：避免高频更新导致前端闪烁
                    if (Date.now() - lastUpdateTime > 1000) {
                      if (!shouldStopCurrentTask()) {
                        await safeReplyStream(statusMsg, false);
                      }
                      lastUpdateTime = Date.now();
                    }
                  }
                }
                continue;
              } else if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
                  // 回退逻辑：如果模型非流式返回，直接使用 tool_calls
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
                const extractedDelta = consumeFlowControlDelta(stripEmptyProtocolContent(aiMsg.content.toString()), flowControlStreamState);
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

        // 最终检查：记录那些可能未返回 ToolMessage 的调用
        for (const [id, entry] of toolCallMap.entries()) {
          if (!entry.completed && entry.name) {
            console.log(`[Tool Call Pending/Final] Name: ${entry.name}, Args: ${entry.args}`);
          }
        }
        completeTodoItem(runtimeTodoList, "analysis_finished", `contentLength=${fullContent.length}, toolResults=${toolContextRecords.length}`);
        }

      } catch (err: any) {
        console.error(`Agent execution error for ${body.msgid}:`, err);
        blockTodoItem(runtimeTodoList, "analysis_finished", err instanceof Error ? err.message : String(err));
        
        // 特别处理递归超限错误 (GRAPH_RECURSION_LIMIT)
        if (err.lc_error_code === 'GRAPH_RECURSION_LIMIT' || err.lc_error_code === 'AGENT_TOOL_PROGRESS_LIMIT' || err.message?.includes('Recursion limit')) {
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
            fullContent = ensureRecoverySqlAuditMarker(recoveryResponse.content.toString());
            recoveryAuditReason = err.lc_error_code === "AGENT_TOOL_PROGRESS_LIMIT"
              ? "工具调用达到进展守卫上限后的恢复总结"
              : "LangGraph 递归上限后的恢复总结";
            completeTodoItem(runtimeTodoList, "analysis_finished", `recovery contentLength=${fullContent.length}`);
          } catch (recoveryErr) {
            console.error(`Recovery synthesis failed for ${body.msgid}:`, recoveryErr);
            fullContent = fullContent || "抱歉，由于问题过于复杂且处理达到限制，我暂时无法给出完整回答。您可以尝试缩小查询范围。";
            completeTodoItem(runtimeTodoList, "analysis_finished", "recovery failed, sent bounded fallback");
          }
        } else {
          fullContent = fullContent || "抱歉，处理您的请求时遇到了意外错误，请稍后重试。";
          completeTodoItem(runtimeTodoList, "analysis_finished", "agent error, sent bounded fallback");
        }
      }

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
        if (humanLoopRequest) {
          const storedRequest = toStoredHumanLoopRequest(humanLoopRequest, body.msgid);
          sessionManager.setPendingHumanLoop(sessionKey, storedRequest);
          fullContent = buildHumanLoopReply(storedRequest);
        } else if (activePendingHumanLoop) {
          sessionManager.clearPendingHumanLoop(sessionKey);
        }

        await sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: effectiveParsedContent as any }),
          ...(buildToolContextSummary(toolContextRecords)
            ? [new SystemMessage(buildToolContextSummary(toolContextRecords))]
            : []),
          new AIMessage(fullContent),
        ]);
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
      const incompleteAuditItems = getIncompleteAuditTodoItems(runtimeTodoList);
      const auditPassed = incompleteAuditItems.length === 0;
      if (!auditPassed) {
        const auditFailureMessage = buildIncompleteAuditTodoMessage(incompleteAuditItems);
        console.error(`[${botConfig.name}] Runtime TodoList audit incomplete for ${body.msgid}: ${summarizeTodoList(runtimeTodoList)}\n${auditFailureMessage}`);
        const auditFallbackModel = await getBaseModel();
        fullContent = await generateUserFacingAuditFallbackMessage({
          question: currentQuestion,
          items: incompleteAuditItems,
          model: auditFallbackModel,
        });
      }

      startTodoItem(runtimeTodoList, "final_checked");
      if (isFinalAnswerReady(fullContent)) {
        completeTodoItem(runtimeTodoList, "final_checked", `finalLength=${fullContent.trim().length}`);
      } else {
        // 兜底：LLM 未走 human_loop JSON 协议，但输出的是提问/澄清类内容，
        // 转成 Human Loop 暂停等用户补充，而不是追加 notice 直接发送终止。
        const clarificationRequest = detectClarificationContent(fullContent, currentQuestion);
        if (clarificationRequest) {
          console.log(`[${botConfig.name}] Clarification content detected without human_loop protocol, converting to Human Loop for ${body.msgid}`);
          const storedClarification = toStoredHumanLoopRequest(clarificationRequest, body.msgid);
          sessionManager.setPendingHumanLoop(sessionKey, storedClarification);
          fullContent = buildHumanLoopReply(storedClarification);
          completeTodoItem(runtimeTodoList, "final_checked", "converted clarification content to human loop");
        } else {
          console.error(`[${botConfig.name}] Runtime TodoList blocked for ${body.msgid}: ${summarizeTodoList(runtimeTodoList)}`);
          fullContent = appendIncompleteFinalNotice(fullContent);
          completeTodoItem(runtimeTodoList, "final_checked", "sent incomplete-answer notice with preserved content");
        }
      }
      if (auditPassed) {
        assertTodoListComplete(runtimeTodoList);
        console.log(`[${botConfig.name}] Runtime TodoList completed for ${body.msgid}: ${summarizeTodoList(runtimeTodoList)}`);
      }
      stopThinkingHeartbeat();
      if (!shouldStopCurrentTask()) {
        await safeReplyStream(fullContent || "未获取到有效回复", true);
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
  bot.on("authenticated", () => console.log(`[${botConfig.name}] WeCom Authentication successful.`));
  bot.on("error", (err) => console.error(`[${botConfig.name}] WeCom WebSocket error:`, err));

  bot.connect();
  const contextWindow = getModelContextWindow();
  console.log(`[${botConfig.name}] WeCom Bot starting... Model: ${config.llm.modelName}, Recursion Limit: ${config.llm.recursionLimit}, Context Window: ${contextWindow} tokens`);
}

export async function startBots() {
  await Promise.all(config.bots.map(botConfig => startBot(botConfig)));
}
