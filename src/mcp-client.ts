import { config } from "./config.js";
import { sessionManager } from "./session-manager.js";

/**
 * 将配置中的 MCP 服务器列表转换为 Claude Agent SDK 所需的 Record 格式
 */
export function getClaudeMcpConfig(): Record<string, any> {
  const mcpConfig: Record<string, any> = {};

  for (const server of config.mcpServers) {
    if (server.type === "sse") {
      mcpConfig[server.name] = {
        type: "sse",
        url: server.url,
        // alwaysLoad: true // 禁用强制加载，增加容错
      };
    } else {
      console.warn(`Unsupported MCP transport type in SDK mode: ${server.type} for ${server.name}`);
    }
  }

  return mcpConfig;
}

/**
 * 本地内置工具：清理会话历史
 * 在 SDK 模式下，本地工具通常作为单独的工具函数传入 query
 */
export const clearHistoryTool = {
  name: "clear_conversation_history",
  description: "清理当前的对话历史记录/记忆。当用户明确要求“忘记之前的对话”、“重置聊天”、“清理记忆”或开始全新话题时使用。",
  input_schema: {
    type: "object",
    properties: {}
  },
  call: async (args: any, context: any) => {
    // 注意：SDK 可能会将 context 传入
    const sessionKey = args.sessionKey || (context as any)?.sessionKey;
    if (sessionKey) {
      sessionManager.clearSession(sessionKey);
      return "会话记录已成功清理。";
    }
    return "错误：未能找到有效的会话标识，清理失败。";
  }
};
