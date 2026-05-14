import { WSClient, MessageType } from "@wecom/aibot-node-sdk";
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

  // 监听所有消息类型
  bot.on("message", async (frame) => {
    const { body } = frame;
    if (!body) return;
    
    const parsedContent = parseWeComMessage(body);
    const chatId = body.chatid || body.from?.userid;

    if (!chatId) return;

    try {
      const response: any = await agent.invoke({
        messages: [new HumanMessage({ content: parsedContent as any })],
      });
      
      const lastMsg = response.messages[response.messages.length - 1];
      if (!lastMsg) return;
      
      const replyContent = lastMsg.content.toString();

      await bot.sendMessage(chatId, {
        msgtype: "markdown",
        markdown: { content: replyContent },
      });
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });

  bot.on("connected", () => console.log("WeCom WebSocket connected."));
  bot.on("authenticated", () => console.log("WeCom Authentication successful."));
  bot.on("error", (err) => console.error("WeCom WebSocket error:", err));

  bot.connect();
  console.log("WeCom Bot starting...");
}
