import "dotenv/config";
import { z } from "zod";

const mcpServerSchema = z.object({
  name: z.string(),
  url: z.string(),
  type: z.enum(["sse", "stdio"]).default("sse"),
  headers: z.record(z.string(), z.string()).default({}),
});

const envSchema = z.object({
  WECOM_BOT_ID: z.string(),
  WECOM_BOT_SECRET: z.string(),
  WECOM_WS_URL: z.string(),
  LLM_API_KEY: z.string(),
  LLM_BASE_URL: z.string(),
  LLM_MODEL_NAME: z.string().default("MiniMax-M2.5"),
  LLM_RECURSION_LIMIT: z.coerce.number().default(25),
  LLM_CONTEXT_WINDOW: z.coerce.number().default(0),
  MCP_REMOTE_URL: z.string(),
  MCP_PROJECTS: z.string().optional(),
  MCP_SERVERS: z.string().optional(),
  ALLOWED_TOOLS: z.string().optional(),
  EXCLUDED_TOOLS: z.string().optional(),
});

const parsedEnv = envSchema.parse(process.env);

let mcpServers = [];
try {
  if (parsedEnv.MCP_SERVERS) {
    mcpServers = JSON.parse(parsedEnv.MCP_SERVERS);
  } else if (parsedEnv.MCP_REMOTE_URL) {
    mcpServers = [
      {
        name: "gitnexus",
        url: parsedEnv.MCP_REMOTE_URL,
        type: "sse",
        headers: parsedEnv.MCP_PROJECTS ? { projects: parsedEnv.MCP_PROJECTS } : {}
      },
    ];
  }

  // If gitnexus server exists but doesn't have projects header, and MCP_PROJECTS is set, add it
  if (parsedEnv.MCP_PROJECTS) {
    mcpServers = mcpServers.map((s: any) => {
      if (s.name === "gitnexus" && !s.headers?.projects) {
        return { ...s, headers: { ...s.headers, projects: parsedEnv.MCP_PROJECTS } };
      }
      return s;
    });
  }
} catch (e) {
  console.error("Failed to parse MCP_SERVERS", e);
}

export const config = {
  ...parsedEnv,
  mcpServers: z.array(mcpServerSchema).parse(mcpServers),
  allowedTools: parsedEnv.ALLOWED_TOOLS
    ? parsedEnv.ALLOWED_TOOLS.split(",").map((t) => t.trim())
    : null,
  excludedTools: parsedEnv.EXCLUDED_TOOLS
    ? parsedEnv.EXCLUDED_TOOLS.split(",").map((t) => t.trim())
    : null,
};
