# LangGraph 回答审核节点计划

## 目标

在现有企业微信智能助手流程中增加独立的回答审核节点：业务 agent 先生成答案，审核节点用单独提示词检查 SQL 正确性、问题回答准确性、证据充分性、枚举/常量语义输出等要求；审核不通过时，把审核意见反馈给业务 agent 循环纠正，循环次数有上限。

## 关键假设

- 当前仓库是 Node/TypeScript 项目，证据为 `package.json`、`tsconfig.json` 和 `@langchain/langgraph` 依赖。
- 现有 `initializeAgent()` 返回对象被 `wecom-adapter.ts` 通过 `agent.stream(..., { streamMode: "messages" })` 消费，必须保持该流式接口兼容。
- 本次不改 MCP 连接超时、不改企业微信卡片协议、不做 Java/Spring 测试 Controller。
- 现有未提交的 `src/prompts/business-prompt.md`、`src/tests/test-business-prompt.ts` 修改保留并纳入最终验证。
- 审核循环默认最多 2 轮，可通过环境变量调整，但不得无限循环。

## 实现步骤

1. 梳理 `src/graph.ts` 中 agent 初始化、prompt 加载、stream 调用边界。
2. 新增 `src/prompts/review-prompt.md`，定义审核节点独立提示词和严格 JSON 输出。
3. 在 `src/graph.ts` 增加审核结果类型、解析函数、审核执行函数，以及兼容 `stream()` 的 reviewed agent 包装器。
4. 保持现有工具调用流式输出不被破坏；业务每轮结束后运行审核，审核失败时附带审核意见再运行下一轮业务 agent。
5. 新增测试覆盖审核 prompt、审核结果解析、审核通过只执行一次、审核失败触发纠正。
6. 执行 TypeScript 编译和相关测试，核对计划、TODO、diff 与验证输出一致。

## 验收标准

- `initializeAgent()` 返回对象仍支持现有 `stream()` 调用方式。
- 审核节点使用独立 prompt，不只是修改业务 prompt。
- 审核失败时，业务 agent 能收到结构化审核意见并进行纠正。
- 审核循环有明确上限，默认最多 2 轮，避免无限循环。
- 测试覆盖通过、不通过、异常 JSON 解析路径。
