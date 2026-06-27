# WeCom AI Agent

一个集成企业微信（WeCom）与大模型能力的智能助手，基于 LangChain JS 构建，并支持通过 MCP（Model Context Protocol） 协议无缝对接多种外部工具。

## 核心功能

- **多 MCP 协议支持**：支持并行接入多个 MCP 工具服务器（如数据库、Git 仓库、API 等），让 AI 具备调用私有工具的能力。
- **进度反馈机制**：用户发送请求后，机器人会立即回复“任务处理中”的进度卡片，并在 AI 计算完成后自动替换为最终答案，提升交互体验。
- **消息去重机制**：基于 `msgid` 的去重逻辑，有效防止企业微信因网络重试导致的 AI 重复调用。
- **多模态消息处理**：支持文本、图片（Vision 能力）、语音、视频及多图文消息的解析与响应。
- **MCP header 切换指令**：通过配置指令切换当前会话的 MCP headers，例如 `/neo` 切换到 neo 项目范围，`/oa` 切换到 oa 项目范围。
- **系统提示词定制**：通过 `src/prompts/business-prompt.md` 灵活配置助手的身份、风格和业务边界。
- **生产环境就绪**：提供完整的 Docker 部署方案，支持一键发布。

## 配置说明

项目运行需要两个配置入口：

- `.env`：只存放密钥和部署环境变量。
- `config/wecom-agent.config.json`：存放格式化 JSON 结构配置，默认不提交仓库。

仓库提供 `config/wecom-agent.config.example.json` 作为模板。真实配置文件支持 `${ENV_NAME}` 占位符，启动时会从 `.env` 或运行环境变量中替换。

| 配置项 | 说明 | 示例 |
| :--- | :--- | :--- |
| `CONFIG_FILE` | 可选，指定 JSON 配置文件路径 | `config/wecom-agent.config.json` |
| `llm.apiKey` | 大模型 API Key，建议写 `${LLM_API_KEY}` | `${LLM_API_KEY}` |
| `llm.baseUrl` | 大模型接口 Base URL，建议写 `${LLM_BASE_URL}` | `${LLM_BASE_URL}` |
| `mcpServers[]` | MCP 服务器列表 | `{"name":"gitnexus","url":"http://ip:1348/sse"}` |
| `bots[]` | 企业微信机器人列表 | `{"name":"robot-a","botId":"${WECOM_ROBOT_A_BOT_ID}"}` |
| `mcpServers[].headerProfiles` | 以指令为 key 的可切换 MCP headers；多个 MCP 使用相同 key 时会同步切换 | `{"/neo":{"projects":"small-oa,jiuyun-oa"}}` |
| `bots[].mcpHeaders` | 指定机器人对指定 MCP server 注入的静态 headers | `{"gitnexus":{"x-robot":"robot-a"}}` |
| `bots[].defaultMcpHeaderCommand` | 机器人默认启用的 MCP header 指令 | `"/oa"` |
| `tools.maxAgentToolResultsPerTurn` | 每轮 Agent 允许的证据工具结果上限，仍可用环境变量 `AGENT_MAX_TOOL_RESULTS_PER_TURN` 临时覆盖 | `64` |

MCP header 指令：

- `/oa`：切换到 `mcpServers[].headerProfiles["/oa"]` 中的项目范围。
- `/neo`：切换到 `mcpServers[].headerProfiles["/neo"]` 中的项目范围。
- 当前会话发送切换指令后，会话生效期间后续问题都会沿用该指令对应的 MCP headers，直到再次发送其它切换指令或清理会话。
- 后续新增 `/pay`、`/front` 等指令时，只需要在相关 MCP 的 `headerProfiles` 中增加同名 key。

多 MCP 同名指令和 bot 默认指令配置示例：

```json
{
  "mcpServers": [
    {
      "name": "gitnexus",
      "headers": {
        "x-server": "gitnexus"
      },
      "headerProfiles": {
        "/oa": {
          "projects": "oa-stock,jiuji-m,9ji-admin"
        },
        "/neo": {
          "projects": "small-oa,jiuyun-oa,neo-oa,jiuyun-moa"
        }
      }
    },
    {
      "name": "db",
      "headers": {},
      "headerProfiles": {
        "/neo": {
          "x-database": "neo-db"
        }
      }
    }
  ],
  "bots": [
    {
      "name": "robot-a",
      "mcpHeaders": {
        "gitnexus": {
          "x-robot": "robot-a"
        }
      },
      "defaultMcpHeaderCommand": "/oa"
    },
    {
      "name": "robot-b",
      "mcpHeaders": {
        "gitnexus": {
          "x-robot": "robot-b"
        }
      },
      "defaultMcpHeaderCommand": "/neo"
    }
  ]
}
```

`robot-a` 未切换时默认使用 `/oa`，`robot-b` 未切换时默认使用 `/neo`。如果用户发送 `/neo`，`gitnexus` 和 `db` 中同名 `/neo` profile 都会在当前会话内生效。

MCP header 合并规则：

- `mcpServers[].headers` 是 MCP server 静态基础 headers。
- `bots[].mcpHeaders[serverName]` 是该机器人对指定 MCP server 的静态 headers。
- `mcpServers[].headerProfiles["/指令"]` 是可切换 headers。
- 同名 header 合并优先级：会话/默认指令 profile headers > 机器人静态 headers > MCP server 静态 headers。
- 未出现在 `mcpHeaders` 中的 MCP server 不会收到该机器人的自定义 headers。

旧的单机器人环境变量配置不再作为运行入口；如需继续使用原密钥名，可以在 JSON 中通过 `${ENV_NAME}` 引用。

## 快速开始

### 本地开发

1. 安装依赖：
   ```bash
   npm install
   ```
2. 配置环境变量：复制 `.env.example` 为 `.env`，填入密钥。
3. 配置机器人和 MCP：复制 `config/wecom-agent.config.example.json` 为 `config/wecom-agent.config.json`，按需调整机器人、MCP server 和 headers。
4. 启动开发模式：
   ```bash
   npm run dev
   ```

### Docker 部署

1. 构建并部署：
   ```bash
   bash deploy.sh
   ```
   *注意：`deploy.sh` 包含了构建镜像、导出、传输到远程服务器及远程启动的完整流程，使用前请确保脚本内的服务器信息正确。*

2. 使用 Docker Compose 启动：
   ```bash
   docker-compose up -d
   ```

## 文件结构

- `src/graph.ts`: 定义智能体的核心逻辑（LangChain Graph）。
- `src/wecom-adapter.ts`: 负责企业微信 SDK 的集成与消息转发。
- `src/mcp-client.ts`: 负责连接并管理多个 MCP 服务器。
- `src/prompts/business-prompt.md`: 助手的系统提示词配置。
- `config/wecom-agent.config.example.json`: 多机器人和 MCP 配置模板。

## 注意事项

- **并行处理**：当前版本的回复流与 `msgid` 强绑定，确保了高并发请求下的回复唯一性。
- **去重缓存**：默认在内存中维持最近 1000 条消息的 ID 缓存。如果需要多实例部署，建议将去重逻辑迁移至 Redis。
