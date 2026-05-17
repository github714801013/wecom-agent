# 更新搜索规划建议 (Search Plan Hint) 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `src/wecom-adapter.ts` 中更新搜索规划建议，引入 `stripped_combined` 字段并强化代码检索的“红线”约束，防止实例数据泄露到代码搜索中。

**Architecture:** 修改 `src/wecom-adapter.ts` 中 Planner 逻辑块，重新组织 `searchPlanHint` 字符串。

**Tech Stack:** TypeScript, LangChain

---

### Task 1: 修改 `src/wecom-adapter.ts` 中的 `searchPlanHint` 构造逻辑

**Files:**
- Modify: `src/wecom-adapter.ts:168-185`

- [ ] **Step 1: 修改 `searchPlanHint` 字符串模板**

将原有的模板更新为包含 `stripped_combined` 字段，并调整序号和红线内容。

```typescript
<<<<
            // 提供结构化的搜索建议，引导大模型按 MCP 要求进行高效率查询
            const searchPlanHint = `系统提示：【搜索规划建议】
请根据以下优化后的 Query 进行搜索。
1. 关键词合并 (文本搜索 Zoekt): ${plannerResult.combined}
2. 逻辑或 (文本搜索 Zoekt): ${plannerResult.regex}
3. 语义向量 (语义搜索 Vector): ${plannerResult.semantic}

【核心红线】
* 优先使用“关键词合并”进行单次一站式检索。
* 如果意图模糊或关键词检索不到，必须配合使用 \`query\` 工具进行“语义向量”检索。
* 严禁拆分关键词进行多次循环搜索。`;
====
            // 提供结构化的搜索建议，引导大模型按 MCP 要求进行高效率查询
            const searchPlanHint = `系统提示：【搜索规划建议】
请根据以下优化后的 Query 进行搜索。
1. 纯净逻辑词 (优先用于代码检索): ${plannerResult.stripped_combined}
2. 关键词合并: ${plannerResult.combined}
3. 逻辑或: ${plannerResult.regex}
4. 语义向量: ${plannerResult.semantic}

【核心红线】
* **必须**优先使用“纯净逻辑词”进行单次一站式检索。
* **严禁**在代码检索中包含人名、商品名、租户名、订单号等实例数据。
* 如果意图模糊或纯净关键词检索不到，必须配合使用 \`query\` 工具进行“语义向量”检索。
* 严禁拆分关键词进行多次循环搜索。`;
>>>>
```

- [ ] **Step 2: 验证代码编译**

运行：`npm run build`
预期：编译通过，没有语法错误。

- [ ] **Step 3: 提交更改**

```bash
git add src/wecom-adapter.ts
git commit -m "feat: update searchPlanHint to include stripped_combined and enforce search redlines"
```
