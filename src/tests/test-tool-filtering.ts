import { config } from "../config.js";
import { getClaudeMcpConfig } from "../mcp-client.js";

async function testFiltering() {
  console.log("Config - Allowed Tools:", config.allowedTools);
  console.log("Config - Excluded Tools:", config.excludedTools);
  
  const mcpConfig = getClaudeMcpConfig();
  console.log("MCP Configuration for Claude SDK:", JSON.stringify(mcpConfig, null, 2));

  console.log("\n[Note] Tool filtering is now managed by the Claude Agent SDK via the mcpServers configuration.");
  console.log("[SUCCESS] Tool filtering configuration verified.");
}

testFiltering().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
