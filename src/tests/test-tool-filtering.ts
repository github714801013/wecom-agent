import { config } from "../config.js";
import { getAllMcpTools } from "../mcp-client.js";

async function testFiltering() {
  console.log("Config - Allowed Tools:", config.tools.allowed);
  console.log("Config - Excluded Tools:", config.tools.excluded);
  
  const tools = await getAllMcpTools();
  const toolNames = tools.map(t => t.name);
  console.log("Final loaded tools:", toolNames);

  let success = true;

  if (config.tools.allowed.length > 0) {
    const unauthorized = toolNames.filter(name => !config.tools.allowed.includes(name));
    if (unauthorized.length > 0) {
      console.error("FAILED: Found tools NOT in configured whitelist:", unauthorized);
      success = false;
    } else {
      console.log("CHECK: Whitelist verified.");
    }
  }

  if (config.tools.excluded.length > 0) {
    const forbidden = toolNames.filter(name => config.tools.excluded.includes(name));
    if (forbidden.length > 0) {
      console.error("FAILED: Found tools that should have been EXCLUDED:", forbidden);
      success = false;
    } else {
      console.log("CHECK: Blacklist verified.");
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
