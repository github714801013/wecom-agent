# 企业微信会话过期时间调整实施计划

Last Updated: 2026-07-19

**Goal:** 将企业微信 Agent 的内存会话无活动过期时间由 30 分钟调整为 1 小时，同时保持滑动续期和现有过期清理语义不变。

**Raw Requirements:** `docs/engineering/specs/2026-07-19-wecom-session-expiration-raw-requirements.md`

**Tech Stack:** TypeScript 6、Node.js ESM、LangChain 消息对象、脚本式 TypeScript 测试。

**规范来源:** `/dev-spec-gen`、`workflow-guardrails.md`、`general-specs.md`、`testing-specs.md`。

## 实施切片

- [x] RED：新增会话过期边界测试，证明 59 分 59 秒仍保留，超过 60 分钟后清理。
- [x] RED：验证过期清理覆盖消息、项目提示、MCP Header、当前环境命令、待处理人工确认、压缩状态和记忆图。
- [x] GREEN：将 `SessionManager` 的无活动过期阈值最小调整为 1 小时。
- [x] 回归：运行目标测试及项目切换相关测试。
- [x] 验证：执行 TypeScript 编译检查。
- [x] 评审：按 Spec 与 Standards 两轴检查变更范围、边界行为和未提交工作区兼容性。

## 设计约束

- 保持 `getOrCreateSession(sessionKey, true)` 为唯一过期检查入口。
- 保持 `lastActivity` 的现有刷新时机，不改为固定创建时长。
- 不将本次阈值扩展成环境配置，避免无需求支撑的配置传播和文档改动。
- 不修改人工确认 TTL、企业微信流式消息 TTL 或 MCP 工具缓存 TTL。
- 不覆盖 `src/session-manager.ts` 中现有未提交的其他功能改动。

## 测试设计

1. 固定初始时间，创建会话并写入消息、项目提示和 MCP 状态。
2. 时间推进到 59 分 59 秒，调用带过期检查的入口，断言状态保留。
3. 以最近一次活动时间为基准推进超过 60 分钟，再次触发检查，断言状态清空。
4. 断言过期后会话仍可使用，`lastActivity` 被刷新。
5. 执行相关回归测试和 `npx tsc --noEmit --pretty false`。

## 回滚与兼容性

- 回滚仅需恢复单个过期阈值常量及对应测试/文档。
- 会话键规则、会话对象结构、调用方接口和清理字段不变。
- 工作区已有未提交改动保留；不执行 Git 写操作。

## 当前 frontier

- 首个可执行切片：新增 `src/tests/test-session-expiration.ts` 并观察其在 30 分钟实现下失败。
- Blocking edges：无。

## 验证记录

- RED：`node --loader ts-node/esm src/tests/test-session-expiration.ts` 在旧的 30 分钟阈值下失败，59 分 59 秒时会话已被清空。
- GREEN：`node --loader ts-node/esm src/tests/test-session-expiration.ts` 通过。
- 回归：`node --loader ts-node/esm src/tests/test-project-switch-command.ts` 通过。
- 回归：`node --loader ts-node/esm src/tests/test-session-memory-graph.ts` 通过。
- 类型检查：`npx tsc --noEmit --pretty false` 通过。
- 差异检查：目标文件执行 `git diff --check` 无空白错误；仅出现仓库既有 LF/CRLF 转换提示。

## 评审结论

- Spec：1 小时内保留、超过 1 小时清理、滑动续期及清理字段完整性均有自动化测试承接。
- Standards：实现仅调整单个时间阈值，并同步修正相关过期样本；未扩展配置、未改其他 TTL、未做无关重构。
- 工作区兼容性：`src/session-manager.ts` 和 `src/tests/test-project-switch-command.ts` 原有未提交修改均保留，本次分别只改动过期常量和过期样本分钟数。
- Git：未执行暂存、提交或推送。
