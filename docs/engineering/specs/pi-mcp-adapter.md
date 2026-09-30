# MCP 直连工具与 Pi 原生会话优化规格

## Problem Statement

当前 WeCom Agent 在 Pi 主执行路径中先通过 LangChain MCP adapter 加载并转换 MCP 工具，再把工具集合直接交给模型。现有路径已经具备 MCP transport、Bot/profile 请求头、项目范围过滤、工具白名单、进程内 TTL 与并发加载复用，但额外依赖增加了 MCP 工具转换层，且 Pi 会话仍未使用官方 Coding Agent 的原生会话与 compaction 能力。

上一版方案曾考虑 `pi-smart-compact` 和 `pi-mcp-adapter`，现已明确取消二者：不安装、不接入、不保留其配置发现、代理工具、持久化缓存或 OAuth/UI 能力。

本次目标是减少不必要的 MCP adapter 依赖，保持现有 MCP 查询语义，并将 Pi 执行迁移到官方同进程 `AgentSession`，以获得按业务 session 隔离的 Pi 原生上下文压缩，同时不破坏工具范围、代码证据完整性、请求预算、取消、超时和终态语义。

## Solution

使用项目已有的 MCP SDK transport 直接建立 MCP client，读取工具目录并以最小 MCP bridge 转换为 Pi custom tools。Pi 只看到现有 MCP direct tools，不提供统一 `mcp` 代理工具，不引入第三方 MCP 插件。

将 Pi 主执行宿主迁移到官方 Coding Agent `AgentSession`：

- 每个业务 `sessionKey` 拥有独立的内存 Pi `SessionManager`；
- 使用内存 `SettingsManager`；
- 关闭全部默认 shell、read、edit、write 等内置工具，只启用现有 MCP direct tools 和当前业务需要的内部工具；
- 使用 Pi 原生 compaction，目标在约 60% 上下文占用时为下一次模型调用保留足够空间；
- compaction 的模型调用严格计入原请求 `requestDeadlineMs`；
- compaction 失败、取消、超时或生成结果不可用时，继续使用未压缩上下文；
- Pi session 重置不清理业务 SessionManager 中的 LangChain 历史、业务记忆或用户可见历史；
- 只有非空 assistant 文本且 stop reason 为 `stop` 时才视为正常完成。

## User Stories

1. 作为企业微信用户，我希望代码检索仍能调用现有 MCP 工具，以便继续获得当前业务系统的真实证据。
2. 作为企业微信用户，我希望 MCP 工具的项目范围和请求头 profile 约束继续生效，以避免查询错误项目或越权访问服务。
3. 作为企业微信用户，我希望 MCP 工具返回的代码证据仍包含项目、文件、行号和可定位证据文本，以便回答可复核。
4. 作为企业微信用户，我希望 MCP 服务器暂时不可用时得到明确失败或降级结果，而不是伪造成功结论。
5. 作为企业微信用户，我希望请求取消或超时后不会继续执行无意义的 MCP 调用。
6. 作为企业微信用户，我希望正常回答仍以有效的 Pi `agent_end` 和 `stop` 终态结束。
7. 作为企业微信用户，我希望 Pi 上下文过大时能自动压缩历史，以便长请求继续推理而不是因为上下文膨胀失败。
8. 作为企业微信用户，我希望压缩失败时保留原始未压缩上下文，不因压缩异常丢失已有证据。
9. 作为企业微信用户，我希望清理或切换 Pi 执行状态不会意外清除业务记忆和用户可见历史。
10. 作为不同业务 session 的用户，我希望各自的 Pi 上下文、工具执行历史和 compaction 状态彼此隔离。
11. 作为系统维护者，我希望 MCP client 直接使用官方 MCP SDK，减少不必要的 LangChain MCP adapter 依赖。
12. 作为系统维护者，我希望现有 SSE 和 Streamable HTTP transport 的行为保持一致。
13. 作为系统维护者，我希望相同 Bot、请求头和 profile 的 MCP 工具加载继续复用 TTL 缓存。
14. 作为系统维护者，我希望并发请求加载相同 MCP 工具时复用 pending Promise，不重复建立连接。
15. 作为系统维护者，我希望不同 Bot、profile 或请求头范围不会错误共享 MCP 工具缓存。
16. 作为系统维护者，我希望 MCP bridge 在远端调用前执行项目范围和固定参数校验。
17. 作为系统维护者，我希望 MCP bridge 将远端异常转换为当前 Pi 工具错误语义，并且不泄露凭据或完整敏感参数。
18. 作为系统维护者，我希望工具结果压缩、文件结果读取和请求预算注记继续工作。
19. 作为系统维护者，我希望 Pi 不会获得默认 shell、文件读写或编辑工具。
20. 作为系统维护者，我希望业务 session 的 LangChain 消息能够安全转换为 Pi 可理解的会话上下文，并保留必要的用户、assistant、tool result 关系。
21. 作为系统维护者，我希望 Pi session 的过期、替换、取消和 dispose 路径不会泄漏监听器、定时器或工具调用。
22. 作为系统维护者，我希望模型连接错误、工具错误、取消、超时和普通完成能被区分记录。
23. 作为系统维护者，我希望可以区分 MCP bridge 改造、原生 AgentSession、原生 compaction 和既有摘要修复各自的性能收益。
24. 作为系统维护者，我希望通过脱敏真实轨迹验证新路径，而不是只依赖假模型的无工具测试。
25. 作为系统维护者，我希望只有当新路径的性能和正确性都满足门槛时才替换主路径。

## Implementation Decisions

- 删除 `pi-smart-compact` 依赖及其所有主路径配置、Worker/子进程方案和相关副作用。
- 不引入 `pi-mcp-adapter`。
- 删除 `@langchain/mcp-adapters` 依赖。
- 使用已存在的官方 MCP SDK client 与 transport，增加最小 MCP bridge：将 `listTools` 的工具定义转换为项目内部工具契约，将工具调用转换为 `callTool`，并保留 AbortSignal、超时和错误处理。
- 保留当前 SSE 与 Streamable HTTP transport；本次不新增 stdio transport。
- 保留 Bot/profile 请求头合并、请求头驱动的固定参数、项目范围白名单、GitNexus 项目发现包装、工具允许/排除列表以及进程内 TTL/pending 缓存。
- MCP bridge 必须在调用远端前拒绝超出 MCP Scope 的 repo 或固定参数；拒绝结果继续使用现有配置范围错误语义。
- 保留工具结果压缩、文件结果引用、预算注记和敏感信息脱敏边界。
- 使用官方 Coding Agent `AgentSession`、内存 `SessionManager` 和内存 `SettingsManager`；不使用 Worker、子进程、全局 HOME 修改或文件会话持久化。
- 以业务 `sessionKey` 为索引维护 Pi session；并发请求对同一业务 session 必须串行或由既有任务替换语义控制，不能共享到其他 session。
  - 同一会话的任何普通新消息（文本、图片、mixed、语音或文件）在敏感预检与媒体解析前立即登记为唯一 owner，取消旧请求；只有明确的纯文本“停止/继续”保留控制命令语义，非文本消息不得因空文本被当成“继续”。
  - 新消息只等待同一 Pi session 的旧执行解除订阅、取消和清理完成后再启动；排队中又被替换的消息不得调用模型，不同会话不互相等待。
  - 只允许最新 owner 发送进度、失败提示和最终回复；发送函数实际执行前再次核验 owner。接管前已发送的消息不撤回。
  - 连续多次接管保留有界的旧问题、已确认摘要与最新消息，由 Agent 判断是否同题；不按固定时间窗口无条件拼接，不清空业务历史，不将图片原始 base64 放入 handoff。
  - 取消信号贯穿图片识别；SDK 下载不能立即取消时，丢弃迟到结果，不再启动被替换消息的识别或业务模型。
- Pi session 只承载 Pi 模型上下文和工具执行历史；业务 `SessionManager` 继续承载 LangChain 历史、业务记忆、用户可见历史、MCP headers/profile、repo hints 和人工确认状态。
- Pi 只启用现有 MCP direct tools 及明确允许的业务辅助工具；默认内置工具全部禁用。
- 原生 compaction 以约 60% 上下文占用为目标，通过官方 `reserveTokens` 对齐触发条件；不得用固定工具次数、固定循环次数或宿主循环作为完成条件。
- compaction 和正常模型调用共享同一请求 deadline；超时、取消、错误或压缩结果无效时保留未压缩上下文，并走已有终态降级。
- LangChain 消息转换至少覆盖 user、assistant、tool result；无法安全配对的历史工具消息不得伪造为成功 assistant 结论。
- 正常完成条件仍为非空 assistant 文本和 `stopReason === "stop"`；agent end、普通流结束、超时、取消、模型错误和工具错误不得互相冒充。
- 仅记录安全派生指标：工具加载耗时、工具目录规模、Pi turn 数、实际工具耗时、compaction 次数/耗时、终态和错误类别；不记录用户正文、完整工具参数、请求头或凭据。

## Testing Decisions

测试只验证公共行为接缝，不断言第三方或 Pi Coding Agent 的私有函数、内部 session 存储结构或实现细节。

### MCP 加载与调用接缝

通过现有 MCP 工具加载公共入口和本地可控 MCP HTTP/SSE 服务验证：

- 工具目录读取和 schema 转换；
- SSE 与 Streamable HTTP transport；
- Bot/profile/request headers 合并；
- 项目范围和固定参数拒绝；
- allowed/excluded 工具过滤；
- 相同缓存 key 的 TTL 与 pending Promise 复用；
- 不同范围的缓存隔离；
- `callTool` 结果、远端错误、取消和超时；
- 结果压缩、证据完整性和预算注记。

### Pi 主执行接缝

通过现有 Pi 初始化和事件流公共入口验证：

- 只暴露 direct MCP tools，不暴露默认 shell/read/edit/write；
- 工具调用后继续下一轮模型并产生非空 `agent_end(stop)`；
- 每个 `sessionKey` 的 Pi session 相互隔离；
- Pi session 重置不删除业务记忆和用户可见历史；
- 原生 compaction 在上下文达到目标阈值时执行；
- compaction 失败或超时回退未压缩上下文；
- 请求 deadline 同时约束模型、工具和 compaction；
- 用户取消、请求替换、超时、工具错误和模型错误进入明确非正常终态；
- 慢文本 → 图片 → mixed/文字连续接管，图片解析完成前即取消旧请求，旧任务迟到失败或终态不再发送，仅最后一条消息得到一次最终回复；
- A → B → C 中 B 尚未完成媒体解析时，C 仍可看到 A 的问题和 B 的补充文字，重复投递同一 msgid 不替换当前 owner；
- 使用真实 Pi SDK 与本地 SSE 服务验证同会话取消清理期间的新请求等待、已取消排队请求不进入模型、不同会话并发正常；
- 回复出队后、实际发送前 owner 失效时跳过发送，媒体识别取消不转换为普通解析失败兜底；
- 正常回答保留实际耗时。

### 连续消息接管验证结果

在本地隔离的 WebSocket、MCP、视觉与 OpenAI 兼容服务上运行真实 `dist/index.js`：图片 → 文字 → 图片中前两条最终回复均为 0，最后一条最终回复为 1；最新模型输入包含中间文字问题和最新图片识别结果。旧视觉请求与被替换的慢业务模型连接均已关闭，不同会话可并发完成，明确的“继续/停止/清理会话”保持原语义。

公共入口回归另覆盖 A/B 均已产生部分回答和工具证据后由 C 接管，C 保留双方摘要且仅交付一次最终回复。以上验证接管行为，不证明线上模型回答质量或性能改善幅度。

### 性能验收

使用同一批脱敏真实请求轨迹进行离线或受控环境回放，每组至少 30 条：

- A 组：代码证据摘要修复后的现有 Agent Core 路径，去除未使用依赖但不启用 AgentSession；
- B 组：同样摘要修复 + 官方 AgentSession + Pi 原生 compaction + 本地 MCP SDK bridge。

两组保持模型、输入、MCP 服务、工具范围和请求 deadline 一致。分别记录工具目录/上下文 token、MCP 加载耗时、实际 MCP 调用耗时、Pi turn/compaction 耗时、总请求耗时和终态分布。

接受门槛：B 组 p95 或超过 300 秒请求比例至少改善 15%；代码证据完整性、工具范围、正常 `agent_end(stop)`、取消、超时、错误终态和业务记忆隔离不得回归。未达门槛时不替换主路径。

## Out of Scope

- 不引入 `pi-smart-compact`、`pi-mcp-adapter` 或其他 MCP 代理插件。
- 不使用 MCP 统一代理工具、自动配置发现、OAuth、MCP UI、资源面板或脚本 worker。
- 不重写远端 MCP server、数据库查询、GitNexus 索引或业务接口实现。
- 不保证 bridge 能降低远端服务内部查询执行时间；该时间单独观测。
- 不新增默认 shell、read、edit、write 或其他本地文件系统工具。
- 不使用 Worker、子进程或请求级独立 HOME 目录。
- 不把 Pi session compaction 当作业务记忆压缩或用户可见历史删除。
- 不改变既有业务 SessionManager 的记忆、人工确认和回复模式语义。
- 不增加固定工具总次数、固定循环次数或宿主完成条件。
- 不在本任务中提交、推送、部署或进行未经授权的真实环境流量切换。

## Further Notes

GitNexus 当前未提供本工作区索引，本规格中的当前代码链路证据来自有限的本地只读 fallback，并标记为 `source=local_search`、`authority=non_gitnexus`；本地证据不宣称完整调用图或完整消费者范围。

`pi-mcp-adapter` 的公开能力说明仅用于解释为何本次选择取消该依赖：其代理工具和独立连接管理与当前 direct tools、请求范围和现有缓存契约不一致。当前方案优先选择更小的本地 MCP SDK bridge，以减少依赖并保留既有行为。

实现前必须先写出覆盖 MCP bridge 和 Pi 主执行两个接缝的失败测试，再按纵向切片逐步实现。任何无法由公开 API 验证的宿主行为都必须停止并记录，不得用私有 API 或投机 bridge 假设替代验证。
