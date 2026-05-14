# WeCom AI Agent

一个集成企业微信（WeCom）与大模型能力的智能助手，基于 LangChain JS 构建，并支持通过 MCP（Model Context Protocol） 协议无缝对接多种外部工具。

## 核心功能

- **多 MCP 协议支持**：支持并行接入多个 MCP 工具服务器（如数据库、Git 仓库、API 等），让 AI 具备调用私有工具的能力。
- **进度反馈机制**：用户发送请求后，机器人会立即回复“任务处理中”的进度卡片，并在 AI 计算完成后自动替换为最终答案，提升交互体验。
- **消息去重机制**：基于 `msgid` 的去重逻辑，有效防止企业微信因网络重试导致的 AI 重复调用。
- **多模态消息处理**：支持文本、图片（Vision 能力）、语音、视频及多图文消息的解析与响应。
- **系统提示词定制**：通过 `src/prompts/system-prompt.md` 灵活配置助手的身份、风格和业务边界。
- **生产环境就绪**：提供完整的 Docker 部署方案，支持一键发布。

## 配置说明

项目运行需要配置 `.env` 文件。你可以参考以下变量进行设置：

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `WECOM_BOT_ID` | 企业微信机器人 ID | `wa...` |
| `WECOM_BOT_SECRET` | 企业微信机器人 Secret | `...` |
| `WECOM_WS_URL` | 企业微信 WebSocket 服务地址 | `wss://...` |
| `MINIMAX_API_KEY` | MiniMax API Key | `...` |
| `MINIMAX_BASE_URL` | MiniMax 接口 Base URL | `https://api.minimax.chat/v1` |
| `MCP_SERVERS` | MCP 服务器配置（JSON 数组字符串） | `[{"name":"db","url":"http://ip:1248/sse"}]` |

## 快速开始

### 本地开发

1. 安装依赖：
   ```bash
   npm install
   ```
2. 配置环境变量：创建 `.env` 文件并填入上述配置。
3. 启动开发模式：
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
- `src/prompts/system-prompt.md`: 助手的系统提示词配置。

## 注意事项

- **并行处理**：当前版本的回复流与 `msgid` 强绑定，确保了高并发请求下的回复唯一性。
- **去重缓存**：默认在内存中维持最近 1000 条消息的 ID 缓存。如果需要多实例部署，建议将去重逻辑迁移至 Redis。
