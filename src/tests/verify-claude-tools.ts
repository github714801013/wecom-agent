import { getClaudeMcpConfig } from "../mcp-client.js";

async function test() {
  console.log("Testing Claude tool transformation (SDK Mode)...");
  try {
    const mcpConfig = getClaudeMcpConfig();
    console.log(`Successfully generated MCP configuration for ${Object.keys(mcpConfig).length} servers.`);
    console.log("Configuration sample:", JSON.stringify(mcpConfig, null, 2));
    process.exit(0);
  } catch (e) {
    console.error("Test failed:", e);
    process.exit(1);
  }
}
test();
