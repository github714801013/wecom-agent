# 自动续查三分钟固定窗口验证报告

- 验证日期：2026-07-29
- 验证范围：三分钟固定窗口、证据进展守卫、八分钟硬上限、流过期与恢复、心跳、交互控制、会话生命周期、最终评审与终态交付
- 结论：功能相关验证通过，无本次改动引入的阻断问题

## 功能与验证映射

| 验证目标 | 验证命令 | 结果 |
| --- | --- | --- |
| 三分钟固定起点、180000/180001ms 边界、八分钟运行中取消、无进展纠偏 | `node --loader ts-node/esm src/tests/test-auto-verification-loop.ts` | 通过 |
| 最终回复、模型错误、证据不足兜底与单次终态 | `node --loader ts-node/esm src/tests/test-final-reply-delivery.ts` | 通过 |
| 全局工具数量、重复调用和错误保护 | `node --loader ts-node/esm src/tests/test-agent-progress-guard.ts` | 通过 |
| 流式 TTL 边界 | `node --loader ts-node/esm src/tests/test-stream-ttl.ts` | 通过 |
| 流过期后的可恢复上下文 | `node --loader ts-node/esm src/tests/test-stream-pause-resume.ts` | 通过 |
| 心跳持续、进度覆盖与最终内容覆盖 | `node --loader ts-node/esm src/tests/test-progress-overwrite.ts` | 通过 |
| “继续”保留当前任务、停止与替换提问 | `node --loader ts-node/esm src/tests/test-interaction-control.ts` | 通过 |
| 一小时会话过期与状态清理 | `node --loader ts-node/esm src/tests/test-session-expiration.ts` | 通过 |
| Runtime TodoList 最终评审 | `node --loader ts-node/esm src/tests/test-runtime-todolist.ts` | 通过 |
| Agent answer review 收敛 | `node --loader ts-node/esm src/tests/test-answer-review.ts` | 通过 |
| TypeScript 编译 | `npx tsc --noEmit --pretty false` | 通过 |
| 补丁格式 | `git diff --check` | 通过，仅有 LF/CRLF 提示 |

## 基线问题

`node --loader ts-node/esm src/tests/test-session-memory.ts` 失败于“31 分钟后应过期”的旧断言。当前 `SessionManager.SESSION_EXPIRATION_MS` 明确为 `60 * 60 * 1000`，专用的一小时边界测试已通过。

`git diff --exit-code HEAD -- src/session-manager.ts src/tests/test-session-memory.ts` 通过，证明生产会话策略和该旧测试均未被本次任务修改。因此将其记录为既有过时用例，不纳入本次功能阻断，也未扩展范围修改会话过期策略。

## 最终判定

- 计时从本次用户提问的 `streamStartedAt` 固定起算，续查不更新起点。
- 180000ms 仍续查；严格超过 180000ms 后，仅在下一次证据不足判定时停止。
- 续查轮次必须产生新的规范化工具证据；一次纠偏仍无进展时立即给出明确无进展回复。
- 480000ms 硬上限会阻止新轮次并取消运行中的续查。
- 流过期、取消、Human Loop、真实模型错误和全局工具保护保持各自直接退出语义。
- 初次分析与续查共用同一流处理实现，心跳持续到终态发送前统一停止。
