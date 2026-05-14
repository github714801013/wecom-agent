import { initializeAgent } from "../graph.js";
import { HumanMessage, BaseMessage } from "@langchain/core/messages";

async function testSimple() {
  const agent = await initializeAgent();
  
  const query = "你是谁？";
  console.log(`Sending query: "${query}"`);
  
  try {
    const response: any = await agent.invoke({
      messages: [new HumanMessage(query)],
    });
    
    console.log("\n--- Agent Response ---");
    const lastMsg = response.messages[response.messages.length - 1];
    if (lastMsg) {
      console.log(lastMsg.content);
    } else {
      console.log("No response returned.");
    }
    console.log("----------------------\n");
  } catch (error) {
    console.error("Test failed with error:", error);
  } finally {
    process.exit(0);
  }
}

testSimple();
