---
name: verify
summary: 通过本地隔离的 WeCom WebSocket、MCP 和 OpenAI 兼容服务验证真实进程
---

# 运行面验证

1. 先构建当前工作树，验证入口为 `node dist/index.js`。
2. 使用系统临时目录生成配置，所有 URL 指向本机随机端口；不要连接真实企业微信、MCP 或模型。
3. 本地 WebSocket 服务处理 `aibot_subscribe`、`ping` 和 `aibot_respond_msg` 回执，并发送 `aibot_msg_callback`。
4. 本地 Streamable HTTP MCP 服务至少注册一个只读工具；本地 OpenAI 兼容 SSE 服务先返回工具调用，再返回 `stop` 最终文本。
5. 捕获最终 stream 内容、模型可见工具名、MCP `tools/list`/`tools/call` 次数、模型调用次数和子进程日志。
6. 关键探针：同一用户完成查询后发送“清理会话”再查询；空闲时发送“停止”。
7. 临时驱动和配置只放系统 temp，结束后删除；不得读取或打印真实配置中的环境变量值。
