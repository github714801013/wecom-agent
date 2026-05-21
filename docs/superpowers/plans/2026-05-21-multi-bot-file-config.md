# 多机器人文件配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目从 `.env` 单机器人配置改为 JSON 文件化多机器人配置，并支持每个机器人为指定 MCP server 注入自定义 headers；真实密钥保留在 `.env`，JSON 通过 `${ENV_NAME}` 引用。

**Architecture:** `src/config.ts` 负责读取和校验 JSON 配置，`src/mcp-client.ts` 根据当前机器人合并指定 MCP server headers，`src/wecom-adapter.ts` 为每个机器人启动独立 `WSClient`。旧环境变量入口不保留兼容逻辑。

**Tech Stack:** TypeScript, Node.js, Zod, LangChain MCP adapters, WeCom AI Bot SDK.

---

## File Structure

- Modify: `src/config.ts`
  - 从 `.env` 环境变量解析改为 JSON 文件解析。
  - 递归解析 `${ENV_NAME}` 占位符，密钥仍由 `.env` 提供。
  - 导出 `BotConfig`、`McpServerConfig`、`AgentConfig` 类型。
- Modify: `src/mcp-client.ts`
  - `getAllMcpTools(botConfig)` 支持机器人级指定 MCP headers。
  - 新增或导出 `buildMcpHeaders(server, botConfig)` 方便测试。
- Modify: `src/wecom-adapter.ts`
  - `startBot(botConfig)` 启动单个机器人。
  - `startBots()` 遍历配置启动多个机器人。
  - 消息处理时按当前机器人加载 MCP tools。
- Modify: `src/index.ts`
  - 调用 `startBots()`。
- Create: `config/wecom-agent.config.example.json`
  - 提供格式化 JSON 配置样例。
- Modify: `.gitignore`
  - 忽略真实 `config/wecom-agent.config.json`。
- Modify: `README.md`
  - 更新配置说明和启动说明。
- Modify: `.env.example`
  - 改为只保留 `CONFIG_FILE` 示例。
- Modify: `docker-compose.yml`
  - 移除旧环境变量，增加 `CONFIG_FILE` 和配置目录挂载。
- Modify or Create: `src/tests/test-config.ts`
  - 验证配置读取、默认路径、机器人指定 MCP header 合并。

## Task 1: Runtime Environment Check

- [ ] **Step 1: Confirm Node and TypeScript environment**

Run:

```powershell
node --version
npx tsc --version
```

Expected: Node and TypeScript versions print successfully.

- [ ] **Step 2: Confirm current git state**

Run:

```powershell
git status --short
```

Expected: Existing unrelated untracked or modified files are recorded and not touched.

## Task 2: Write Failing Header Merge Test

**Files:**
- Modify or Create: `src/tests/test-config.ts`
- Modify later: `src/mcp-client.ts`

- [ ] **Step 1: Add a failing assertion for robot-specific MCP headers**

Add a test script that imports `buildMcpHeaders` from `../mcp-client.js` and verifies:

```ts
const server = {
  name: "gitnexus",
  url: "http://127.0.0.1:1348/sse",
  type: "sse" as const,
  headers: {
    "x-global": "global",
    "x-overlap": "server"
  }
};

const bot = {
  name: "robot-a",
  botId: "bot-id",
  secret: "secret",
  wsUrl: "wss://openws.work.weixin.qq.com",
  mcpHeaders: {
    gitnexus: {
      "x-overlap": "bot",
      "x-robot": "robot-a"
    }
  }
};

const headers = buildMcpHeaders(server, bot);
console.assert(headers["x-global"] === "global");
console.assert(headers["x-overlap"] === "bot");
console.assert(headers["x-robot"] === "robot-a");
```

- [ ] **Step 2: Run test and confirm RED**

Run:

```powershell
npx ts-node src/tests/test-config.ts
```

Expected: FAIL because `buildMcpHeaders` does not exist yet.

## Task 3: Write Failing Env Placeholder Test

**Files:**
- Modify: `src/tests/test-config.ts`
- Modify later: `src/config.ts`

- [ ] **Step 1: Add a failing assertion for env placeholder resolution**

Add:

```ts
process.env.TEST_SECRET_VALUE = "resolved-secret";
const resolved = resolveEnvPlaceholders({
  secret: "${TEST_SECRET_VALUE}",
  nested: {
    header: "token ${TEST_SECRET_VALUE}"
  }
});

console.assert(resolved.secret === "resolved-secret");
console.assert(resolved.nested.header === "token resolved-secret");
```

- [ ] **Step 2: Run test and confirm RED**

Run:

```powershell
npx ts-node src/tests/test-config.ts
```

Expected: FAIL because `resolveEnvPlaceholders` does not exist yet.

## Task 4: Implement File-Based Config

**Files:**
- Modify: `src/config.ts`
- Create: `config/wecom-agent.config.example.json`
- Modify: `.gitignore`

- [ ] **Step 1: Replace env schema with file schema**

Implement:

```ts
import dotenv from "dotenv";
dotenv.config({ override: true });
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
```

- [ ] **Step 2: Add example config**

Create `config/wecom-agent.config.example.json` with the schema from the design document.

- [ ] **Step 3: Ignore real config**

Add to `.gitignore`:

```gitignore
config/wecom-agent.config.json
```

- [ ] **Step 4: Run TypeScript check and expect dependent errors**

Run:

```powershell
npx tsc --noEmit
```

Expected: FAIL because callers still reference old `config.LLM_*` and `config.WECOM_*` fields.

## Task 5: Update LLM Config Consumers

**Files:**
- Modify: `src/graph.ts`
- Modify related test scripts under `src/tests/` that reference old `LLM_*` fields.

- [ ] **Step 1: Replace old LLM field access**

Replace:

```ts
config.LLM_MODEL_NAME
config.LLM_API_KEY
config.LLM_BASE_URL
config.LLM_RECURSION_LIMIT
config.LLM_CONTEXT_WINDOW
```

With:

```ts
config.llm.modelName
config.llm.apiKey
config.llm.baseUrl
config.llm.recursionLimit
config.llm.contextWindow
```

- [ ] **Step 2: Run TypeScript check**

Run:

```powershell
npx tsc --noEmit
```

Expected: Remaining failures only in MCP or WeCom old config consumers.

## Task 6: Update MCP Client for Robot-Specific Headers

**Files:**
- Modify: `src/mcp-client.ts`
- Test: `src/tests/test-config.ts`

- [ ] **Step 1: Add header merge helper**

Implement:

```ts
import type { BotConfig, McpServerConfig } from "./config.js";

export function buildMcpHeaders(server: McpServerConfig, bot?: BotConfig) {
  return {
    ...server.headers,
    ...(bot?.mcpHeaders?.[server.name] || {}),
  };
}
```

- [ ] **Step 2: Change `getAllMcpTools` signature**

Change:

```ts
export async function getAllMcpTools() {
```

To:

```ts
export async function getAllMcpTools(bot?: BotConfig) {
```

Inside the MCP server loop, use:

```ts
const headers = buildMcpHeaders(server, bot);
const requestInit = Object.keys(headers).length > 0 ? { headers } as any : undefined;
```

Use `requestInit` for both `requestInit` and `eventSourceInit`.

- [ ] **Step 3: Update tool filters**

Replace `config.allowedTools` and `config.excludedTools` with:

```ts
config.tools.allowed
config.tools.excluded
```

Treat empty arrays as disabled filters.

- [ ] **Step 4: Run RED test and expect GREEN**

Run:

```powershell
npx ts-node src/tests/test-config.ts
```

Expected: PASS for header merge assertions.

## Task 7: Start Multiple WeCom Bots

**Files:**
- Modify: `src/wecom-adapter.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Change single bot startup signature**

Change:

```ts
export async function startBot() {
```

To:

```ts
import type { BotConfig } from "./config.js";

export async function startBot(botConfig: BotConfig) {
```

Create `WSClient` using `botConfig.botId`, `botConfig.secret`, `botConfig.wsUrl`.

- [ ] **Step 2: Pass robot config into MCP loading**

Change message processing:

```ts
const tools = await getAllMcpTools();
```

To:

```ts
const tools = await getAllMcpTools(botConfig);
```

- [ ] **Step 3: Add `startBots`**

Implement:

```ts
export async function startBots() {
  await Promise.all(config.bots.map(botConfig => startBot(botConfig)));
}
```

- [ ] **Step 4: Update startup**

Change `src/index.ts`:

```ts
import { startBots } from "./wecom-adapter.js";

startBots().catch((err) => {
  console.error("Failed to start bots:", err);
  process.exit(1);
});
```

- [ ] **Step 5: Include robot name in logs**

Update connection and startup logs to include `[${botConfig.name}]`.

## Task 8: Update Documentation and Deployment Config

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Update `.env.example`**

Use `.env.example` for config path and secret placeholders:

```env
# 可选：不设置时默认读取 config/wecom-agent.config.json
CONFIG_FILE=config/wecom-agent.config.json
LLM_API_KEY=your_llm_api_key_here
LLM_BASE_URL=https://your_llm_api_base_url_here
WECOM_ROBOT_A_BOT_ID=your_bot_id_here
WECOM_ROBOT_A_SECRET=your_bot_secret_here
```

- [ ] **Step 2: Update Docker Compose**

Use:

```yaml
environment:
  - CONFIG_FILE=${CONFIG_FILE:-/app/config/wecom-agent.config.json}
volumes:
  - ./config:/app/config:ro
```

- [ ] **Step 3: Update README**

Document:

- `CONFIG_FILE`
- `config/wecom-agent.config.json`
- `bots[].mcpHeaders[serverName]`
- `${ENV_NAME}` placeholder resolution from `.env`
- server headers and robot headers merge rule
- no compatibility with old `.env` single bot variables

## Task 9: Verification Execution

- [ ] **Step 1: Run config/header test**

Run:

```powershell
npx ts-node src/tests/test-config.ts
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript build**

Run:

```powershell
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run production compile**

Run:

```powershell
npx tsc
```

Expected: PASS and `dist/` updates are generated but not manually edited.

## Task 10: Compliance Audit

- [ ] **Step 1: Confirm no unrelated files changed**

Run:

```powershell
git status --short
```

Expected: Only files from this plan plus pre-existing unrelated files are present.

- [ ] **Step 2: Confirm old env config references removed**

Run:

```powershell
rg -n "WECOM_BOT_ID|WECOM_BOT_SECRET|WECOM_WS_URL|LLM_API_KEY|LLM_BASE_URL|LLM_MODEL_NAME|LLM_RECURSION_LIMIT|MCP_SERVERS|ALLOWED_TOOLS|EXCLUDED_TOOLS" src README.md .env.example docker-compose.yml
```

Expected: No old runtime config references remain, except historical explanation if intentionally included in README.

- [ ] **Step 3: Produce final call graph and Mermaid sequence**

Final response must include:

- Modified files
- Verification results
- Unverified items and risks
- Core function call relation
- Mermaid v8-compatible sequence diagram
- Low-efficiency or ambiguous points from the conversation and token-saving suggestions
