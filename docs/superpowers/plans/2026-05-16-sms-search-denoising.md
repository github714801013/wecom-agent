# SMS Search Denoising Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让企业微信 agent 在排查短信模板/推送来源时优先使用去实例化检索词，避免品牌、租户、文案全文导致 GitNexus/Zoekt 搜索为空。

**Architecture:** 在 Planner 输出结构中补齐 `stripped_combined`，在提示词中明确区分“原始业务词”和“纯净逻辑词”。WeCom 适配器优先注入 `stripped_combined`，缺失时回退到现有 `combined`，保持兼容。

**Tech Stack:** TypeScript, LangChain, MCP GitNexus

---

### Task 1: Planner 输出契约补齐

**Files:**
- Modify: `src/graph.ts`
- Modify: `src/prompts/planner-prompt.md`

- [ ] **Step 1: 扩展 `PlannerResult.code_terms` 类型**

在 `src/graph.ts` 的 `PlannerResult.code_terms` 中增加可选字段：

```typescript
stripped_combined?: string;
```

- [ ] **Step 2: 更新 planner prompt 的 JSON 契约**

在 `src/prompts/planner-prompt.md` 中要求：

```markdown
- combined：保留用户原始业务词和必要代码词，用于理解上下文。
- stripped_combined：剔除品牌名、租户名、人名、手机号、订单号、完整短信文案等实例数据，仅保留业务动作、领域词和技术词。
```

- [ ] **Step 3: 加入短信来源示例**

增加样例：

```json
{
  "normalized_question": "查询会员注册成功短信从哪里触发推送",
  "business_terms": ["会员", "短信", "模板", "推送"],
  "code_terms": {
    "combined": "兴鸿数码 会员 短信 模板 推送 member sms template push send",
    "stripped_combined": "会员 短信 模板 推送 注册 入会 member sms template push send register"
  }
}
```

### Task 2: WeCom 搜索建议注入改造

**Files:**
- Modify: `src/wecom-adapter.ts`
- Modify: `src/prompts/business-prompt.md`

- [ ] **Step 1: 优先使用纯净逻辑词**

在 `src/wecom-adapter.ts` 中新增：

```typescript
const rawCodeTerms = plannerResult.code_terms?.combined || "";
let cleanCodeTerms = plannerResult.code_terms?.stripped_combined || "";
```

当 `cleanCodeTerms` 为空时，沿用当前 english/chinese/mixed 回退逻辑。

- [ ] **Step 2: 调整搜索规划提示**

把提示中的“高优代码检索词 (combined)”改为：

```markdown
【纯净逻辑检索词 (stripped_combined，优先用于 Zoekt/GitNexus 代码检索)】
${cleanCodeTerms}

【原始业务词 (combined，仅用于理解上下文，禁止直接作为代码检索词)】
${rawCodeTerms}
```

- [ ] **Step 3: 更新业务 prompt**

在 `src/prompts/business-prompt.md` 的工具使用规则中改为优先使用 `stripped_combined`；只有查配置、日志、模板全文或纯净词无结果时，才使用 `combined` 的局部关键词。

### Task 3: 验证

**Files:**
- Test: 不新增业务源码测试文件，使用现有 planner 运行方式和 TypeScript 编译验证。

- [ ] **Step 1: 编译验证**

Run:

```powershell
npx tsc --noEmit
```

Expected: 无 TypeScript 编译错误。

- [ ] **Step 2: Planner 样例验证**

Run:

```powershell
@'
import { runPlanner } from './dist/graph.js';
const q = '【兴鸿数码】恭喜您成为兴鸿数码会员 是哪里推送的 这个短信模板中是有的，但是t通这个agent 找不到';
const r = await runPlanner(q);
console.log(JSON.stringify(r?.code_terms, null, 2));
'@ | node --input-type=module
```

Expected: `code_terms.stripped_combined` 存在，并且不包含 `兴鸿数码`、`T通`、完整短信文案。

- [ ] **Step 3: GitNexus 检索验证**

使用纯净词 `会员 短信 模板 推送 注册 入会 member sms template push send register` 在 `oanew` 中应能定位到会员注册成功后的短信发送链路。

