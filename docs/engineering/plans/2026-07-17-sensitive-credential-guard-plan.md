# 敏感凭据提问前置拦截实施计划

Last Updated: 2026-07-17

**Goal:** 在企业微信消息进入图片解析、Planner、LLM、MCP 和 Agent 前，确定性拦截索要或提取账号密码等认证秘密的请求。

**Raw Requirements:** `docs/engineering/specs/2026-07-17-sensitive-credential-guard-raw-requirements.md`

**Tech Stack:** TypeScript 6、Node.js ESM、企业微信 WebSocket SDK、LangChain/LangGraph、脚本式 TypeScript 单元测试。

**规范来源:** `/dev-spec-gen`、`workflow-guardrails.md`、`general-specs.md`、`testing-specs.md`、`code-pitfall-guide`。

## 实施切片

- [x] RED：扩展 `src/tests/test-sensitive-request-guard.ts`，覆盖直接索要、来源提取、无动词账号密码、英文问法和安全治理反例。
- [x] GREEN：完善 `src/sensitive-request-guard.ts` 的本地纯函数分类、消息预检文本提取、固定回复和结构化审计。
- [x] 接入：`src/wecom-adapter.ts` 在 `parseWeComMessage` 之前执行守卫，命中后直接回复并返回。
- [x] 审计：命中日志只保留消息 ID、会话标识、分类和凭据类型，不输出完整问题或秘密值。
- [x] 回归：密码重置、Token 过期、鉴权逻辑、脱敏存储、前置拦截讨论和带 `pwd=` 参数的 curl 排障均不误拦截。
- [x] 收敛：`src/sensitive-credential-guard.ts` 仅作为兼容入口转发到统一守卫，不维护第二套正则规则。
- [x] 验证：目标测试、交互控制回归、TypeScript 编译和 `git diff --check` 通过。
- [x] 评审：保留当前工作区已有未提交/已暂存变更，未覆盖、回退或提交其他并行改动。

## 设计约束

- 使用确定性本地规则，不依赖模型做安全分类。
- 强披露、来源提取和明文请求优先拦截；安全治理、故障排查、鉴权代码和脱敏讨论明确放行。
- 不因为文本中出现 `pwd=`、`token=` 就判定为索要凭据，保持现有接口排障能力。
- 被拦截问题不写入会话历史、不调用 Planner、LLM、MCP 或 Agent，也不回显敏感关键词附近的具体值。
- 主消息和引用消息的文本、语音识别、图文混排文本参与预检；纯图片不在本轮安全分类范围内。

## 避坑检查

- 守卫位于真正入口，未只依赖系统提示词或最终答案审核拒绝。
- 正则包含高置信阻断用例和安全治理反例，降低“Token 过期原因”“密码如何重置”等误判。
- 日志与回复不拼接原问题，防止敏感值进入日志、进度卡或会话记忆。
- 单一规则源为 `src/sensitive-request-guard.ts`，兼容模块只转发，避免双重拦截和规则分叉。
- 未修改 MCP 服务端、企业微信 SDK 或现有会话/Agent 公共契约。

## 验证记录

- `node --loader ts-node/esm src/tests/test-sensitive-request-guard.ts`：通过。
- `node --loader ts-node/esm src/tests/test-sensitive-credential-guard.ts`：通过。
- `node --loader ts-node/esm src/tests/test-interaction-control.ts`：通过。
- `npx tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过；仅有工作区既有 LF/CRLF 提示，无空白错误。
