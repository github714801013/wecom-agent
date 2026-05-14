import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { config } from "./config.js";

export async function getAllMcpTools() {
  const allTools = [];

  for (const server of config.mcpServers) {
    try {
      console.log(`Loading tools from MCP server: ${server.name} (${server.url})...`);
      
      let transport;
      if (server.type === "sse") {
        transport = new SSEClientTransport(new URL(server.url));
      } else {
        // Handle stdio if needed in the future
        console.warn(`Unsupported MCP transport type: ${server.type} for ${server.name}`);
        continue;
      }

      const client = new Client(
        { name: `wecom-agent-${server.name}-client`, version: "1.0.0" },
        { capabilities: {} }
      );
      
      await client.connect(transport);
      const tools = await loadMcpTools(server.name, client);
      
      console.log(`Successfully loaded ${tools.length} tools from ${server.name} MCP.`);
      allTools.push(...tools);
    } catch (error) {
      console.error(`Failed to load tools from ${server.name} MCP:`, error);
    }
  }

  return allTools;
}
