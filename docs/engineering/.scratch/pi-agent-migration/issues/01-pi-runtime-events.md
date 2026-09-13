# 01 — Pi 运行时与统一事件协议

**What to build:** 让单次企业微信问题可由 Pi Agent 运行，并稳定产出文本增量、工具开始、工具更新、工具结束、完成、错误和取消等内部事件，供上层消费。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 通过实际 Pi 类型声明和编译验证创建 Agent、模型和请求生命周期。
- [ ] 请求 deadline、AbortSignal 和迟到事件丢弃可验证。
- [ ] 纯文本和取消场景可通过自动化测试。
