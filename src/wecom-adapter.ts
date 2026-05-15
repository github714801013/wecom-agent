import { WSClient, MessageType } from "@wecom/aibot-node-sdk";
import { runClaudeAgent, getBaseModel, getSystemPrompt, getModelContextWindow } from "./graph.js";
import { config } from "./config.js";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
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

      // Construct history text for Claude SDK context
      const historyText = session.messages.map(m => {
        const type = (m as any)._getType?.() || m.constructor.name;
        if (type === 'human' || type === 'HumanMessage') {
          return `用户：${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
        }
        if (type === 'ai' || type === 'AIMessage') {
          return `助手：${m.content as string}`;
        }
        return null;
      }).filter((m): m is string => m !== null).join("\n\n");

      const currentText = typeof parsedContent === 'string' ? parsedContent : JSON.stringify(parsedContent);
      const prompt = historyText
        ? `以下是本会话历史，请结合上下文回答最后一个用户问题。\n\n${historyText}\n\n用户：${currentText}`
        : currentText;

      try {
        const stream = runClaudeAgent(prompt, sessionKey);

        for await (const chunk of stream) {
          if (chunk.type === "stream_event") {
            const event = chunk.event;
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              const text = event.delta.text;
              
              // 忽略可能的工具调用标签
              if (text.includes('<tool_code>') || text.includes('</tool_code>')) {
                continue;
              }
              
              fullContent += text;

              if (Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
                await bot.replyStream(frame, streamId, fullContent, false);
                lastUpdateTime = Date.now();
              }
            }
          } else if (chunk.type === "assistant" && !fullContent) {
            // Fallback for non-streaming models or final message if stream was missed
            if (chunk.message.content) {
                const textContent = chunk.message.content.find((c: any) => c.type === 'text');
                if (textContent) {
                  fullContent = (textContent as any).text;
                }
            }
          }
        }
      } catch (err: any) {
        console.error(`Agent execution error for ${body.msgid}:`, err);
        fullContent = fullContent || "抱歉，处理您的请求时遇到了意外错误，请稍后重试。";
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
  console.log(`WeCom Bot starting... Model: ${config.LLM_MODEL_NAME}, Context Window: ${contextWindow} tokens`);
}
