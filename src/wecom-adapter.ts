import { WSClient, MessageType, generateReqId } from "@wecom/aibot-node-sdk";
import { initializeAgent, getBaseModel, getSystemPrompt, getModelContextWindow } from "./graph.js";
import { config } from "./config.js";
import { HumanMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";

/**
 * 将企业微信消息解析为智能体可理解的文本描述或多模态内容
 */
export function parseWeComMessage(body: any): string | { type: string; text?: string; image_url?: { url: string } | string }[] {
  const msgType = body.msgtype;
  const fromUser = body.from?.userid || "unknown";
  
  // 1. 解析主消息内容
  let mainItems: any[] = [];
  switch (msgType) {
    case MessageType.Text:
      mainItems.push({ type: "text", text: body.text.content });
      break;

    case MessageType.Image:
      // 如果模型支持 Vision，可以传递图片 URL
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一张图片]` });
      mainItems.push({ type: "image_url", image_url: body.image.url });
      break;

    case MessageType.Voice:
      const recognition = body.voice?.recognition || "";
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一段语音] ${recognition ? `(识别结果: ${recognition})` : "(未识别到文字)"}` });
      break;

    case MessageType.Video:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个视频] (链接: ${body.video?.url})` });
      break;

    case MessageType.File:
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个文件] 名称: ${body.file?.filename || "未知"}, 大小: ${body.file?.size || "未知"}` });
      break;

    case "location":
      mainItems.push({ type: "text", text: `[用户 ${fromUser} 发送了一个位置] 地址: ${body.location?.address}, 经纬度: ${body.location?.lat},${body.location?.lng}` });
      break;

    case "mixed":
      // 图文混排
      const items = body.mixed?.msg_item || [];
      items.forEach((item: any) => {
        if (item.msgtype === "text") mainItems.push({ type: "text", text: item.text?.content });
        else if (item.msgtype === "image") mainItems.push({ type: "image_url", image_url: item.image?.url });
      });
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
      quoteItems.push({ type: "image_url", image_url: body.quote.image?.url });
    } else if (qType === "mixed") {
      const qMixedItems = body.quote.mixed?.msg_item || [];
      qMixedItems.forEach((item: any) => {
        if (item.msgtype === "text") quoteItems.push({ type: "text", text: item.text?.content });
        else if (item.msgtype === "image") quoteItems.push({ type: "image_url", image_url: item.image?.url });
      });
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
  const agent = await initializeAgent();
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

    const parsedContent = parseWeComMessage(body);
    const chatId = body.chatid || body.from?.userid;

    if (!chatId) return;

    try {
      // 2. 使用消息自身的 msgid 作为 streamId 和 task_id，确保并行时的唯一性
      const streamId = body.msgid;

      // 发送初始进度卡片
      await bot.replyStreamWithCard(frame, streamId, "AI 正在思考中...", false, {
        templateCard: {
          card_type: 'text_notice',
          main_title: { title: '任务处理中', desc: 'AI 助手正在分析您的请求...' },
          task_id: `task_${body.msgid}`, // 确保卡片任务 ID 唯一
        }
      });

      let fullContent = "";
      let lastMessages: BaseMessage[] = [];
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL = 2000; // 每 2 秒更新一次，避免触发企业微信频率限制

      try {
        // 使用 streamMode: "messages" 获取流式更新
        const stream = await agent.stream({
          messages: [new HumanMessage({ content: parsedContent as any })],
        }, {
          recursionLimit: config.LLM_RECURSION_LIMIT,
          streamMode: "messages",
        });

        for await (const [message, metadata] of stream) {
          const msg = message as BaseMessage;
          lastMessages.push(msg);

          if (msg._getType() === "ai" && msg.content) {
            const delta = msg.content.toString();
            fullContent += delta;
            
            // 只有当有实质性内容更新且超过间隔时间时才发送更新
            if (delta.length > 0 && Date.now() - lastUpdateTime > UPDATE_INTERVAL) {
              await bot.replyStream(frame, streamId, fullContent, false);
              lastUpdateTime = Date.now();
            }
          }
        }
      } catch (err: any) {
        console.error(`Agent execution error for ${body.msgid}:`, err);

        // 特别处理递归超限错误
        if (err.lc_error_code === 'GRAPH_RECURSION_LIMIT' || err.message?.includes('Recursion limit')) {
          try {
            console.log(`[Recovery] Attempting to synthesize partial results for ${body.msgid}...`);
            const baseModel = await getBaseModel();
            const systemPrompt = await getSystemPrompt();

            // 构造恢复提示词：将之前的中间历史发给不带 tools 的大模型进行总结和指引
            const recoveryMessages = [
              new SystemMessage(`${systemPrompt}\n\n注意：当前任务由于逻辑过于复杂已达到执行上限。请根据下述已有的中间查询结果，尽可能为用户提供一个阶段性的总结回答。如果信息不足，请明确告知已查到的部分，并指引用户提供哪些更详细的信息（如特定 ID、时间范围或明确的查询条件）以继续。`),
              ...lastMessages
            ];

            const recoveryResponse = await baseModel.invoke(recoveryMessages);
            fullContent = recoveryResponse.content.toString();
          } catch (recoveryErr) {
            console.error(`Recovery invocation failed for ${body.msgid}:`, recoveryErr);
            const fallbackPrefix = fullContent 
              ? `[注意：由于问题较为复杂，以下是初步分析结果]\n\n${fullContent}`
              : "抱歉，由于该问题涉及的逻辑过于复杂，我暂时无法给出完整回答。";
            fullContent = `${fallbackPrefix}\n\n💡 建议：您可以尝试提供更详细的信息（例如更明确的查询条件、具体的 ID 或减少一次性查询的范围），以便我为您提供更精准的帮助。`;
          }
        } else {
          // 其他类型的错误
          fullContent = fullContent || "抱歉，处理您的请求时遇到了意外错误，请稍后重试。";
        }
      }

      // 发送最终结果（可能是完整结果，也可能是带建议的中间结果）并结束流
      await bot.replyStream(frame, streamId, fullContent || "未获取到有效回复", true);
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
