import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { config } from "./config.js";

export async function getGitNexusTools() {
  const transport = new SSEClientTransport(new URL(config.MCP_REMOTE_URL));
  const client = new Client(
    { name: "wecom-agent-client", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return await loadMcpTools("gitnexus", client);
}
