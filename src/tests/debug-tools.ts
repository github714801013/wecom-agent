import { getAllMcpTools } from "../mcp-client.js";
import { config } from "../config.js";

async function listTools() {
  console.log("Configured MCP Servers:", config.mcpServers);
  try {
    const tools = await getAllMcpTools();
    console.log(`Found ${tools.length} tools:`);
    tools.forEach(t => {
      console.log(`- ${t.name}: ${t.description.slice(0, 100)}`);
    });
  } catch (err) {
    console.error("Error loading tools:", err);
  } finally {
    process.exit(0);
  }
}

listTools();
