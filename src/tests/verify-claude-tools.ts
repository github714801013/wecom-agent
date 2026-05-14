import { getClaudeTools } from "../mcp-client.js";

async function test() {
  console.log("Testing Claude tool transformation...");
  try {
    const tools = await getClaudeTools();
    console.log(`Successfully converted ${tools.length} tools.`);
    if (tools.length > 0) {
      const sample = tools[0];
      console.log("First tool sample:", JSON.stringify({
          name: sample.name,
          description: sample.description,
          hasSchema: !!sample.input_schema,
          hasCall: typeof sample.call === 'function'
      }, null, 2));
    }
    process.exit(0);
  } catch (e) {
    console.error("Test failed:", e);
    process.exit(1);
  }
}
test();
