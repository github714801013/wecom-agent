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

      const response: any = await agent.invoke({
        messages: [new HumanMessage({ content: parsedContent as any })],
      });
      
      const lastMsg = response.messages[response.messages.length - 1];
      if (!lastMsg) return;
      
      const replyContent = lastMsg.content.toString();

      // 发送最终结果并结束流
      await bot.replyStream(frame, streamId, replyContent, true);
    } catch (error) {
      console.error(`Error processing message ${body.msgid}:`, error);
      // 处理失败时，可以考虑从已处理集合中移除，以便重试（根据业务需求决定）
      // processedMsgs.delete(body.msgid);
    }
  });

  bot.on("connected", () => console.log("WeCom WebSocket connected."));
  bot.on("authenticated", () => console.log("WeCom Authentication successful."));
  bot.on("error", (err) => console.error("WeCom WebSocket error:", err));

  bot.connect();
  console.log("WeCom Bot starting...");
}
