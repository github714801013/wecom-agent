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
