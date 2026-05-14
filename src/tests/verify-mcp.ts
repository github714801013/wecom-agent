import { getAllMcpTools } from "../mcp-client.js";

async function verify() {
  try {
    console.log("正在尝试连接到 MCP 服务器...");
    // 这里的 config 会从 .env 加载 MCP_REMOTE_URL
    const tools = await getAllMcpTools();
    console.log(`成功获取到 ${tools.length} 个工具:`);
    // @ts-ignore
    tools.forEach(tool => console.log(`- ${tool.name}`));
    process.exit(0);
  } catch (error) {
    console.error("连接失败:", error);
    process.exit(1);
  }
}

verify();
