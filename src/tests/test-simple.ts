import { initializeAgent } from "../graph.js";
import { HumanMessage } from "@langchain/core/messages";

async function testSimple() {
  const query = "你是谁？";
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
        // In LangGraph streamMode: "messages", we might get multiple messages.
        // For a simple test, we just print the latest content.
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

testSimple();
