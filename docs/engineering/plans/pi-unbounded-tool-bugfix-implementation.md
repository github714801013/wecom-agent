# Pi 生命周期实现记录

## 实现范围
- `src/pi-agent-runtime.ts`
  - 删除基于过程文本的 `followUp` 救援及其文本判断。
  - `streamPiEvents()` 与兼容 `stream()` 不再在 `prompt()` Promise 结算时结束事件流。
  - 只由 Pi 发出的 `agent_end` 标记一次运行完成。
- `src/wecom-adapter.ts`
  - `message_end` 不再覆盖最终正文。
  - 最终正文只从 Pi `agent_end` 的最终消息集合取得。
  - 删除主 Pi 路径的工具总数、重复调用及工具错误次数宿主限制。
- `src/diagnostic-server.ts` 与 `src/config.ts`
  - 删除诊断路径和配置中的宿主工具结果数量限制。

## 保留边界
保留 Pi 自身工具循环、单工具超时、请求总超时和取消处理；它们不是工具调用次数管控。

## 验证
已执行：

```bash
npx tsc --noEmit && npm test
```

退出码为 `0`，测试输出为 `Pi MCP plugin tests passed`。
