# 企微智能助手 最终答案审核闸门 接入设计

Last Updated: 2026-06-26

## 2026-06-26 迭代补充

用户原始补充：

1. 不再需要审核最终答案，效果不好，由 todolist 来控制流程是否完成。
2. todolist 不再是固定的流程，应该是动态的计划流程。

本次理解：

- 移除 `wecom-adapter` 最终发送前的独立 answer review 模型审核链路。
- 保留确定性的最终内容闸门，例如过程话术不可作为最终答案发送。
- Runtime TodoList 不再默认要求固定的六个审核项全部完成，而是根据用户问题、planner 意图、flow_control、最终答案和 SQL 审核证据动态生成本轮需要完成的计划项。
- 若某个审核项没有被动态计划选中，不应因为没调用 `runtime_todolist_update` 而阻塞最终回复。

## 问题根因

模型输出的阶段性过程话术（如"我会继续围绕……去追踪 getInitData……我会把调用链路整理给你"）被当成最终答案直接发送给用户。

根因两层：

1. **review 审核节点在生产路径上没有真正接入。** `createReviewedAgent`（src/graph.ts:1100）是空壳，只转发流，不调用 `runAnswerReview` / `enforceFinalAnswerCompleteness`。这两个函数实现完整，但只在测试里运行。
2. **最终答案的两道正则闸门词表太窄。** `PROGRESS_ONLY_PATTERN`（src/runtime-todolist.ts:37）和 `isProgressSentence`（src/progress-updates.ts:9-10）只认 `继续核实中|继续读取|继续确认|准备输出结论` 这几个固定词。模型换个说法（"我会继续追踪""我会整理给你"）就漏过。

## 设计方案（A + B 双保险）

### 方案 A：把 review 审核节点真正接入最终发送前（治本）

在 `wecom-adapter.ts` 最终发送前（`final_checked` 之前），接入 review 循环：

- 调用 `runAnswerReview` + `enforceFinalAnswerCompleteness` 审核当前 `fullContent`。
- `passed` → 正常发送。
- `needs_correction` → 用 `buildReviewCorrectionMessage` 生成纠正指令，追加到 agent 对话历史，重新执行 agent（受 `ANSWER_REVIEW_MAX_ROUNDS` 限制，默认 2 轮）。
- `needs_human_input` → 转为 Human Loop（`detectHumanLoopRequest` 已有的逻辑）。
- `blocked` → 输出阻塞兜底文案。
- review 使用 `getBaseModel()`，与业务节点同一个模型。

### 方案 B：扩大过程话术正则兜底（安全网）

扩大三处固定词表，保证 review 万一失效也不会把过程话术发出去：

1. `PROGRESS_ONLY_PATTERN`（src/runtime-todolist.ts）：增加第一人称承诺句、未来时态动作词。
2. `isProgressSentence` / `collapsePlainProgressContent`（src/progress-updates.ts）：同步扩大词表。
3. `enforceFinalAnswerCompleteness`（src/graph.ts）：`INCOMPLETE_PROGRESS_PATTERNS` 同步扩大。

新增识别模式（覆盖用户报告的真实漏网话术）：
- 第一人称承诺：我会/我将 + 继续追踪/继续核实/继续读取/整理/排查/确认 + 给你/反馈
- 未来动作：接下来 + 查/读/看/确认/核实
- 承诺后续但无结论的句式

## 实现约束

- review 接入后，最终发送前会多跑最多 2 轮 LLM，增加延迟和 token，已确认可接受。
- review 复用 `getBaseModel()`。
- 改动文件：`src/graph.ts`、`src/wecom-adapter.ts`、`src/runtime-todolist.ts`、`src/progress-updates.ts` 及对应测试。
- 不碰其他历史未提交改动。
- `createReviewedAgent` 空壳保留（不破坏现有测试），实际审核逻辑在 wecom-adapter 发送前直接调用 `runAnswerReview`。

## 验收标准

1. 用户报告的原文"我会继续围绕……去追踪 getInitData……我会把调用链路整理给你"被判为非最终答案，不发送给用户。
2. `runAnswerReview` 在最终发送前被调用，`needs_correction` 时触发再跑一轮。
3. 真正的最终答案（包含结论、原因、处理建议）正常通过审核并发送。
4. 现有测试全部通过。
5. 新增测试覆盖：过程话术负样本、正常结论正样本、review 循环边界。
