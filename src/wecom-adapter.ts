import { WSClient, MessageType } from "@wecom/aibot-node-sdk";
import { initializeAgent, runPlanner, getModelContextWindow, getBaseModel, getBusinessPrompt } from "./graph.js";
import { config } from "./config.js";
import { HumanMessage, AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { sessionManager } from "./session-manager.js";
import { fetchImageAsBase64, downloadMediaFile } from "./media-helper.js";

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

export async function startBot() {
  const bot = new WSClient({
    botId: config.WECOM_BOT_ID,
    secret: config.WECOM_BOT_SECRET,
    wsUrl: config.WECOM_WS_URL, 
  });

  // 用于消息去重的简单缓存（在多实例部署时建议改用 Redis）
  const processedMsgs = new Set<string>();
  const MAX_CACHE_SIZE = 1000;

  // 监听所有消息类型
  bot.on("message", async (frame) => {
    const { body } = frame;
    if (!body || !body.msgid) return;
    
    // 1. 消息去重，防止企业微信重试导致重复处理
    if (processedMsgs.has(body.msgid)) {
      console.log(`[Deduplication] Message ${body.msgid} already processed, skipping.`);
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
    const session = sessionManager.getOrCreateSession(sessionKey);

    // Handle /new command
    const isNewCommand =
      typeof parsedContent === "string" &&
      parsedContent.trim().toLowerCase() === "/new";

    if (isNewCommand) {
      sessionManager.clearSession(sessionKey);
      processedMsgs.add(body.msgid); // Mark this message as processed
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
    // --- Session Handling End ---

    try {
      const streamId = body.msgid;

      // 发送初始进度卡片
      await bot.replyStreamWithCard(frame, streamId, "AI 正在思考中...", false, {
        templateCard: {
          card_type: 'text_notice',
          main_title: { title: '任务处理中', desc: 'AI 助手正在分析您的请求...' },
          task_id: `task_${body.msgid}`,
        }
      });

      let fullContent = "";
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL = 2000;

      // --- Planner Logic Start ---
      let finalContentForPrompt: any = parsedContent;
      if (typeof parsedContent === 'string' && parsedContent.trim().length > 0) {
        try {
          const plannerResult = await runPlanner(parsedContent);
          if (plannerResult) {
            // 提供结构化的搜索建议，引导大模型按 MCP 要求进行高效率查询
            const searchPlanHint = `系统提示：【搜索规划建议】
请根据以下优化后的 Query 进行单次一站式搜索，严禁对关键词进行拆分循环搜索。
1. 关键词合并 (推荐): ${plannerResult.combined}
2. 逻辑或 (备选): ${plannerResult.regex}`;
            
            finalContentForPrompt = `${searchPlanHint}\n\n${parsedContent}`;
          }
        } catch (err) {
          console.error("Planner execution failed:", err);
        }
      }
      // --- Planner Logic End ---

      // 记录流式过程中的所有消息，用于容错恢复
      let intermediateMessages: BaseMessage[] = [];

      try {
        const agent = await initializeAgent();
        const stream = await agent.stream({
          messages: [...session.messages, new HumanMessage({ content: finalContentForPrompt as any })],
        }, {
          recursionLimit: config.LLM_RECURSION_LIMIT,
          streamMode: "messages",
        });

        for await (const [message, metadata] of stream) {
          const msg = message as BaseMessage;
          intermediateMessages.push(msg); // 记录中间过程
          
          const type = (msg as any)._getType?.() || msg.constructor.name;
          
          if (type === "ai" || type === "AIMessage" || type === "AIMessageChunk") {
            const aiMsg = msg as any; // Cast to any to handle both AIMessage and AIMessageChunk
            
            // 处理工具调用：记录日志并发送状态反馈给企微
            // 在流式返回中，使用 tool_call_chunks 来获取增量的工具调用信息
            if (aiMsg.tool_call_chunks && aiMsg.tool_call_chunks.length > 0) {
              for (const chunk of aiMsg.tool_call_chunks) {
                // 只在首次出现 tool name 的 chunk 时打印日志和发送提示，避免重复刷屏
                if (chunk.name) {
                  console.log(`[Tool Call Started] Name: ${chunk.name}, ID: ${chunk.id}`);
                  
                  // 给企微发送一个友好的状态提示
                  const statusMsg = fullContent 
                    ? `${fullContent}\n\n> 🔍 正在调用: ${chunk.name}...` 
                    : `> 🔍 正在调用: ${chunk.name}...`;
                  
                  await bot.replyStream(frame, streamId, statusMsg, false);
                } else if (chunk.args) {
                   // 可选：在这里记录参数增量，如果需要的话
                   // console.log(`[Tool Call Args Delta] ${chunk.args}`);
                }
              }
              continue;
            } else if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
                // 回退逻辑：如果模型非流式返回，直接使用 tool_calls
                for (const tool of aiMsg.tool_calls) {
                  if (!tool.name) continue;
                  console.log(`[Tool Call] Name: ${tool.name}, Args: ${JSON.stringify(tool.args)}`);
                  const statusMsg = fullContent 
                    ? `${fullContent}\n\n> 🔍 正在调用: ${tool.name}...` 
                    : `> 🔍 正在调用: ${tool.name}...`;
                  await bot.replyStream(frame, streamId, statusMsg, false);
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
                  await bot.replyStream(frame, streamId, fullContent, false);
                  lastUpdateTime = Date.now();
                }
              }
            }
          }
        }
      } catch (err: any) {
        console.error(`Agent execution error for ${body.msgid}:`, err);
        
        // 特别处理递归超限错误 (GRAPH_RECURSION_LIMIT)
        if (err.lc_error_code === 'GRAPH_RECURSION_LIMIT' || err.message?.includes('Recursion limit')) {
          try {
            console.log(`[Recovery] Recursion limit reached for ${body.msgid}, attempting fallback synthesis...`);
            const baseModel = await getBaseModel();
            const businessPrompt = await getBusinessPrompt();

            // 构造恢复提示词：将已有的所有中间历史（包括工具调用和结果）发给不带 tools 的大模型进行总结
            const recoveryMessages = [
              new SystemMessage(`${businessPrompt}\n\n注意：当前任务由于逻辑过于复杂已达到执行上限。请根据下述已有的中间查询结果（包括已调用的工具返回），尽可能为用户提供一个阶段性的总结回答。如果关键信息不足，请明确告知已查到的部分，并指引用户如何提供更精确的信息以继续。`),
              ...session.messages,
              new HumanMessage({ content: finalContentForPrompt as any }),
              ...intermediateMessages
            ];

            const recoveryResponse = await baseModel.invoke(recoveryMessages);
            fullContent = recoveryResponse.content.toString();
          } catch (recoveryErr) {
            console.error(`Recovery synthesis failed for ${body.msgid}:`, recoveryErr);
            fullContent = fullContent || "抱歉，由于问题过于复杂且处理达到限制，我暂时无法给出完整回答。您可以尝试缩小查询范围。";
          }
        } else {
          fullContent = fullContent || "抱歉，处理您的请求时遇到了意外错误，请稍后重试。";
        }
      }

      // --- Update Session History ---
      if (fullContent) {
        sessionManager.addMessages(sessionKey, [
          new HumanMessage({ content: parsedContent as any }),
          new AIMessage(fullContent),
        ]);
      }

      // 发送最终结果
      await bot.replyStream(
        frame,
        streamId,
        fullContent || "未获取到有效回复",
        true
      );
    } catch (error) {
      console.error(`Outer error processing message ${body.msgid}:`, error);
    }
  });

  bot.on("connected", () => console.log("WeCom WebSocket connected."));
  bot.on("authenticated", () => console.log("WeCom Authentication successful."));
  bot.on("error", (err) => console.error("WeCom WebSocket error:", err));

  bot.connect();
  const contextWindow = getModelContextWindow();
  console.log(`WeCom Bot starting... Model: ${config.LLM_MODEL_NAME}, Recursion Limit: ${config.LLM_RECURSION_LIMIT}, Context Window: ${contextWindow} tokens`);
}
