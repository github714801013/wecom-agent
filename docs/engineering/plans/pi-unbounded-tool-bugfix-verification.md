# Pi 生命周期验证记录

## 验证命令

```bash
npx tsc --noEmit && npm test && git diff HEAD --check
```

## 结果
- TypeScript 检查通过。
- Pi MCP plugin tests passed。
- `git diff --check` 无空白错误；Git 仅报告现有 CRLF/LF 转换提示。

## 验证结论
- Pi runtime 只有 `agent_end` 才结束事件消费。
- `prompt()` Promise 结算不会提前结束事件流。
- `message_end` 不再被当作最终答案。
- 主适配器和诊断服务不再以宿主工具数量、重复次数或错误次数中断 Pi 工具循环。

## 未覆盖
尚未连接真实企业微信请求验证线上事件序列；也未新增可控 fake Agent 的生命周期测试。