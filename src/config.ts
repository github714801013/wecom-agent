import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  WECOM_BOT_ID: z.string(),
  WECOM_BOT_SECRET: z.string(),
  WECOM_WS_URL: z.string(),
  MINIMAX_API_KEY: z.string(),
  MINIMAX_BASE_URL: z.string(),
  MCP_REMOTE_URL: z.string(),
});

export const config = envSchema.parse(process.env);
