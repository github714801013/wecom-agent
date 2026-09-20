# WeChat Work Agent

企业微信 AI 助手：接收用户消息，通过 LLM + MCP 工具检索代码库，返回业务回答。

## Language

**Business Reply (业务回答)**:
The default reply mode. Agent answers are post-processed by an LLM to convert technical content into concise, human-readable business language. No code, SQL, or technical jargon in the output.
_Avoid_: Formatted reply, simplified reply

**Dev Mode (开发者模式)**:
A session-level toggle that bypasses business reply post-processing, returning the raw technical answer. Activated by `/dev`, deactivated by `/business`.
_Avoid_: Raw mode, technical mode

**Fast Path (快速路径)**:
A routing optimization for simple business questions (≤200 chars, no technical indicators). Skips the planner, MCP tool loading, search loop, and auto-verification pipeline — calls LLM directly with the business prompt and session history. Falls back to the full pipeline if the answer contains uncertainty markers.
_Avoid_: Simple path, quick answer

**Pi Primary Execution Path (Pi 主执行路径)**:
The default evidence-analysis path where Pi autonomously chooses whether and how to use available tools, continues until its own lifecycle ends, and treats a request as normally complete only when the lifecycle provides a valid non-empty assistant result with stop reason `stop`. Host-side progress bookkeeping does not determine completion.
_Avoid_: Full Pipeline, Planner Pipeline, normal path

**Project Scope (项目范围)**:
The codebase or codebases established for a question, resolved from an explicit user target before session-established scope; discovery is only needed when neither exists.
_Avoid_: Repository list, global search scope

**lastRawAnswer (原始回答缓存)**:
A session-level variable storing the pre-rewrite answer from the most recent turn. Enables `/dev` and `/business` to reformat the last answer without re-running the pipeline.
_Avoid_: Cached answer, previous answer

## Context Compression (上下文压缩)

对已累积的会话历史和证据进行有损或无损的体积收敛，以便继续推理；它不同于工具结果压缩：后者只处理单次工具返回。
_Avoid_: Tool result compression, history deletion

## Evidence Completeness (证据完整性)

代码证据至少包含项目范围、文件路径、行号和可定位的关键证据文本；缺少任一项时不能视为可交付的代码证据。
_Avoid_: Search hit, file match

## Pi Session (Pi 会话)

承载 Pi 当前自主执行历史和模型上下文的会话状态；切换执行宿主时可以重置，不等同于业务记忆或用户可见历史。
_Avoid_: Business memory, WeCom session

## MCP Tool Directory (MCP 工具目录)

MCP 服务公开的工具名称、描述和参数约束集合；它描述“可发现的能力”，不等同于一次已经执行的 MCP 查询结果。
_Avoid_: MCP Query, Tool Result

## MCP Query (MCP 查询)

Pi 通过已注册工具向 MCP 服务发起的一次实际调用及其返回；查询耗时包含请求发送、远端处理和结果接收，不等同于工具目录加载耗时。
_Avoid_: MCP Tool Directory, Code Search

## MCP Bridge (MCP 桥接层)

在 MCP SDK 客户端与 Pi 工具之间转换工具目录和调用结果的边界；负责保留传输、范围校验、取消、超时和结果格式语义，不负责替代 Pi 的自主生命周期。
_Avoid_: MCP Adapter Plugin, Pi Session

## Direct MCP Tool (MCP 直连工具)

以独立工具形式注册给 Pi 的现有 MCP 能力；Pi 直接选择工具并触发 MCP Bridge，不包含统一代理工具的搜索、描述和调用流程。
_Avoid_: MCP Tool Directory

## MCP Scope (MCP 范围约束)

由 Bot 配置、请求头 profile 和项目提示共同确定的 MCP 服务及项目访问边界；范围校验必须发生在远端调用前，不能仅依赖模型提示。
_Avoid_: Pi Session, Project Scope
