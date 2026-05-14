import { runClaudeAgent } from "../graph.js";

async function testQuery() {
  console.log("Initializing agent and connecting to remote MCP...");
  
  const query = "售后统计逻辑查询";
  console.log(`Sending query: "${query}"`);
  
  try {
    let fullResponse = "";
    const sessionKey = "test-session-query";
    
    const stream = runClaudeAgent(query, sessionKey);
    
    console.log("\n--- Agent Response ---");
    for await (const chunk of stream) {
      if (chunk.type === "stream_event") {
        const event = chunk.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          fullResponse += event.delta.text;
          process.stdout.write(event.delta.text);
        }
      } else if (chunk.type === "assistant") {
        if (chunk.message.content) {
            const textContent = chunk.message.content.find((c: any) => c.type === 'text');
            if (textContent && !fullResponse) {
                fullResponse = (textContent as any).text;
            }
        }
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
