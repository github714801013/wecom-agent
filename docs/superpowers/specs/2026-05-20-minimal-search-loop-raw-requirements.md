# Agentic RAG 优化原始需求归档

**Last Updated:** 2026-07-10

## 原始文本需求

> /dev-spec-gen 按agentic rag 的标准流程来优化这个welcom agent

### 2026-07-10 补充反馈

> 使用技能/dev-spec-gen 优化wecom-agent 现在出现下面情况很多，非常影响体验，能查就继续查别问：这次没有查到足够完整的证据，已先结束本轮等待，避免一直显示处理中。
>
> 当前阶段性判断：关键信息已获取。
>
> 还缺少的确认：需要继续核对数据库真实列类型或表结构；需要继续核对 Java 实体字段类型和 Mapper 查询映射。
>
> 回复“继续”，我会基于当前上下文接着查；也可以直接补充仓库、表结构、字段截图或异常上下文。

## 来源

- 当前 ChatGPT + DevSpace 对话
- 本地项目：`D:\workplace\typescript\wecom-agent`
- Jira/Yuque：无
- 附件：无

## 现状证据

- 技术栈：Node.js、TypeScript ESM、LangChain、LangGraph、MCP、企业微信 AI Bot SDK。
- 现有主流程已经包含 Planner、MCP 工具加载、最小检索循环、Compressor、ReAct 工具边界控制、运行时 TodoList、Human Loop、最终回复审核。
- 现有 `createMinimalSearchLoop` 只按 Planner 的静态 Query 顺序检索，Compressor 同时承担压缩和“是否缺信息”的隐式判断。
- 检索结果没有统一的证据去重、相关性/充分性评分结构、查询改写轨迹和明确停止原因。
- `runSearchLoopPrelude` 将证据拼成字符串注入主 Agent，缺少可审计的 Agentic RAG 状态与执行轨迹。
- `createReviewedAgent` 当前只透传业务 Agent 流，不执行已经预留的回答审核、纠正消息和重跑逻辑。
- 最终回复闸门返回 `action="continue"` 时，`wecom-adapter.ts` 直接生成“回复继续”的兜底文本并写入 Human Loop，导致本可继续使用 MCP/代码工具核实的任务被提前交还用户。
- GitNexus `query` 预检索当前按既有性能策略跳过，避免与主 Agent 重复向量查询；本次保留该约束，除非后续有独立性能验证证明可取消。
- 当前分支：`feature/search-iteration`。
- 开始任务前已有未提交修改：
  - `src/prompts/business-base-prompt.md`
  - `src/prompts/business-prompt.md`
  - `src/prompts/review-prompt.md`
  - `src/runtime-todolist.ts`
  - `src/tests/test-business-prompt.ts`
  - `src/tests/test-review-prompt.ts`
  - `src/tests/test-runtime-todolist.ts`
  - `docs/superpowers/specs/2026-07-08-wecom-final-answer-concise-raw-requirements.md`
- 本轮不得覆盖、回滚或混入以上既有修改。

## Agentic RAG 目标流程

1. Route：判断是否需要检索，以及应优先使用哪个工具。
2. Plan：生成有优先级的检索 Query。
3. Retrieve：执行当前 Query，获取结构化证据。
4. Normalize/Deduplicate：按证据标识与内容去重，保留来源信息。
5. Grade：显式判断证据相关性与充分性，并输出缺口。
6. Rewrite/Next Query：证据不充分时，优先执行未使用的规划 Query；必要时根据缺口生成新的 Query。
7. Bound：限制最大检索轮次、最大改写次数和重复 Query，防止原地循环。
8. Package Evidence：把查询轨迹、关键证据、关系索引、代码范围索引、缺口和停止原因交给主 Agent。
9. Synthesize：主 Agent 基于已验证证据回答，必要时继续调用专用工具。
10. Verify/Auto Correct：回答审核判定 `needs_correction` 时，自动携带上一版回答与纠正要求重新运行原业务 Agent，使其继续调用可用工具补证据。
11. Bound：自动纠正严格受 `ANSWER_REVIEW_MAX_ROUNDS` 限制；达到上限后停止，禁止无限循环。
12. Human Loop：仅在审核明确判定 `needs_human_input`、确实依赖外部输入或环境阻塞时触发；不得再用通用“回复继续”代替自主查证。

## 架构设计模式确认

采用“独立 Agentic RAG 编排器 + 现有主链路适配器”模式：

- 新增纯编排模块，负责状态、去重、评分路由、Query 改写和有界停止。
- 保留 `wecom-adapter.ts` 的企微流式、会话、Human Loop 和最终交付逻辑。
- 保留现有 `createMinimalSearchLoop` 作为兼容入口，新增 Agentic RAG 入口供 `runSearchLoopPrelude` 使用。
- Compressor 继续负责上下文压缩，通过适配器输出显式 Grade；不把 Compressor 内部格式直接耦合到编排器。
- 恢复 `createReviewedAgent` 的“业务回答 -> 审核 -> 自动纠正重跑”装饰器模式，复用现有 Agent、工具和流式消费协议，不在 `wecom-adapter.ts` 复制第二套工具流处理器。
- 不修改公共 MCP 工具契约，不新增数据库/API 字段。

## 验收断言

- [x] 存在独立的 Agentic RAG 状态与节点定义，覆盖 plan、retrieve、grade、rewrite、complete/stop。
- [x] 检索证据按 id 或规范化内容去重，重复结果不会重复占用上下文。
- [x] Grade 显式包含 relevant、sufficient、missingInfo、reason。
- [x] 证据充分时立即停止，不继续执行备用 Query。
- [x] 证据不足时优先执行下一条规划 Query；规划 Query 耗尽后使用改写器生成补查 Query。
- [x] 重复 Query、空 Query、改写次数和总迭代次数都有硬限制。
- [x] Prelude 输出停止原因、执行轨迹和改写摘要，不输出工具敏感参数。
- [x] 保留 GitNexus `query` 自动预检索跳过策略。
- [x] 新增正式自动化测试，覆盖充分、补查、改写、重复/空 Query、证据去重和迭代上限。
- [x] TypeScript 编译通过，Minimal Search Loop、Prelude、ReAct 历史测试通过。
- [x] README 核对完成：使用方式和配置无变化，本轮不修改。
- [x] 回答审核为 `needs_correction` 时，业务 Agent 自动继续执行，无需用户回复“继续”。
- [x] 自动纠正轮次复用原问题、上一版回答和审核纠正要求，并可继续调用原有 MCP/代码工具。
- [x] 自动纠正通过 `ANSWER_REVIEW_MAX_ROUNDS` 有界控制，默认允许 5 轮业务 Agent 查证；达到硬上限后不再递归重跑。
- [x] 每轮纠正提示必须要求先穷尽现有 MCP、代码调用链、已保存证据和可访问的 dev/test 数据路径；只有确实依赖用户独有信息、生产只读结果或写操作授权时才允许转 Human Loop。
- [x] 审核明确为 `needs_human_input` 时才进入 Human Loop；`action="continue"` 的兜底回复不再引导用户回复“继续”。
- [x] 企微流式内容在进入纠正轮时覆盖上一版阶段性回答，并清空旧流式快照，避免两版答案叠加或旧答案被最终闸门恢复。
- [x] 新增/更新正式测试，覆盖直接通过、自动纠正后通过、纠正轮次上限、超时跳过审核、明确 Human Loop 和兜底文案。

## 不适用或暂缓项

- 暂不把整个企微 Agent 重写为手写 `StateGraph`；现有流式消费、工具事件、会话恢复和审核逻辑耦合较深，直接替换风险较高。
- 暂不取消 GitNexus 预检索跳过策略；已有专项计划用于降低重复向量检索延迟。
- 暂不新增向量库、重建索引或调整 MCP 服务端检索算法。
- 暂不改变企业微信消息协议、接口字段或配置文件结构。

## 实现与验证证据

- 编排器：`src/agentic-rag.ts`。
- 现有链路适配：`src/graph.ts` 中的 `createAgenticSearchLoop`、`buildAgenticRagGrade`、`runAgenticSearchQueryRewriter` 和 `runSearchLoopPrelude`。
- 自动续查：`src/graph.ts` 中的 `createReviewedAgent` 在 `needs_correction` 时有界重跑原 Agent；`src/wecom-adapter.ts` 只在明确 `human_loop` 时保存待补充状态。
- 流式覆盖：进入纠正轮时同时清空当前正文和 `visibleStreamSnapshots`，防止旧版回答叠加或被重新选为最终回复。
- 正式测试：`src/tests/test-agentic-rag.ts`、`src/tests/test-search-loop-prelude.ts`、`src/tests/test-answer-review.ts`、`src/tests/test-final-reply-delivery.ts`。
- 验证结果：回答审核、最终交付、运行时 TodoList、流式覆盖、Agentic RAG、Search Prelude、ReAct 控制共 7 个测试入口及 TypeScript 编译均通过；项目未集成覆盖率工具，未获得数值化覆盖率报告。

## 迭代记录

- 2026-07-10：新增 Agentic RAG 标准流程优化需求，基于现有 Minimal Search Loop 原地迭代。
- 2026-07-10：完成独立编排器、现有 Prelude 接入、查询改写、证据去重、有界停止和回归验证。
- 2026-07-10：补充“最终审核未通过时能查就自动继续查，不要求用户回复继续”的体验优化需求，重新打开审核循环、Human Loop 和回归测试项。
- 2026-07-10：进一步定位默认仅 2 轮审核导致大量任务过早进入有界兜底；要求默认提升至硬上限 5 轮，并强化每轮先穷尽自主查证路径。
