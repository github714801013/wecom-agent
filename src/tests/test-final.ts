import { runClaudeAgent } from "../graph.js";

async function test() {
  console.log("Starting final validation test...");
  try {
    for await (const chunk of runClaudeAgent("hi", "test-session")) {
      console.log("Chunk type:", chunk.type);
      if (chunk.type === 'assistant') {
        console.log("Assistant Message:", JSON.stringify(chunk.message, null, 2));
      }
    }
    console.log("Test completed successfully.");
  } catch (err) {
    console.error("TEST ERROR:", err);
    if (err instanceof Error) {
        console.error("Stack:", err.stack);
    }
  }
}

test();
