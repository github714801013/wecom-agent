import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// 单次工具结果进入模型上下文的最大长度。超限时受控写入临时文件，
// 模型可先用摘要判断价值，再用 tool_result_file_read 工具分步读取。
export const MAX_TOOL_RESULT_CONTENT_LENGTH = 20000;
export const MAX_STORED_TOOL_RESULT_LENGTH = 1_000_000;
const TOOL_RESULT_HEAD_PREVIEW_LENGTH = 5000;
const STORE_TRUNCATION_MARKER = "\n\n[工具结果超过安全存储上限，后续内容未保存]";
const TOOL_RESULT_FILE_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时
const TOOL_RESULT_CLEANUP_INTERVAL_MS = 60_000;
const MAX_TOOL_RESULT_FILES = 64;
const MAX_TOOL_RESULT_TOTAL_BYTES = 32_000_000;
const TOOL_RESULT_ROOT = path.join(os.tmpdir(), "wecom-agent-tool-results");
const TOOL_RESULT_DIR = path.join(TOOL_RESULT_ROOT, randomUUID());
const TOOL_RESULT_FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const TOOL_RESULT_FILE_READ_MARKER = "__wecomToolResultFileRead";

export function isToolResultFileReadTool(value: unknown) {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)[TOOL_RESULT_FILE_READ_MARKER] === true);
}

function cleanupExpiredToolResultDirectories() {
  try {
    if (!fs.existsSync(TOOL_RESULT_ROOT)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(TOOL_RESULT_ROOT)) {
      const directoryPath = path.join(TOOL_RESULT_ROOT, entry);
      if (directoryPath === TOOL_RESULT_DIR) continue;
      const stat = fs.lstatSync(directoryPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (now - stat.mtimeMs > TOOL_RESULT_FILE_TTL_MS) {
        fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    console.warn("Tool result temp directory cleanup failed:", error);
  }
}

function ensureToolResultDir() {
  if (fs.existsSync(TOOL_RESULT_ROOT)) {
    const rootStat = fs.lstatSync(TOOL_RESULT_ROOT);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("工具结果临时目录无效");
    }
  }
  if (!fs.existsSync(TOOL_RESULT_DIR)) {
    fs.mkdirSync(TOOL_RESULT_DIR, { recursive: true, mode: 0o700 });
  }
  const directoryStat = fs.lstatSync(TOOL_RESULT_DIR);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("工具结果临时目录无效");
  }
  cleanupExpiredToolResultDirectories();
}

function cleanupExpiredToolResults() {
  try {
    if (!fs.existsSync(TOOL_RESULT_DIR)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(TOOL_RESULT_DIR)) {
      const filePath = path.join(TOOL_RESULT_DIR, entry);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        fs.unlinkSync(filePath);
        continue;
      }
      if (now - stat.mtimeMs > TOOL_RESULT_FILE_TTL_MS) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (error) {
    console.warn("Tool result temp cleanup failed:", error);
  }
}

const toolResultCleanupTimer = setInterval(() => {
  cleanupExpiredToolResults();
  cleanupExpiredToolResultDirectories();
}, TOOL_RESULT_CLEANUP_INTERVAL_MS);
toolResultCleanupTimer.unref();

process.once("exit", () => {
  try {
    const stat = fs.lstatSync(TOOL_RESULT_DIR);
    if (!stat.isSymbolicLink() && stat.isDirectory()) {
      fs.rmSync(TOOL_RESULT_DIR, { recursive: true, force: true });
    }
  } catch {
    // 临时目录不存在或无法清理时由后续 TTL 清理兜底。
  }
});

function trimToolResultFiles(requiredBytes = 0) {
  if (requiredBytes > MAX_TOOL_RESULT_TOTAL_BYTES) {
    throw new Error("工具结果超过临时存储总容量上限");
  }
  try {
    if (!fs.existsSync(TOOL_RESULT_DIR)) return;
    const entries = fs.readdirSync(TOOL_RESULT_DIR)
      .map(name => {
        const filePath = path.join(TOOL_RESULT_DIR, name);
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) return null;
        return { name, filePath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .filter((entry): entry is { name: string; filePath: string; size: number; mtimeMs: number } => entry !== null)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    while (entries.length + 1 > MAX_TOOL_RESULT_FILES || totalBytes + requiredBytes > MAX_TOOL_RESULT_TOTAL_BYTES) {
      const oldest = entries.shift();
      if (!oldest) break;
      fs.unlinkSync(oldest.filePath);
      totalBytes -= oldest.size;
    }
    if (entries.length + 1 > MAX_TOOL_RESULT_FILES || totalBytes + requiredBytes > MAX_TOOL_RESULT_TOTAL_BYTES) {
      throw new Error("工具结果超过临时存储总容量上限");
    }
  } catch (error) {
    console.warn("Tool result temp size cleanup failed:", error);
    throw error;
  }
}

export function storeToolResult(content: string): { fileId: string; size: number; storedSize: number; truncated: boolean } {
  ensureToolResultDir();
  cleanupExpiredToolResults();
  const truncated = content.length > MAX_STORED_TOOL_RESULT_LENGTH;
  const storedContent = truncated
    ? `${content.slice(0, MAX_STORED_TOOL_RESULT_LENGTH - STORE_TRUNCATION_MARKER.length)}${STORE_TRUNCATION_MARKER}`
    : content;
  const requiredBytes = Buffer.byteLength(storedContent, "utf-8");
  trimToolResultFiles(requiredBytes);
  const fileId = randomUUID();
  fs.writeFileSync(path.join(TOOL_RESULT_DIR, fileId), storedContent, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  return { fileId, size: content.length, storedSize: storedContent.length, truncated };
}

function readRegularToolResult(filePath: string, expectedStat?: fs.Stats) {
  const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW || 0;
  let descriptor: number | undefined;
  try {
    const pathStat = expectedStat || fs.lstatSync(filePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return undefined;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.dev !== pathStat.dev
      || stat.ino !== pathStat.ino
      || Date.now() - stat.mtimeMs > TOOL_RESULT_FILE_TTL_MS
    ) return undefined;
    return fs.readFileSync(descriptor, "utf-8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readStoredToolResult(fileId: string, offset = 0, limit = 8000): string {
  const safeId = String(fileId);
  if (!TOOL_RESULT_FILE_ID_PATTERN.test(safeId)) {
    return `[tool_result_file] 文件标识无效: ${fileId}`;
  }
  const filePath = path.join(TOOL_RESULT_DIR, safeId);
  if (!fs.existsSync(filePath)) {
    return `[tool_result_file] 文件不存在或已清理: ${fileId}。临时文件保存 2 小时后自动清理。`;
  }
  let fileStat: fs.Stats;
  try {
    fileStat = fs.lstatSync(filePath);
  } catch {
    return `[tool_result_file] 文件不存在或已清理: ${fileId}。临时文件保存 2 小时后自动清理。`;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    return `[tool_result_file] 文件标识无效: ${fileId}`;
  }
  if (Date.now() - fileStat.mtimeMs > TOOL_RESULT_FILE_TTL_MS) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // 文件可能已被并发清理，读取端仍按过期结果处理。
    }
    return `[tool_result_file] 文件已过期: ${fileId}。临时文件保存 2 小时后自动清理。`;
  }
  const content = readRegularToolResult(filePath, fileStat);
  if (content === undefined) {
    try {
      const currentStat = fs.lstatSync(filePath);
      if (!currentStat.isSymbolicLink() && currentStat.isFile() && Date.now() - currentStat.mtimeMs > TOOL_RESULT_FILE_TTL_MS) {
        fs.unlinkSync(filePath);
        return `[tool_result_file] 文件已过期: ${fileId}。临时文件保存 2 小时后自动清理。`;
      }
    } catch {
      // 文件可能已被并发清理，保留无效标识语义。
    }
    return `[tool_result_file] 文件标识无效: ${fileId}`;
  }
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(100, Math.min(20000, Math.floor(limit))) : 8000;
  const start = Math.min(safeOffset, content.length);
  const end = Math.min(content.length, start + safeLimit);
  const slice = content.slice(start, end);
  const hasMore = end < content.length;
  return `${slice}${hasMore ? `\n\n[已读 ${start}-${end}/${content.length}，可用 offset=${end} 继续读取。]` : ""}`;
}

export function buildToolResultFileReadTool() {
  const resultReadTool = tool(
    async ({ fileId, offset, limit }) => readStoredToolResult(fileId, offset ?? 0, limit ?? 8000),
    {
      name: "tool_result_file_read",
      description:
        "分步读取已保存的大体积工具结果临时文件。当某个工具结果提示「结果较大已保存」时，先读头部判断价值，再用 offset 逐段读取后续内容。",
      schema: z.object({
        fileId: z.string().describe("临时文件 ID（在工具结果提示中出现）"),
        offset: z.number().int().min(0).optional().describe("读取起始字符位置，默认 0"),
        limit: z.number().int().min(100).max(20000).optional().describe("本次读取字符数，默认 8000"),
      }),
    },
  );
  Object.defineProperty(resultReadTool, TOOL_RESULT_FILE_READ_MARKER, { value: true });
  return resultReadTool;
}

export function buildStoredToolResultPlaceholder(content: string, condition: string, sourceTruncated = false) {
  const stored = storeToolResult(content);
  const storageTruncated = stored.truncated || sourceTruncated;
  const head = content.slice(0, TOOL_RESULT_HEAD_PREVIEW_LENGTH);
  const storageNotice = storageTruncated
    ? `原始长度 ${stored.size} 字符，超过安全存储上限或序列化边界，已保存前 ${MAX_STORED_TOOL_RESULT_LENGTH} 字符；尾部内容未保存。`
    : `原始长度 ${stored.size} 字符，完整内容已保存。`;
  const readNotice = storageTruncated
    ? "可用 tool_result_file_read 按 offset 读取已保存部分"
    : "如需更多细节请用 tool_result_file_read 工具按 offset 分步读取";
  return `${head}
\n[结果较大已保存] 检索条件：${condition}。${storageNotice} fileId=${stored.fileId}。已展示前 ${TOOL_RESULT_HEAD_PREVIEW_LENGTH} 字符摘要，${readNotice}；建议先用更精确的检索条件缩小范围。`;
}
