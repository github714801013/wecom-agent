import { WSClient } from "@wecom/aibot-node-sdk";
import { createAgent } from "./graph.js";
import { config } from "./config.js";
import { HumanMessage } from "@langchain/core/messages";

export async function startBot() {
  const agent = await createAgent();
  const bot = new WSClient({
    botId: config.WECOM_BOT_ID,
    secret: config.WECOM_BOT_SECRET,
    // wsUrl is optional, defaults to wss://openws.work.weixin.qq.com
    wsUrl: config.WECOM_WS_URL, 
  });

  bot.on("message.text", async (frame) => {
    const { body } = frame;
    if (!body) return;
    
    const text = body.text.content;
    const chatId = body.chatid || body.from?.userid;

    if (!chatId) return;

    try {
      const response: any = await agent.invoke({
        messages: [new HumanMessage(text)],
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
