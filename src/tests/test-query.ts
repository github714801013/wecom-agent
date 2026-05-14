import { initializeAgent } from "../graph.js";
import { HumanMessage, BaseMessage } from "@langchain/core/messages";

async function testQuery() {
  console.log("Initializing agent and connecting to remote MCP...");
  const agent = await initializeAgent();
  
  const query = "售后统计逻辑查询";
  console.log(`Sending query: "${query}"`);
  
  try {
    const response: any = await agent.invoke({
      messages: [new HumanMessage(query)],
    }, {
      recursionLimit: 50, // 增加递归限制，防止复杂任务中断
    });
    
    console.log("\n--- Agent Response ---");
    const messages = response.messages as BaseMessage[];
    const lastMsg = messages[messages.length - 1];
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

testQuery();
