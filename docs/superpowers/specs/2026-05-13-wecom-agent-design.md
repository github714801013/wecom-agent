# WeCom Agent 设计文档

## 1. 项目概述
构建一个集成企业微信（WeCom）、LangGraphJS 和 MCP 工具（Remote GitNexus）的智能机器人。该机器人将使用 MiniMax-M2.5 模型进行推理，并能通过远程 MCP 服务分析代码。

## 2. 核心架构
### 2.1 技术栈
- **运行时**: Node.js (TypeScript)
- **大模型框架**: LangChain / LangGraphJS
- **通信协议**:
    - 企业微信: WebSocket 长连接 (via `openclaw-wecom`)
    - MCP: SSE (Remote GitNexus)
- **模型**: MiniMax-M2.5 (OpenAPI 兼容接口)

### 2.2 逻辑流
1. **连接层**: 机器人进程通过 WebSocket 连接至企业微信网关，使用 Bot ID 和 Secret 进行鉴权。
2. **路由层**: 接收到消息后，提取文本内容并初始化 LangGraph 状态。
3. **推理层 (React Agent)**: 
    - 使用 `@langchain/langgraph/prebuilt` 的 `createReactAgent`。
    - 模型配置为 ChatOpenAI，指向 DashScope 接口。
    - 工具通过 `@langchain/mcp-adapters` 从远程 SSE 服务器加载。
4. **执行层**: 
    - 如果模型需要分析代码，通过 SSE 发起远程 MCP 调用。
    - 获取结果后，模型生成最终回复。
5. **输出层**: 通过 WebSocket 将回复推送到企业微信。

## 3. 详细设计
### 3.1 外部集成
- **WeCom (Bot 模式)**: 
    - URL: `WECOM_WS_URL`
    - Auth: `WECOM_BOT_ID`, `WECOM_BOT_SECRET`
- **MCP (Remote GitNexus)**: 
    - Type: `sse`
    - URL: `http://10.1.14.177:1348/sse`
- **MiniMax (DashScope)**:
    - Base URL: `https://dashscope.ch999.cn/base/v1`
    - Model: `minimax-m2.5` (确认具体模型标识符)

### 3.2 关键代码模块
- `wecom-adapter.ts`: 封装 `openclaw-wecom` 逻辑，处理 WS 连接与消息分发。
- `graph.ts`: 负责初始化 LangGraph Agent、加载 MCP 工具及模型绑定。
- `index.ts`: 程序入口，加载配置并启动服务。

## 4. 安全与配置
- 使用 `.env` 管理敏感信息。
- `.gitignore` 包含 `node_modules`, `.env`, `dist`。

## 5. 测试方案
- **单元测试**: 模拟 WeCom 消息触发 Graph。
- **集成测试**: 发起真实 MCP 调用并检查回复。
- **本地化验证**: 使用 `AiAutoTestController` (如果适用) 或通过日志验证消息流转。
