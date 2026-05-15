import { getClaudeMcpConfig } from "../mcp-client.js";

async function verify() {
  try {
    console.log("正在尝试验证 MCP 配置...");
    const mcpConfig = getClaudeMcpConfig();
    const serverNames = Object.keys(mcpConfig);
    console.log(`已配置 ${serverNames.length} 个服务器: ${serverNames.join(", ")}`);
    console.log("[注意] 在 SDK 模式下，连接和工具列表由 Claude Agent SDK 在运行时自动管理。");
    process.exit(0);
  } catch (error) {
    console.error("验证失败:", error);
    process.exit(1);
  }
}

verify();
