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
