import { WSClient, MessageType, generateReqId } from "@wecom/aibot-node-sdk";
import { initializeAgent, runPlanner, runSearchLoopPrelude, getModelContextWindow, getBaseModel, getBusinessPrompt, extractExplicitRepoHints, extractMcpProjectCandidates, buildMessagesForCurrentTurn, scopeToolsToRepo } from "./graph.js";
import { config, type BotConfig } from "./config.js";
import { HumanMessage, AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { sessionManager } from "./session-manager.js";
import { fetchImageAsBase64, downloadMediaFile } from "./media-helper.js";
import { getAllMcpTools } from "./mcp-client.js";
import {
  buildHumanLoopReply,
  buildHumanLoopResumeContent,
  detectHumanLoopRequest,
  isAmbiguousNewTopicWhilePending,
  isHumanLoopExpired,
  toStoredHumanLoopRequest,
} from "./human-loop.js";
import { buildProgressStreamContent, buildThinkingHeartbeatContent, collapseProgressUpdates } from "./progress-updates.js";
import { isStreamExpired, isWeComReplyAckTimeoutError, isWeComStreamExpiredError, STREAM_EXPIRED_MESSAGE } from "./stream-ttl.js";
import { buildToolContextSummary, filterToolResultForCurrentTurn, type ToolContextRecord } from "./tool-context-filter.js";
import {
  buildFollowupQuestion,
  buildQuestionWithHistory,
  classifyHistoryRelevance,
  detectActiveMessageIntent,
  type ConversationContextItem,
} from "./interaction-control.js";
import {
  applySqlAuditEvidence,
  assertTodoListComplete,
  blockTodoItem,
  buildIncompleteAuditTodoMessage,
  buildRuntimeTodoTool,
  buildSqlAuditEvidence,
  completeTodoItem,
  createRuntimeTodoList,
  getIncompleteAuditTodoItems,
  isFinalAnswerReady,
  startTodoItem,
  summarizeTodoList,
} from "./runtime-todolist.js";

interface ActiveTaskState {
  msgid: string;
  cancelled: boolean;
  question: string;
}

const THINKING_HEARTBEAT_INTERVAL_MS = 15000;

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

export function buildHelpReply() {
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
    "",
    "4. 继续或停止",
    "任务处理中发送“继续”可确认继续等待；发送“停止”可取消当前任务。",
    "",
    "5. SQL 参数",
    "如果需要 SQL，我会把需要你填写的参数统一放在 SQL 最前面的变量区，并用一句话列出需要提供的信息。",
  ].join("\n");
}

/**
 * 将企业微信消息解析为智能体可理解的文本描述或多模态内容
 */
export async function parseWeComMessage(body: any, bot: WSClient): Promise<string | { type: string; text?: string; image_url?: { url: string } | string }[]> {
  const msgType = body.msgtype;
  const fromUser = body.from?.userid || "unknown";
  
  // 1. 解析主消息内容
  let mainItems: any[] = [];
  switch (msgType) {
    case MessageType.Text:
      mainItems.push({ type: "text", text: body.text.content });
      break;

    case MessageType.Image:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一张图片]` });
      const b64Image = await fetchImageAsBase64(bot, body.image?.url, body.image?.aeskey);
      mainItems.push({ type: "image_url", image_url: { url: b64Image } });
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
      for (const item of items) {
        if (item.msgtype === "text") {
          mainItems.push({ type: "text", text: item.text?.content });
        } else if (item.msgtype === "image") {
          const b64 = await fetchImageAsBase64(bot, item.image?.url, item.image?.aeskey);
          mainItems.push({ type: "image_url", image_url: { url: b64 } });
        }
      }
      break;

    default:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了未处理的消息类型: ${msgType}]` });
      break;
  }

  // 2. 解析引用内容 (Quote)
  let quoteItems: any[] = [];
  if (body.quote) {
    const qType = body.quote.msgtype;
    if (qType === "text") {
      quoteItems.push({ type: "text", text: body.quote.text?.content });
    } else if (qType === "image") {
      const b64QuoteImg = await fetchImageAsBase64(bot, body.quote.image?.url, body.quote.image?.aeskey);
      quoteItems.push({ type: "image_url", image_url: { url: b64QuoteImg } });
    } else if (qType === "mixed") {
      const qMixedItems = body.quote.mixed?.msg_item || [];
      for (const item of qMixedItems) {
        if (item.msgtype === "text") {
          quoteItems.push({ type: "text", text: item.text?.content });
        } else if (item.msgtype === "image") {
          const b64QuoteMixedImg = await fetchImageAsBase64(bot, item.image?.url, item.image?.aeskey);
          quoteItems.push({ type: "image_url", image_url: { url: b64QuoteMixedImg } });
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

    const parsedContent = await parseWeComMessage(body, bot);
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
    let followupQuestion = "";

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

    let effectiveParsedContent: typeof parsedContent = parsedContent;
    const pendingHumanLoop = sessionManager.getPendingHumanLoop(sessionKey);
    const pendingText = stripBoundaryMentions(commandText);
    const activePendingHumanLoop = pendingHumanLoop && !isHumanLoopExpired(pendingHumanLoop)
      ? pendingHumanLoop
      : undefined;

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
      const streamId = generateReqId("stream");
      const streamStartedAt = Date.now();
      const currentQuestion = typeof effectiveParsedContent === "string"
        ? stripBoundaryMentions(effectiveParsedContent)
        : extractTextContent(effectiveParsedContent as any);
      const currentTask: ActiveTaskState = { msgid: body.msgid, cancelled: false, question: currentQuestion };
      activeTasks.set(sessionKey, currentTask);
const runtimeTodoList = createRuntimeTodoList();
      startTodoItem(runtimeTodoList, "message_parsed");
      completeTodoItem(runtimeTodoList, "message_parsed", `msgid=${body.msgid}, type=${body.msgtype}`);

      // 发送初始进度卡片
      await bot.replyStreamWithCard(frame, streamId, "AI 正在思考中...", false, {
        templateCard: {
          card_type: 'text_notice',
          main_title: { title: '任务处理中', desc: 'AI 助手正在分析您的请求...' },
          task_id: `task_${body.msgid}`,
        }
      });

      const shouldStopCurrentTask = () => activeTasks.get(sessionKey) !== currentTask || currentTask.cancelled;

      let fullContent = "";
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL = 2000;
      let expiredStreamFinalSent = false;
      let expiredStreamHistorySaved = false;
      let replyAckTimeoutReconnectTriggered = false;
      let replyStreamQueue = Promise.resolve();
      const saveExpiredStreamHistory = async () => {
        if (expiredStreamHistorySaved) return;
        expiredStreamHistorySaved = true;
        await sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: effectiveParsedContent as any }),
          new AIMessage(STREAM_EXPIRED_MESSAGE),
        ]);
      };
      const safeReplyStreamNow = async (content: string, final = false) => {
        if (shouldStopCurrentTask()) return false;
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
          await bot.replyStream(frame, streamId, content, final);
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

      // --- Planner Logic Start ---
      let finalContentForPrompt: any = effectiveParsedContent;
      let plannerResult = null;
      const runtimeTodoInstruction = `系统提示：【运行时 TodoList 工具要求】
当前回答必须使用工具 runtime_todolist_update 维护审核 TodoList。
在最终回答前，必须分别调用该工具并将以下 itemId 标记为 done：
1. project_scope_audited：审核代码包、仓库、项目和用户目标范围一致性；不涉及代码范围时 evidence 写“不适用”及原因。
2. sql_correctness_audited：审核 SQL 完整性、只读性、表名字段名、dev 执行校验；若 dev 库无对应表，evidence 必须写“dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构”。
3. evidence_audited：审核核心结论证据、字段语义和查询收敛。
4. execution_flow_audited：审核接口链路、缺失日志、未触达下游、回调、MQ、外部系统推送或状态流转的执行链完整性；不涉及此类问题时 evidence 写“不涉及接口链路/下游触达/状态流转”及原因。
5. owner_contact_audited：审核建议处理中是否需要提示联系相关开发人员；涉及代码缺陷、配置异常、流程实现、历史逻辑归属或需要推动修复时，必须说明已给出联系开发人员建议；如果工具列表存在 git_author_trace，只能基于最终结论实际引用的仓库、文件、方法、代码片段、symbol uid 或接口入口追溯联系人，不得使用最终未引用的候选文件，并按“与最终结论最相关的修改优先、同等相关时最新修改优先”选择开发人员线索。
6. final_format_audited：审核过程标签和最终结论分离。
没有证据时必须调用 runtime_todolist_update 将对应 itemId 标记为 blocked，不得直接输出最终结论。`;

      // 提取文本内容进行 Planner 分析
      let textToPlan = "";
      if (typeof effectiveParsedContent === 'string') {
        textToPlan = stripBoundaryMentions(effectiveParsedContent);
      } else if (Array.isArray(effectiveParsedContent)) {
        const textItem = effectiveParsedContent.find(i => i.type === 'text');
        if (textItem) textToPlan = stripBoundaryMentions(textItem.text || "");
      }

      if (textToPlan.trim().length > 0) {
        try {
          startTodoItem(runtimeTodoList, "planner_checked");
          await sendStageProgress("已收到问题，正在识别意图和检索锚点，继续核实中。", true);
          plannerResult = await runPlanner(textToPlan);
          if (plannerResult) {
            completeTodoItem(runtimeTodoList, "planner_checked", `intent=${plannerResult.intent || "unknown"}`);
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
* GitNexus query 成本较高，必须合并查询条件：把项目、核心业务词、动作词、接口/文件锚点尽量放入一次 query/zoekt；同一问题原则上不超过 2 次 query，命中候选文件后改用 code_snippet/context 或已有证据回答。
* 严禁拆分关键词进行多次循环搜索。${smsTemplateEvidenceHint}`;
            
            if (typeof effectiveParsedContent === 'string') {
              finalContentForPrompt = `${runtimeTodoInstruction}\n\n${searchPlanHint}\n\n${effectiveParsedContent}`;
            } else if (Array.isArray(effectiveParsedContent)) {
              finalContentForPrompt = [
                { type: 'text', text: `${runtimeTodoInstruction}\n\n${searchPlanHint}\n\n` },
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
          : `${runtimeTodoInstruction}\n\n${finalContentForPrompt}`;
      } else if (Array.isArray(finalContentForPrompt)) {
        const hasInstruction = finalContentForPrompt.some(item => item.type === "text" && item.text?.includes("runtime_todolist_update"));
        if (!hasInstruction) {
          finalContentForPrompt = [
            { type: "text", text: `${runtimeTodoInstruction}\n\n` },
            ...finalContentForPrompt,
          ];
        }
      }
      // --- Planner Logic End ---

      // 记录流式过程中的所有消息，用于容错恢复
      let intermediateMessages: BaseMessage[] = [];
      const toolContextRecords: ToolContextRecord[] = [];
      let repoHints: string[] = [];

      try {
        startTodoItem(runtimeTodoList, "tools_loaded");
        await sendStageProgress("正在加载 MCP 工具和项目范围，继续核实中。", true);
        const tools = await getAllMcpTools(botConfig);
        const explicitRepoHints = extractExplicitRepoHints(
          textToPlan,
          extractMcpProjectCandidates(config.mcpServers)
        );
        repoHints = sessionManager.resolveRepoHints(sessionKey, explicitRepoHints);
        const agentTools = [
          ...scopeToolsToRepo(tools, repoHints),
          buildRuntimeTodoTool(runtimeTodoList),
        ];
        completeTodoItem(runtimeTodoList, "tools_loaded", `tools=${agentTools.length}, repoHints=${repoHints.join(",") || "none"}`);
        await sendStageProgress("已加载可用工具，正在判断是否需要预检索，继续核实中。", true);

        if (plannerResult && textToPlan.trim().length > 0) {
          await sendStageProgress("正在执行预检索以缩小证据范围，继续核实中。", true);
          const prelude = await runSearchLoopPrelude({
            userQuestion: textToPlan,
            plannerResult,
            tools,
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

        // 工具调用累加器：用于聚合流式的 tool_call_chunks
        const toolCallMap = new Map<string, { name: string; args: string; notified: boolean; completed: boolean }>();
        const getActiveToolCalls = () => Array.from(toolCallMap.values())
          .filter(c => c.name && !c.completed)
          .map(c => `> 🔍 正在调用: ${getToolDisplay(c.name, c.args)}...`);
        let heartbeatInFlight = false;
        let lastHeartbeatTime = 0;
        const heartbeatTimer = setInterval(() => {
          if (heartbeatInFlight || shouldStopCurrentTask()) return;
          const now = Date.now();
          if (now - lastUpdateTime < THINKING_HEARTBEAT_INTERVAL_MS) return;
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
        try {
          for await (const [message, metadata] of stream) {
            if (shouldStopCurrentTask()) {
              fullContent = "";
              break;
            }
            if ((metadata as any)?.answerReview?.resetContent) {
              fullContent = "";
            }
            if ((metadata as any)?.answerReview?.progress) {
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
                const delta = aiMsg.content.toString();
                if (delta.length > 0) {
                  if (fullContent && delta.startsWith(fullContent)) {
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
        } finally {
          clearInterval(heartbeatTimer);
        }

        // 最终检查：记录那些可能未返回 ToolMessage 的调用
        for (const [id, entry] of toolCallMap.entries()) {
          if (!entry.completed && entry.name) {
            console.log(`[Tool Call Pending/Final] Name: ${entry.name}, Args: ${entry.args}`);
          }
        }
        completeTodoItem(runtimeTodoList, "analysis_finished", `contentLength=${fullContent.length}, toolResults=${toolContextRecords.length}`);

      } catch (err: any) {
        console.error(`Agent execution error for ${body.msgid}:`, err);
        blockTodoItem(runtimeTodoList, "analysis_finished", err instanceof Error ? err.message : String(err));
        
        // 特别处理递归超限错误 (GRAPH_RECURSION_LIMIT)
        if (err.lc_error_code === 'GRAPH_RECURSION_LIMIT' || err.message?.includes('Recursion limit')) {
          try {
            console.log(`[${botConfig.name}] [Recovery] Recursion limit reached for ${body.msgid}, attempting fallback synthesis...`);
            const baseModel = await getBaseModel();
            const businessPrompt = await getBusinessPrompt(plannerResult);

            // 构造恢复提示词：将已有的所有中间历史（包括工具调用和结果）发给不带 tools 的大模型进行总结
            const recoveryMessages = [
              new SystemMessage(`${businessPrompt}\n\n注意：当前任务由于逻辑过于复杂已达到执行上限。请根据下述已有的中间查询结果（包括已调用的工具返回），尽可能为用户提供一个阶段性的总结回答。如果关键信息不足，请明确告知已查到的部分，并指引用户如何提供更精确的信息以继续。`),
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
            fullContent = recoveryResponse.content.toString();
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

        await sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: effectiveParsedContent as any }),
          ...(buildToolContextSummary(toolContextRecords)
            ? [new SystemMessage(buildToolContextSummary(toolContextRecords))]
            : []),
          new AIMessage(fullContent),
        ]);
      }

      // 发送最终结果
      fullContent = collapseProgressUpdates(fullContent);
      const sqlAuditEvidence = buildSqlAuditEvidence(fullContent, toolContextRecords);
      applySqlAuditEvidence(runtimeTodoList, sqlAuditEvidence);
      const incompleteAuditItems = getIncompleteAuditTodoItems(runtimeTodoList);
      const auditPassed = incompleteAuditItems.length === 0;
      if (!auditPassed) {
        console.error(`[${botConfig.name}] Runtime TodoList audit incomplete for ${body.msgid}: ${summarizeTodoList(runtimeTodoList)}`);
        fullContent = buildIncompleteAuditTodoMessage(incompleteAuditItems);
      }

      startTodoItem(runtimeTodoList, "final_checked");
      if (isFinalAnswerReady(fullContent)) {
        completeTodoItem(runtimeTodoList, "final_checked", `finalLength=${fullContent.trim().length}`);
      } else {
        console.error(`[${botConfig.name}] Runtime TodoList blocked for ${body.msgid}: ${summarizeTodoList(runtimeTodoList)}`);
        fullContent = "抱歉，本次回答还停留在阶段性处理中，未能形成可发送的最终结论。请缩小问题范围或稍后重试。";
        completeTodoItem(runtimeTodoList, "final_checked", "sent incomplete-answer fallback");
      }
      if (auditPassed) {
        assertTodoListComplete(runtimeTodoList);
        console.log(`[${botConfig.name}] Runtime TodoList completed for ${body.msgid}: ${summarizeTodoList(runtimeTodoList)}`);
      }
      if (!shouldStopCurrentTask()) {
        await safeReplyStream(fullContent || "未获取到有效回复", true);
      }
      if (activeTasks.get(sessionKey) === currentTask) {
        activeTasks.delete(sessionKey);
      }
    } catch (error) {
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
