import { runClaudeAgent } from "../graph.js";

async function testSimple() {
  const query = "你是谁？";
  console.log(`Sending query: "${query}"`);
  
  try {
    let fullResponse = "";
    const sessionKey = "test-session-simple";
    
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
        // Final summary or non-streamed content
        if (chunk.message.content) {
            const textContent = chunk.message.content.find((c: any) => c.type === 'text');
            if (textContent && !fullResponse) {
                fullResponse = (textContent as any).text;
                console.log("[Assistant Message]:", (textContent as any).text);
            }
        }
      } else {
          // Log other chunks to debug
          console.log("[Chunk type]:", chunk.type, (chunk as any).subtype || "");
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
