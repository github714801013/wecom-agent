# Pi 自主完成与工具证据按需读取

企业微信主执行路径不再把运行时 Todo、宿主提示或状态 bookkeeping 作为最终回复的放行条件；正常完成只由 Pi 生命周期产生的有效 `agent_end(stop)` 非空助手结果决定。工具结果在 Pi 的工具执行返回边界按工具类型压缩：已知项目范围时不注册 `list_repos`，未知范围时只返回最小项目定位字段；`query` 与大型 `code_snippet` 返回结构化证据摘要，并将受文件标识、大小、数量和 TTL 约束的结果交给 `tool_result_file_read` 按需读取，解析失败也使用安全占位符，避免上下文膨胀，同时不设置工具调用预算或宿主循环上限。

## Considered Options

- **保留 Todo 作为最终放行条件** — rejected because it adds host-side completion control and caused unnecessary尾部模型轮次。
- **在 adapter 消费事件后再压缩 ToolMessage** — rejected because the Pi 可能已经基于原始工具结果构造下一轮请求；压缩必须发生在 execute 返回边界。
- **截断并丢弃大型工具结果** — rejected because代码证据可能丢失；在安全存储上限内保留结果供按需读取，超出上限时明确标记受控截断。
- **设置固定工具/递归预算** — rejected because工具选择、继续与完成应由 Pi 自主决定。
