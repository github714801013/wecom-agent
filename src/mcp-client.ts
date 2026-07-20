import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config, type BotConfig, type McpServerConfig } from "./config.js";
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

export type McpHeaderOverrides = Record<string, Record<string, string>>;
export const MCP_SERVER_LOAD_TIMEOUT_MS = 20_000;

export function resolveActiveMcpProfileHeaders(
  server: McpServerConfig,
  bot?: BotConfig,
  headerOverrides: McpHeaderOverrides = {},
) {
  const hasExplicitProfileOverride = Object.keys(headerOverrides).length > 0;
  return hasExplicitProfileOverride
    ? headerOverrides[server.name] || {}
    : bot?.defaultMcpHeaderCommand
      ? server.headerProfiles[bot.defaultMcpHeaderCommand] || {}
      : {};
}

export function buildMcpHeaders(server: McpServerConfig, bot?: BotConfig, headerOverrides: McpHeaderOverrides = {}) {
  const activeProfileHeaders = resolveActiveMcpProfileHeaders(server, bot, headerOverrides);

  return {
    ...server.headers,
    ...(bot?.mcpHeaders?.[server.name] || {}),
    ...activeProfileHeaders,
  };
}

export function parseQueryableProjects(headers: Record<string, string>) {
  const projectsHeader = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "projects")?.[1] ?? "";
  const seen = new Set<string>();
  const projects: string[] = [];

  for (const rawProject of projectsHeader.split(",")) {
    const project = rawProject.trim();
    const projectKey = project.toLowerCase();
    if (!project || seen.has(projectKey)) continue;
    seen.add(projectKey);
    projects.push(project);
  }

  return projects;
}

function getMcpToolSchemaKeys(mcpTool: any) {
  const schema = mcpTool?.schema || mcpTool?.input_schema || mcpTool?.inputSchema;
  const shape = schema?.shape;
  if (shape && typeof shape === "object") {
    return Object.keys(shape);
  }

  const properties = schema?.properties || schema?.jsonSchema?.properties;
  return properties && typeof properties === "object"
    ? Object.keys(properties)
    : [];
}

export function wrapMcpToolWithConfiguredArgs(
  mcpTool: any,
  headers: Record<string, string>,
) {
  if (typeof mcpTool?.invoke !== "function") {
    return mcpTool;
  }

  const schemaKeys = getMcpToolSchemaKeys(mcpTool);
  const headerByLowerName = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const configuredArgNames = schemaKeys
    .filter(schemaKey => headerByLowerName.has(schemaKey.toLowerCase()));
  const repoArgName = schemaKeys.find(schemaKey => schemaKey.toLowerCase() === "repo");
  const allowedProjects = parseQueryableProjects(headers);

  if (configuredArgNames.length === 0 && (!repoArgName || allowedProjects.length === 0)) {
    return mcpTool;
  }

  const wrappedTool = Object.assign(Object.create(Object.getPrototypeOf(mcpTool)), mcpTool);
  const invoke = mcpTool.invoke.bind(mcpTool);
  wrappedTool.description = [
    mcpTool.description || "",
    "当前指令 profile 中已配置的参数由请求头锁定，模型同名参数会被移除；repo 只能选择 profile projects 范围内的仓库。",
  ].filter(Boolean).join("\n");
  wrappedTool.invoke = async (args: unknown, ...rest: unknown[]) => {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return invoke(args, ...rest);
    }

    const nextArgs: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    if (repoArgName && allowedProjects.length > 0 && nextArgs[repoArgName] !== undefined) {
      const requestedRepo = typeof nextArgs[repoArgName] === "string"
        ? nextArgs[repoArgName].trim()
        : "";
      const configuredRepo = allowedProjects.find(project => project.toLowerCase() === requestedRepo.toLowerCase());
      if (!configuredRepo) {
        return JSON.stringify({
          error: "MCP_CONFIG_SCOPE_VIOLATION",
          parameter: repoArgName,
          message: "工具参数超出当前指令配置范围，本次未调用 MCP 服务。",
        });
      }
      nextArgs[repoArgName] = configuredRepo;
    }

    for (const schemaKey of configuredArgNames) {
      delete nextArgs[schemaKey];
    }

    return invoke(nextArgs, ...rest);
  };
  return wrappedTool;
}

function isGitNexusListReposTool(mcpTool: any, serverName: string) {
  const normalizedName = String(mcpTool?.name || "").toLowerCase().replace(/[^a-z0-9]/gu, "");
  return /gitnexus/iu.test(serverName) && normalizedName.endsWith("listrepos");
}

export function wrapGitNexusListReposTool(
  mcpTool: any,
  serverName: string,
  headers: Record<string, string>,
) {
  if (!isGitNexusListReposTool(mcpTool, serverName) || typeof mcpTool?.invoke !== "function") {
    return mcpTool;
  }

  const queryableProjects = parseQueryableProjects(headers);
  return tool(
    async ({ scope }) => {
      if (scope === "all_indexed") {
        return mcpTool.invoke({});
      }

      return JSON.stringify({
        scope: "queryable",
        count: queryableProjects.length,
        projects: queryableProjects,
      });
    },
    {
      name: mcpTool.name,
      description: [
        mcpTool.description || "查询 GitNexus 项目列表。",
        "新增 scope 参数：queryable 返回当前请求头允许查询的项目，不访问远端；all_indexed 调用 GitNexus 返回全部已索引项目。",
        "未传 scope 时默认 queryable。",
      ].join("\n"),
      schema: z.object({
        scope: z.enum(["queryable", "all_indexed"])
          .default("queryable")
          .describe("queryable=当前允许查询的项目；all_indexed=全部已索引项目"),
      }),
    },
  );
}

export function createMcpTransport(server: McpServerConfig, bot?: BotConfig, headerOverrides: McpHeaderOverrides = {}): Transport | null {
  const headers = buildMcpHeaders(server, bot, headerOverrides);
  const transportInit = Object.keys(headers).length > 0 ? { headers } as any : undefined;

  if (server.type === "sse") {
    return new SSEClientTransport(new URL(server.url), {
      requestInit: transportInit,
      eventSourceInit: transportInit,
    });
  }

  if (server.type === "http") {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: transportInit,
    }) as unknown as Transport;
  }

  return null;
}

export function withMcpServerLoadTimeout<T>(promise: Promise<T>, label: string, timeoutMs = MCP_SERVER_LOAD_TIMEOUT_MS) {
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

type McpTool = Awaited<ReturnType<typeof loadMcpTools>>[number];

type McpToolsCacheEntry = {
  expiresAt: number;
  tools?: McpTool[];
  pending?: Promise<McpTool[]>;
};

export function buildMcpToolsCacheKey(bot?: BotConfig, headerOverrides: McpHeaderOverrides = {}) {
  return `${bot?.botId || "__default__"}:${JSON.stringify(bot?.mcpHeaders || {})}:${JSON.stringify(headerOverrides)}`;
}

export function getMcpToolsCacheTtlMs(cacheTtlMinutes = config.tools.cacheTtlMinutes) {
  return cacheTtlMinutes * 60 * 1000;
}

export function createMcpToolsCache(ttlMs: number, now = () => Date.now()) {
  const entries = new Map<string, McpToolsCacheEntry>();

  return {
    async get(key: string, loader: () => Promise<McpTool[]>) {
      const current = now();
      const cached = entries.get(key);
      if (cached?.tools && cached.expiresAt > current) {
        console.log(`Using cached MCP tools for ${key}, ttl left ${Math.ceil((cached.expiresAt - current) / 1000)}s.`);
        return cached.tools;
      }
      if (cached?.pending) {
        return cached.pending;
      }

      const pending = loader()
        .then(tools => {
          entries.set(key, {
            tools,
            expiresAt: now() + ttlMs,
          });
          return tools;
        })
        .catch(error => {
          entries.delete(key);
          throw error;
        });

      entries.set(key, {
        pending,
        expiresAt: current + ttlMs,
      });
      return pending;
    },
  };
}

const mcpToolsCache = createMcpToolsCache(getMcpToolsCacheTtlMs());

async function loadFreshMcpTools(bot?: BotConfig, headerOverrides: McpHeaderOverrides = {}) {
  const allTools = [];

  for (const server of config.mcpServers) {
    let client: Client | undefined;
    try {
      console.log(`Loading tools from MCP server: ${server.name} (${server.url})...`);
      
      const transport = createMcpTransport(server, bot, headerOverrides);
      if (!transport) {
        // Handle stdio if needed in the future
        console.warn(`Unsupported MCP transport type: ${server.type} for ${server.name}`);
        continue;
      }

      client = new Client(
        { name: `wecom-agent-${server.name}-client`, version: "1.0.0" },
        { capabilities: {} }
      );
      
      await withMcpServerLoadTimeout(client.connect(transport), `${server.name} MCP connect`);
      const tools = await withMcpServerLoadTimeout(loadMcpTools(server.name, client), `${server.name} MCP tools load`);
      const currentHeaders = buildMcpHeaders(server, bot, headerOverrides);
      const activeProfileHeaders = resolveActiveMcpProfileHeaders(server, bot, headerOverrides);
      const wrappedTools = tools.map(mcpTool => wrapMcpToolWithConfiguredArgs(
        wrapGitNexusListReposTool(mcpTool, server.name, currentHeaders),
        activeProfileHeaders,
      ));
      
      console.log(`Successfully loaded ${wrappedTools.length} tools from ${server.name} MCP.`);
      allTools.push(...wrappedTools);
    } catch (error) {
      await client?.close().catch(closeError => {
        console.warn(`Failed to close ${server.name} MCP client after load failure:`, closeError);
      });
      console.error(`Failed to load tools from ${server.name} MCP:`, error);
    }
  }

  // Filter tools
  let filteredTools = allTools;
  const originalCount = allTools.length;

  // Apply whitelist
  if (config.tools.allowed.length > 0) {
    const whitelist = new Set(config.tools.allowed);
    filteredTools = filteredTools.filter(tool => whitelist.has(tool.name));
  }

  // Apply blacklist
  if (config.tools.excluded.length > 0) {
    const blacklist = new Set(config.tools.excluded);
    filteredTools = filteredTools.filter(tool => !blacklist.has(tool.name));
  }

  if (filteredTools.length !== originalCount) {
    console.log(`Tool filtering applied: ${filteredTools.length} tools available out of ${originalCount} total.`);
  }

  return filteredTools;
}

export async function getAllMcpTools(bot?: BotConfig, headerOverrides: McpHeaderOverrides = {}) {
  return mcpToolsCache.get(buildMcpToolsCacheKey(bot, headerOverrides), () => loadFreshMcpTools(bot, headerOverrides));
}
