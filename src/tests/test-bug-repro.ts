import { initializeAgent } from "../graph.js";
import { HumanMessage } from "@langchain/core/messages";

async function test() {
  const prompt = "售后单维修配件列表中，撤销按钮的权值是什么";
  console.log(`Sending query: "${prompt}"`);
  
  try {
    const agent = await initializeAgent();
    const stream = await agent.stream({
      messages: [new HumanMessage(prompt)],
    }, {
      recursionLimit: 25,
      streamMode: "messages",
    });
    
    console.log("\n--- Agent Response ---");
    for await (const [message, metadata] of stream) {
      if (message.content) {
        process.stdout.write(message.content.toString());
      }
    }
  } catch (error) {
    console.error("\n[Error]:", error);
  }
}

test().catch(console.error);
