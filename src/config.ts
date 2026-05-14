import "dotenv/config";
import { z } from "zod";

const mcpServerSchema = z.object({
  name: z.string(),
  url: z.string(),
  type: z.enum(["sse", "stdio"]).default("sse"),
});

const envSchema = z.object({
  WECOM_BOT_ID: z.string(),
  WECOM_BOT_SECRET: z.string(),
  WECOM_WS_URL: z.string(),
  LLM_API_KEY: z.string(),
  LLM_BASE_URL: z.string(),
  MCP_REMOTE_URL: z.string(),
  MCP_SERVERS: z.string().optional(),
});

const parsedEnv = envSchema.parse(process.env);

let mcpServers = [];
try {
  if (parsedEnv.MCP_SERVERS) {
    mcpServers = JSON.parse(parsedEnv.MCP_SERVERS);
  } else if (parsedEnv.MCP_REMOTE_URL) {
    mcpServers = [
      { name: "gitnexus", url: parsedEnv.MCP_REMOTE_URL, type: "sse" },
    ];
  }
} catch (e) {
  console.error("Failed to parse MCP_SERVERS", e);
}

export const config = {
  ...parsedEnv,
  mcpServers: z.array(mcpServerSchema).parse(mcpServers),
};
