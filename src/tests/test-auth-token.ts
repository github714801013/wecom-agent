import { query } from "@anthropic-ai/claude-agent-sdk";
import "dotenv/config";

async function test() {
  try {
    const stream = query({
      prompt: "Hello",
      options: {
        model: "claude-sonnet-4-6",
        env: {
          "ANTHROPIC_AUTH_TOKEN": process.env.LLM_API_KEY || "",
          "ANTHROPIC_API_KEY": "",
          "ANTHROPIC_BASE_URL": (process.env.LLM_BASE_URL || "").replace(/\/v1\/?$/, ''),
          "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
          "DISABLE_PROMPT_CACHING": "1",
        }
      }
    });
    for await (const chunk of stream) {
      if (chunk.type === "stream_event") {
        const event = chunk.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          process.stdout.write(event.delta.text);
        }
      }
    }
    console.log("\nDone.");
  } catch (err) {
    console.error("Test failed with error:", err);
  }
}
test();
