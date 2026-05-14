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

  // Filter tools
  let filteredTools = allTools;
  const originalCount = allTools.length;

  // Apply whitelist (ALLOWED_TOOLS)
  if (config.allowedTools && config.allowedTools.length > 0) {
    const whitelist = new Set(config.allowedTools);
    filteredTools = filteredTools.filter(tool => whitelist.has(tool.name));
  }

  // Apply blacklist (EXCLUDED_TOOLS)
  if (config.excludedTools && config.excludedTools.length > 0) {
    const blacklist = new Set(config.excludedTools);
    filteredTools = filteredTools.filter(tool => !blacklist.has(tool.name));
  }

  if (filteredTools.length !== originalCount) {
    console.log(`Tool filtering applied: ${filteredTools.length} tools available out of ${originalCount} total.`);
  }

  return filteredTools;
}

/**
 * 将 LangChain 格式的 MCP 工具转换为 Claude Agent SDK 所需的格式
 */
export async function getClaudeTools(): Promise<any[]> {
  const mcpTools = await getAllMcpTools();
  return mcpTools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: (t as any).schema || (t as any).input_schema,
    call: async (args: any) => {
      try {
        const result = await (t as any).invoke(args);
        // Claude SDK 要求工具返回字符串
        return typeof result === 'string' ? result : JSON.stringify(result);
      } catch (error: any) {
        return `Error executing tool ${t.name}: ${error.message}`;
      }
    }
  }));
}
