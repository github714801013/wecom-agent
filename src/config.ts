import dotenv from "dotenv";
dotenv.config();
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_CONFIG_FILE = path.resolve(process.cwd(), "config", "wecom-agent.config.json");

const headerSchema = z.record(z.string(), z.string());

export const mcpServerSchema = z.object({
  name: z.string(),
  url: z.string(),
  type: z.enum(["sse", "stdio"]).default("sse"),
  headers: headerSchema.default({}),
});

export const botSchema = z.object({
  name: z.string(),
  botId: z.string(),
  secret: z.string(),
  wsUrl: z.string().default("wss://openws.work.weixin.qq.com"),
  mcpHeaders: z.record(z.string(), headerSchema).default({}),
});

const agentConfigSchema = z.object({
  llm: z.object({
    apiKey: z.string(),
    baseUrl: z.string(),
    modelName: z.string().default("MiniMax-M2.5"),
    recursionLimit: z.coerce.number().default(25),
    contextWindow: z.coerce.number().default(0),
  }),
  mcpServers: z.array(mcpServerSchema).default([]),
  bots: z.array(botSchema).min(1),
  tools: z.object({
    allowed: z.array(z.string()).default([]),
    excluded: z.array(z.string()).default([]),
  }).default({ allowed: [], excluded: [] }),
});

export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type BotConfig = z.infer<typeof botSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export function resolveEnvPlaceholders<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => {
      const envValue = process.env[name];
      if (envValue === undefined) {
        throw new Error(`Missing environment variable for config placeholder: ${name}`);
      }
      return envValue;
    }) as T;
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveEnvPlaceholders(item)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvPlaceholders(item)])
    ) as T;
  }

  return value;
}

function loadConfig(): AgentConfig {
  const configFile = path.resolve(process.env.CONFIG_FILE || DEFAULT_CONFIG_FILE);
  if (!fs.existsSync(configFile)) {
    throw new Error(`Config file not found: ${configFile}`);
  }

  const raw = fs.readFileSync(configFile, "utf-8");
  const json = resolveEnvPlaceholders(JSON.parse(raw));
  return agentConfigSchema.parse(json);
}

export const config = loadConfig();
