# wecom-agent ReAct Graph Redesign Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or equivalent checklist execution. 本计划已并入当前对话计划清单；不要另建并行 TODO 文件。

**Goal:** 将当前 `Act -> Tool -> Act -> Tool` 的隐式循环改造成带动作审核和进度评估的 ReAct 控制结构，优先阻断重复工具调用和工具预算超限。

**Architecture:** 在现有 LangChain `createAgent()` 外层保留原有流式处理，在工具执行边界引入 `react-loop-control`。`act` 仍由模型产生下一步动作；`evaluateAction` 在工具真正执行前判断合法性、重复和预算；`executeTool` 调用原工具；`observeUpdate` 记录工具结果；`evaluateProgress` 给出继续、修正、结束、询问或中止的下一节点建议。

**Tech Stack:** Node.js、TypeScript ESM、LangChain createAgent、现有 `node --loader ts-node/esm` 脚本式测试。

**Raw Requirements:** `docs/superpowers/specs/2026-07-01-wecom-react-graph-redesign-raw-requirements.md`

---

### Phase 0: dev-spec-gen 增强检查

- [x] 读取 `dev-spec-gen/SKILL.md`。
- [x] 读取 `workflow-guardrails.md`、`general-specs.md`、`testing-specs.md`；`superpowers-integration-specs.md` 读取被安全检查拦截，按已读取的强制项继续。
- [x] 技术栈识别：`package.json` + `tsconfig.json` 确认为 Node.js + TypeScript ESM + LangChain。
- [x] 工作区污染识别：当前已有 7 个非本轮修改文件，后续不覆盖、不暂存这些文件。
- [x] 原始需求归档：已写入 raw requirements 文件。
- [x] 架构设计模式确认：采用“工具边界控制器 + 最小侵入包装”的状态机控制模式；暂不重写完整 LangGraph 手写循环。

### Phase 1: RED - ReAct Loop Control 测试

**Files:**
- Create: `src/tests/test-react-loop-control.ts`

- [ ] 增加图结构断言：`START/init/plan/act/evaluateAction/executeTool/observeUpdate/evaluateProgress/final/askUser/abort/END` 边完整。
- [ ] 增加重复动作断言：同一工具 + 等价参数超过阈值后进入 `revisePlan`，真实工具不再执行。
- [ ] 增加预算断言：证据工具超过预算后进入 `final`，真实工具不再执行。
- [ ] 增加终态动作断言：`final`、`askUser`、`abort` 分别进入对应终态。

### Phase 2: GREEN - 实现控制模块

**Files:**
- Create: `src/react-loop-control.ts`

- [ ] 导出 `REACT_LOOP_GRAPH`，显式表达用户指定图结构。
- [ ] 实现 `createReactLoopController()`，提供 `evaluateAction`、`observeUpdate`、`evaluateProgress`。
- [ ] 实现 `wrapToolsWithReactLoopControl()`，通过 Proxy 在工具 `invoke/call` 前做动作审核。
- [ ] 对 `runtime_todolist_update` 做非证据工具豁免，不计入证据工具预算。

### Phase 3: 主流程接入

**Files:**
- Modify: `src/graph.ts`

- [ ] `initializeAgent()` 中创建 `reactLoopController`。
- [ ] 用 `wrapToolsWithReactLoopControl()` 包装传入 `createAgent()` 的工具列表。
- [ ] 保留 `createReviewedAgent()` 的流式外观，避免影响 `wecom-adapter.ts` 的消息消费逻辑。

### Phase 3.5: 用户视角中间状态改造

**Files:**
- Modify: `src/progress-updates.ts`
- Modify: `src/wecom-adapter.ts`
- Modify: `src/runtime-todolist.ts`
- Modify: `src/tests/test-progress-overwrite.ts`
- Modify: `src/tests/test-diagnostic-server.ts`
- Modify: `src/tests/test-diagnostic-http.ts`

- [x] 将工具调用、MCP、检索、模型节点等内部过程状态映射为用户可理解阶段。
- [x] 中间状态不再展示工具名、调用参数、MCP、RAG、chunk、stream 等内部实现词。
- [x] 心跳文案改为“正在理解问题 / 正在查询相关信息 / 正在整理回复 / 正在处理”。
- [x] 规划步骤展示改为用户视角，不暴露 runtime todo id 和内部审核项名称。
- [x] 补充进度折叠与诊断接口测试，覆盖用户视角输出。

### Phase 4: 验证

**Commands:**
- `node --loader ts-node/esm src/tests/test-react-loop-control.ts`
- `npx tsc --noEmit --pretty false`

**Expected:**
- 单测通过，能证明重复工具动作和预算超限不会执行真实工具。
- TypeScript 编译通过。

### Phase 5: 审核与交付

- [ ] 核对 raw requirements 与代码/测试是否一一承接。
- [ ] 核对未覆盖文件：不得修改本轮开始前已有的 7 个未提交文件。
- [ ] 输出核心函数调用关系。
- [ ] 输出 Mermaid v8 兼容主流程时序图。
- [ ] 说明验证结果、未验证项和风险点。
