# 02 — Pi 主执行路径去 Todo 化

**What to build:** 让企业微信主 Pi 执行路径不再因内部 Todo 更新或完成状态产生额外模型轮次或阻塞答案；Pi 仅以有效的 `agent_end(stop)` 非空 assistant 结果正常完成。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 主 Pi 路径不再向模型注入 Todo 指令、Todo 状态或 Todo 工具。
- [ ] 主 Pi 路径不再更新 Todo bookkeeping，也不依赖 Todo 状态放行、拦截或改写最终回复。
- [ ] 有效 `agent_end(stop)` 非空 assistant 结果可直接产生正常最终回复。
- [ ] aborted、error、非 stop、空文本和普通流结束仍不得冒充正常完成。
- [ ] 诊断及其他独立流程使用的 Todo 类型和行为不在本任务范围内被整体删除。
- [ ] 主请求集成测试覆盖无 Todo 工具、多次自主工具调用和生命周期终态回归。
