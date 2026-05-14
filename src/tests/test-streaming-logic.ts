import { initializeAgent } from "../graph.js";
import { HumanMessage } from "@langchain/core/messages";

async function testStreaming() {
  const agent = await initializeAgent();
  const query = "写一首关于春天的短诗";
  
  console.log(`Sending query: "${query}"`);
  
  try {
    const stream = await agent.stream({
      messages: [new HumanMessage(query)],
    }, {
      recursionLimit: 25,
      streamMode: "messages",
    });

    console.log("\n--- Streaming Response ---");
    for await (const [message, metadata] of stream) {
      if (message.content) {
        process.stdout.write(message.content.toString());
      }
    }
    console.log("\n--------------------------\n");
  } catch (error) {
    console.error("Streaming test failed:", error);
  } finally {
    process.exit(0);
  }
}

testStreaming();
