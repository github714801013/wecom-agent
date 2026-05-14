import { WSClient, MessageType, generateReqId } from "@wecom/aibot-node-sdk";
import { initializeAgent } from "./graph.js";
import { config } from "./config.js";
import { HumanMessage } from "@langchain/core/messages";

/**
 * 将企业微信消息解析为智能体可理解的文本描述或多模态内容
 */
function parseWeComMessage(body: any): string | { type: string; text?: string; image_url?: string }[] {
  const msgType = body.msgtype;
  const fromUser = body.from?.userid || "unknown";

  switch (msgType) {
    case MessageType.Text:
      return body.text.content;

    case MessageType.Image:
      // 如果模型支持 Vision，可以传递图片 URL
      // 注意：WeCom 图片 URL 有效期 5 分钟，且需要带上 aeskey 进行处理（SDK 已封装下载）
      return [
        { type: "text", text: `[用户 ${fromUser} 发送了一张图片]` },
        { type: "image_url", image_url: body.image.url }
      ];

    case MessageType.Voice:
      const recognition = body.voice?.recognition || "";
      return `[用户 ${fromUser} 发送了一段语音] ${recognition ? `(识别结果: ${recognition})` : "(未识别到文字)"}`;

    case MessageType.Video:
      return `[用户 ${fromUser} 发送了一个视频] (链接: ${body.video?.url})`;

    case MessageType.File:
      return `[用户 ${fromUser} 发送了一个文件] 名称: ${body.file?.filename || "未知"}, 大小: ${body.file?.size || "未知"}`;

    case "location":
      return `[用户 ${fromUser} 发送了一个位置] 地址: ${body.location?.address}, 经纬度: ${body.location?.lat},${body.location?.lng}`;

    case "mixed":
      // 图文混排
      const items = body.mixed?.msg_item || [];
      return items.map((item: any) => {
        if (item.msgtype === "text") return item.text?.content;
        if (item.msgtype === "image") return `[图片: ${item.image?.url}]`;
        return `[${item.msgtype}]`;
      }).join("\n");

    default:
      return `[用户 ${fromUser} 发送了未处理的消息类型: ${msgType}]`;
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
      try {
        // 使用 stream 替代 invoke，以便在异常时（如递归超限）仍能获取中间结果
        const stream = await agent.stream({
          messages: [new HumanMessage({ content: parsedContent as any })],
        }, {
          recursionLimit: config.LLM_RECURSION_LIMIT
        });

        for await (const chunk of stream) {
          const anyChunk = chunk as any;
          const messages = anyChunk.messages || 
                           (Object.values(anyChunk)[0] as any)?.messages;
          
          if (messages && Array.isArray(messages) && messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.content) {
              fullContent = lastMsg.content.toString();
            }
          }
        }
      } catch (err: any) {
        console.error(`Agent execution error for ${body.msgid}:`, err);
        
        // 特别处理递归超限错误
        if (err.lc_error_code === 'GRAPH_RECURSION_LIMIT' || err.message?.includes('Recursion limit')) {
          const fallbackPrefix = fullContent 
            ? `[注意：由于问题较为复杂，以下是初步分析结果]\n\n${fullContent}`
            : "抱歉，由于该问题涉及的逻辑过于复杂，我暂时无法给出完整回答。";
          
          fullContent = `${fallbackPrefix}\n\n💡 建议：您可以尝试提供更详细的信息（例如更明确的查询条件、具体的 ID 或减少一次性查询的范围），以便我为您提供更精准的帮助。`;
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
  console.log("WeCom Bot starting...");
}
