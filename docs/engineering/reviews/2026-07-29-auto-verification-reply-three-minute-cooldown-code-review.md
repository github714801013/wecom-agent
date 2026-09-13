# 自动续查三分钟固定窗口代码审查

- 审查日期：2026-07-29
- 固定比较点：`d3c649f967f0727d2643995f5399d35269506ced`
- 审查范围：`src/auto-verification-loop.ts`、`src/wecom-adapter.ts`、`src/agent-progress-guard.ts`、`src/tests/test-auto-verification-loop.ts`
- 排除范围：工作区中既有的敏感请求守卫、assets 与其他 workflow 改动

## Standards 审查

审查发现并已处理：

1. 八分钟硬上限原先只在异步轮次结束后检查，慢轮次可能越界。现已在每个轮次和最终评审外层加入固定截止竞争，并通过 `AbortSignal` 取消运行中的续查 stream。
2. 任务取消或流过期后，续查 stream 原先只清空内容并退出循环，仍可能进入最终评审。现改为立即抛出终止信号，不再调用后续模型。
3. 初次分析与续查原先各维护一份约 150 行的 stream 消费逻辑。现统一复用 `runAutoVerificationAgentRound`，避免两条路径行为漂移。
4. 工具调用签名原先在两个模块分别实现。现复用 `agent-progress-guard` 的规范化签名逻辑。

## Spec 审查

审查发现并已处理：

1. 每个昂贵轮次开始前和运行中均受 480000ms 硬上限约束。
2. 首轮达到工具结果、工具错误或递归保护上限后，不再进入自动工具续查；恢复总结仅接受一次最终评审。
3. 工具名按去首尾空白及小写规范化，大小写或空白变体不再被误判为新证据。
4. 保持三分钟固定起点语义：`startedAt` 仍来自本次用户提问的 `streamStartedAt`，续查轮次不更新起点；恰好 180000ms 继续，严格大于 180000ms 的下一次证据不足判定才退出。

## 回归验证

已通过：

- `node --loader ts-node/esm src/tests/test-auto-verification-loop.ts`
- `node --loader ts-node/esm src/tests/test-final-reply-delivery.ts`
- `node --loader ts-node/esm src/tests/test-agent-progress-guard.ts`
- `npx tsc --noEmit --pretty false`
- `git diff --check`

新增覆盖包括：运行中八分钟取消信号、全局保护达限禁止续查、工具名规范化去重、固定三分钟边界与非滚动计时。

## 剩余验证

代码审查无未解决的阻断项。流过期、心跳、单次终态和会话隔离由 verification 阶段的既有集成回归进一步确认。
