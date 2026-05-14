# 架构设计：集成 Claude Agent SDK 实现动态工具与业务技能

## 1. 背景与目标
为了提升 WeCom 智能体的工具调用稳定性、引入标准化的业务技能（Skills）扩展机制，并利用更先进的上下文管理能力，本项目计划将核心智能体逻辑从 LangChain/LangGraph 迁移至 **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`)。

### 核心目标
*   **引擎替换**：使用 Claude Agent SDK 的 `query` 引擎驱动对话。
*   **动态 MCP 集成**：将现有的 MCP 工具集无缝注入 SDK。
*   **业务技能 (Skills) 扩展**：支持在 `.claude/skills/` 目录下定义结构化的 SOP。
*   **多模态增强**：优化 Base64 图片在 Claude 协议下的传输与理解。

## 2. 详细设计

### 2.1 核心引擎层 (`src/graph.ts`)
*   **SDK 配置**：
    *   `model`: 根据 `.env` 获取（如 `claude-3-5-sonnet`）。
    *   `baseURL`: 指向 `dashscope.ch999.cn/base/v1`（通过 `options` 拦截）。
    *   `apiKey`: 透传环境变量。
*   **工具注入**：
    *   封装 `getClaudeTools()` 方法，将 `mcp-client.ts` 返回的工具转换为 SDK 要求的格式。
*   **技能加载**：
    *   配置 `settingSources` 包含项目根目录，使 SDK 自动扫描 `.claude/skills/`。

### 2.2 工具适配层 (`src/mcp-client.ts`)
*   新增转换逻辑，处理 `JSON Schema` 到 `Claude SDK Tool` 定义的映射。
*   处理权限确认：配置 `permissionMode: "acceptEdits"` 或实现自定义的回调，确保在生产环境下安全运行。

### 2.3 会话适配层 (`src/wecom-adapter.ts`)
*   **输入适配**：将企微解析后的图文混排（Base64）拼装为 SDK 可接受的 Prompt 结构。
*   **输出流转换**：
    *   遍历 `for await (const message of query(...))`。
    *   过滤 `thought` 类型事件。
    *   累加 `text` 片段并通过 `replyStream` 实时更新。
    *   遇到 `toolUse` 时，静默更新状态（如“正在执行 [工具名]...”）。

### 2.4 技能库组织 (`.claude/skills/`)
*   每个技能为一个独立目录，包含：
    *   `SKILL.md`: 定义技能名称、描述及核心指令。
    *   `scripts/`: 可选，供 Agent 执行的辅助脚本。

## 3. 兼容性与风险
*   **协议兼容性**：后端代理必须完全支持 Anthropic 的消息、工具调用及流式返回协议。
*   **多模态限制**：需确认 SDK 对 Base64 图片在非 Anthropic 原生端点下的兼容性。

## 4. 成功标准
1.  成功加载 `.claude/skills/` 下定义的业务技能并按指令工作。
2.  能够通过 SDK 调用现有的 gitnexus 和数据库 MCP 工具。
3.  企业微信端流式响应正常，且不再展示中间思考过程。
4.  自动处理超长对话的上下文总结。
