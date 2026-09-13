# remove-todo-compress-tools 调研记录

## 范围与执行方式

- 任务：`remove-todo-compress-tools`
- 范围：当前工作区 `D:\workplace\typescript\wecom-agent`
- 证据来源：`source=local_search`、`authority=non_gitnexus`
- 说明：GitNexus 索引中未发现当前仓库；本记录复用本任务此前已完成的同范围只读调研结果，本次审查回退不重复调研。

## 已确认链路

- 企业微信主请求由 `src/wecom-adapter.ts` 驱动 Pi 主执行路径。
- Pi 工具执行边界位于 `src/pi-agent-runtime.ts`，工具结果经 `src/pi-tool-result-compressor.ts` 压缩；大结果由 `src/tool-result-store.ts` 保存并由 `tool_result_file_read` 按需读取。
- GitNexus 工具加载和项目范围过滤位于 `src/mcp-client.ts`，主路径在已知项目范围时过滤项目发现工具。
- 主路径正常完成语义由非空 assistant 文本与 `agent_end(stop)` 共同决定；独立诊断/自动验证路径仍可保留其自身兼容逻辑。

## 取证限制

本地检索不能证明完整调用图、跨项目影响面或完整消费者集合；实现与验证阶段应以工作区源码、测试和运行结果继续核对。

## 复用依据

本任务 code-review 阶段已接收此前 gitnexus-inquiry 子代理的同范围结果；用户明确要求“不得重复调研”。本文件仅补登记正式记录，不新增远端检索或外部写入。
