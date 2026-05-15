import { initializeAgent } from "../graph.js";
import { HumanMessage } from "@langchain/core/messages";

async function testQuery() {
  console.log("Initializing agent and connecting to remote MCP...");
  
  const query = "售后统计逻辑查询";
  console.log(`Sending query: "${query}"`);
  
  try {
    let fullResponse = "";
    
    const agent = await initializeAgent();
    const stream = await agent.stream({
      messages: [new HumanMessage(query)],
    }, {
      recursionLimit: 25,
      streamMode: "messages",
    });
    
    console.log("\n--- Agent Response ---");
    for await (const [message, metadata] of stream) {
      if (message.content) {
        const content = message.content.toString();
        fullResponse = content;
        process.stdout.write(content);
      }
    }
    console.log("\n----------------------\n");
    
    if (!fullResponse) {
      console.log("No text response returned.");
    }
  } catch (error) {
    console.error("Test failed with error:", error);
  } finally {
    process.exit(0);
  }
}

testQuery();
