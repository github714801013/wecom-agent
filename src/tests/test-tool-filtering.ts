import { config } from "../config.js";
import { getAllMcpTools } from "../mcp-client.js";

async function testFiltering() {
  console.log("Config - Allowed Tools:", config.allowedTools);
  console.log("Config - Excluded Tools:", config.excludedTools);
  
  const tools = await getAllMcpTools();
  const toolNames = tools.map(t => t.name);
  console.log("Final loaded tools:", toolNames);

  let success = true;

  if (config.allowedTools) {
    const unauthorized = toolNames.filter(name => !config.allowedTools!.includes(name));
    if (unauthorized.length > 0) {
      console.error("FAILED: Found tools NOT in ALLOWED_TOOLS whitelist:", unauthorized);
      success = false;
    } else {
      console.log("CHECK: Whitelist (ALLOWED_TOOLS) verified.");
    }
  }

  if (config.excludedTools) {
    const forbidden = toolNames.filter(name => config.excludedTools!.includes(name));
    if (forbidden.length > 0) {
      console.error("FAILED: Found tools that should have been EXCLUDED:", forbidden);
      success = false;
    } else {
      console.log("CHECK: Blacklist (EXCLUDED_TOOLS) verified.");
    }
  }

  if (success) {
    console.log("\n[SUCCESS] All tool filtering logic verified.");
  } else {
    process.exit(1);
  }
}

testFiltering().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
