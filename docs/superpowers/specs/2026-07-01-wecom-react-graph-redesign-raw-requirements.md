# 原始需求归档

## 原始文本需求

> 使用技能:dev-spec-gen 按下面规划重新设计react
>
> 1. 推荐图结构
> START
>   -> init
>   -> plan
>   -> act
>   -> evaluateAction
>       -> executeTool
>       -> final
>       -> askUser
>       -> revisePlan
>       -> abort
>
> executeTool
>   -> observeUpdate
>   -> evaluateProgress
>       -> act
>       -> revisePlan
>       -> final
>       -> askUser
>       -> abort
>
> final / askUser / abort
>   -> END
>
> 关键设计：
>
> act：只决定下一步动作
> evaluateAction：判断动作是否合法、是否重复、是否超预算
> executeTool：执行工具
> observeUpdate：沉淀观察结果
> evaluateProgress：判断是否继续、结束、修正计划
>
> 这样能避免 Act -> Tool -> Act -> Tool 原地打转。

## 来源

- 对话/链接：当前 ChatGPT + DevSpace 对话
- Jira/Yuque/文档：无

## 附件语义化记录

| 附件 | 来源/文件名 | 可见内容语义化描述 | 待确认点 |
| :--- | :--- | :--- | :--- |
| 无 | 无 | 无 | 无 |

## 初步理解

- 当前企微 Agent 的业务分析入口使用 LangChain `createAgent()`，外层只在 `ToolMessage` 返回后通过 `agentProgressGuard` 统计工具结果，属于工具执行后的兜底。
- 本次需要把 ReAct 循环拆成显式控制节点，至少在工具真正调用前增加 `evaluateAction`，拦截重复动作、非法动作和工具预算超限。
- 保留现有 LangChain Agent 和企微流式消费逻辑，优先在工具边界增加确定性控制，降低改造面。

## 初步验收断言

- [ ] 代码中有可复用的 ReAct 图结构定义，覆盖 `START -> init -> plan -> act -> evaluateAction -> ... -> END`。
- [ ] 工具调用前会执行 `evaluateAction`，重复工具动作不会继续触发真实工具执行。
- [ ] 工具预算超限时不会继续执行真实工具，应返回明确控制信息，引导模型进入 `final`、`askUser`、`revisePlan` 或 `abort`。
- [ ] 工具执行完成后有 `observeUpdate` 记录观察结果。
- [ ] `evaluateProgress` 能根据最终内容、待执行工具、观察结果判断下一节点。
- [ ] 新增测试覆盖图结构、重复动作拦截、预算拦截、观察结果沉淀和工具包装行为。
- [ ] 不覆盖本轮开始前已有的 7 个未提交修改文件。

## 迭代补充：用户视角中间状态

> 分析当前项目，现在推送的中间状态设计不友好，有哪些设计思路？
>
> /dev-spec-gen 使用这个技能，改为用户视角
>
> 继续落代码

### 补充理解

- 当前企业微信中间状态存在系统视角暴露问题，例如工具调用、MCP、检索、模型节点、过程标签等内部实现细节会出现在用户可见流式消息中。
- 本轮不重写 Agent 主流程，优先在状态推送出口做统一映射：内部状态继续用于日志和诊断，对用户只展示“正在理解问题 / 正在查询相关信息 / 正在整理回复 / 正在处理”等任务视角文案。
- 运行时 TodoList 仍保留内部审核能力，但心跳步骤展示要转成用户能理解的任务阶段。

### 补充验收断言

- [x] 用户可见中间状态不展示工具名、MCP、RAG、chunk、stream、runtime todo id 等内部实现词。
- [x] 有活跃工具调用时，企业微信只展示“正在查询相关信息，请稍候。”。
- [x] 意图识别、问题规划类状态展示为“正在理解你的问题。”。
- [x] 生成/整理类状态展示为“正在整理回复。”。
- [x] 最终结论类内容不被泛化进度文案覆盖。
- [x] 测试覆盖进度折叠、心跳和诊断接口输出。

## 不适用或暂缓项

- 暂不重写成完整 LangGraph `StateGraph` 手写循环；原因是当前生产链路已深度依赖 LangChain `createAgent()` 的流式输出和企微进度处理，直接替换风险较高。本轮先在工具执行边界增加确定性 ReAct Loop Control。
- 暂不调整配置文件结构；重复阈值先在控制模块内使用默认值，避免影响现有配置解析测试。
- 本轮暂不实现企业微信同一条卡片原地更新能力，只收敛流式中间状态的用户视角展示。
