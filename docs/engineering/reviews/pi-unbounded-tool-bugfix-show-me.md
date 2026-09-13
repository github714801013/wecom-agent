# Pi 生命周期改动展示

```text
企业微信消息
  │
  ├─ Pi agent_start / turn_start / 工具事件
  │    └─ 仅用于进度展示；不决定最终完成
  │
  ├─ Pi message_end
  │    └─ 不覆盖最终正文
  │
  └─ Pi agent_end
       ├─ 提取 Pi 最后一条 assistant 文本
       ├─ 标记 piAgentEnded = true
       └─ 允许发送 WeCom final=true 并持久化会话
```

## 本次有效改动

```diff
src/pi-agent-runtime.ts
- prompt().finally(() => ended = true)
+ prompt().finally(() => wake())
+ ended 仅由 Pi agent_end 设置

- 根据过程文本调用 agent.followUp()
+ 删除宿主文本判断与主动续查

src/wecom-adapter.ts
- message_end 覆盖 fullContent
+ 仅 agent_end 提取最终文本

- AgentProgressGuard 中断工具循环
+ 删除主适配器和诊断路径的次数、重复、错误上限

+ 未收到 agent_end 的 Pi 路径不得进入最终交付
```

## 已验证

```text
npx tsc --noEmit && npm test && git diff HEAD --check
→ 退出码 0
→ Pi MCP plugin tests passed
```

未执行真实企微线上请求；当前也没有提交或推送任何改动。
