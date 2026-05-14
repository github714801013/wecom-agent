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
      if (chunk.type === "text") {
        fullResponse += chunk.content;
        process.stdout.write(chunk.content);
      } else if (chunk.type === "call") {
        console.log(`\n[Tool Call] ${chunk.call.name}(${JSON.stringify(chunk.call.input)})`);
      } else if (chunk.type === "result") {
        console.log(`\n[Tool Result] ${chunk.result.content}`);
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
