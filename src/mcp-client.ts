import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { config } from "./config.js";
import { sessionManager } from "./session-manager.js";

/**
 * 本地工具：清理会话历史
 */
const clearHistoryTool = {
  name: "clear_conversation_history",
  description: "清理当前的对话历史记录/记忆。当用户明确要求“忘记之前的对话”、“重置聊天”、“清理记忆”或开始全新话题时使用。",
  input_schema: {
    type: "object",
    properties: {}
  },
  call: async (args: any, context: any) => {
    // Note: sessionKey needs to be passed in context or args
    const sessionKey = args.sessionKey || (context as any)?.sessionKey;
    if (sessionKey) {
      sessionManager.clearSession(sessionKey);
      return "会话记录已成功清理。";
    }
    return "错误：未能找到有效的会话标识，清理失败。";
  }
};

export async function getAllMcpTools() {
// ... rest of code unchanged ...
  const allTools = [];

  for (const server of config.mcpServers) {
    try {
      console.log(`Loading tools from MCP server: ${server.name} (${server.url})...`);
      
      let transport;
      if (server.type === "sse") {
        transport = new SSEClientTransport(new URL(server.url), {
          requestInit: server.headers ? { headers: server.headers } as any : undefined,
          eventSourceInit: server.headers ? { headers: server.headers } as any : undefined,
        });
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
