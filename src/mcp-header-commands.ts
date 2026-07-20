import type { McpServerConfig } from "./config.js";

export type McpHeaderCommand = {
  command: string;
  label: string;
  headersByServer: Record<string, Record<string, string>>;
};

function normalizeCommandText(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/^@[^\s，。！？!?,;；：:、/]+[\s，。！？!?,;；：:、]*/u, "")
    .replace(/[\s，。！？!?.]/g, "");
}

function normalizeCommandKey(command: string) {
  const trimmed = command.trim().toLowerCase();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveMcpHeaderCommand(command: string, servers: McpServerConfig[] = []): McpHeaderCommand | null {
  const normalized = normalizeCommandKey(command);
  if (!normalized.startsWith("/")) return null;

  const headersByServer: Record<string, Record<string, string>> = {};

  for (const server of servers) {
    const profileEntry = Object.entries(server.headerProfiles)
      .find(([profileCommand]) => normalizeCommandKey(profileCommand) === normalized);
    if (!profileEntry) continue;
    headersByServer[server.name] = { ...profileEntry[1] };
  }

  if (Object.keys(headersByServer).length === 0) return null;

  return {
    command: normalized,
    label: normalized.replace(/^\//, ""),
    headersByServer,
  };
}

export function parseMcpHeaderCommand(text: string, servers: McpServerConfig[] = []): McpHeaderCommand | null {
  const normalized = normalizeCommandText(text);
  if (!normalized.startsWith("/")) return null;
  return resolveMcpHeaderCommand(normalized, servers);
}

export function extractProjectsFromHeaders(headers: Record<string, string> = {}) {
  return typeof headers.projects === "string"
    ? headers.projects.split(",").map(project => project.trim()).filter(Boolean)
    : [];
}

export function extractProjectsFromMcpHeaders(headersByServer: Record<string, Record<string, string>> = {}) {
  return Array.from(new Set(
    Object.values(headersByServer).flatMap(headers => extractProjectsFromHeaders(headers)),
  ));
}

export function buildMcpHeaderSwitchReply(command: McpHeaderCommand) {
  const projects = extractProjectsFromMcpHeaders(command.headersByServer);
  return projects.length > 0
    ? `已切换到 ${command.command} 环境，后续查询范围：${projects.join(", ")}`
    : `已切换到 ${command.command} 环境，后续查询将使用该环境配置。`;
}

export function isQueryableProjectsQuestion(text: string) {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？!?、：:；;,.]/gu, "");

  return /^(?:(?:现在|当前)?(?:你|机器人|助手)?(?:能|可以|可)?(?:查|查询|检索)(?:到)?(?:哪些|什么)(?:项目|仓库)(?:列表|范围)?|(?:现在|当前)?(?:可查询|能查询|可以查询)(?:的)?(?:项目|仓库)(?:列表|范围)?|(?:现在|当前)?查询范围(?:是)?什么|(?:可查询|能查询|可以查询)(?:项目|仓库)列表)$/u.test(normalized);
}

export function buildQueryableProjectsReply(projects: readonly string[]) {
  const normalizedProjects = Array.from(new Set(projects.map(project => project.trim()).filter(Boolean)));
  if (normalizedProjects.length === 0) {
    return "当前环境未配置可查询项目。请检查该环境的 projects 配置。";
  }
  return [
    `当前可查询项目（${normalizedProjects.length} 个）：`,
    ...normalizedProjects.map(project => `- ${project}`),
  ].join("\n");
}

export function buildMcpEnvironmentQueryNotice(
  activeCommand?: string,
  defaultCommand?: string,
) {
  const normalizedActive = activeCommand ? normalizeCommandKey(activeCommand) : "";
  const normalizedDefault = defaultCommand ? normalizeCommandKey(defaultCommand) : "";
  if (!normalizedActive || normalizedActive === normalizedDefault) return "";
  return `当前按 ${normalizedActive} 环境查询`;
}

export function prependMcpEnvironmentQueryNotice(
  content: string,
  activeCommand?: string,
  defaultCommand?: string,
) {
  const notice = buildMcpEnvironmentQueryNotice(activeCommand, defaultCommand);
  const normalizedContent = content.trim();
  if (!notice || normalizedContent.includes(notice)) return normalizedContent;
  return normalizedContent ? `${notice}\n\n${normalizedContent}` : notice;
}

export function listMcpHeaderCommands(servers: McpServerConfig[] = []) {
  const commands = new Map<string, { command: string; label: string; serverNames: string[] }>();

  for (const server of servers) {
    for (const profileCommand of Object.keys(server.headerProfiles)) {
      const normalized = normalizeCommandKey(profileCommand);
      const entry = commands.get(normalized) ?? {
        command: normalized,
        label: normalized.replace(/^\//, ""),
        serverNames: [],
      };
      entry.serverNames.push(server.name);
      commands.set(normalized, entry);
    }
  }

  return Array.from(commands.values());
}
