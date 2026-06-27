import assert from "node:assert/strict";
import { isFinalAnswerReady } from "../runtime-todolist.js";

// 过程话术负样本：必须被判为非最终答案（不可发送给用户）
const progressSamples = [
  "我会继续围绕已确认的接口路径和代码入口，核实 getInitData 接口返回的全部数据集合具体来自哪些查询逻辑。由于历史上下文中已提供完整的请求信息和代码线索，这部分可以直接通过代码检索和 dev 环境数据继续核实，暂不需要你额外补充信息。",
  "我会继续围绕你提供的 curl 请求、路由信息和请求参数，去追踪 getInitData 这个接口的代码入口，核实它是如何组装返回数据的。",
  "具体会顺着代码里的参数映射和调用链，排查 list 中的数据是由哪段 SQL 查出来的。",
  "我会把调用链路和代码位置整理给你。",
  "接下来去查这个接口的入口方法。",
  "我会去追踪 getInitData 的调用链。",
  "继续核实中。",
];

// 正常最终答案正样本：必须通过审核并可发送
const finalSamples = [
  "结论：getInitData 接口返回的 list 数据来自 t_order 表，按 status=1 过滤，分页查询 current=1 size=20。依据：oa-order 仓库 OrderServiceImpl.java:120。",
  "已核实：作废按钮显示条件是 物流单有ID 且 状态是 1/2/7 且 来源是手动创建。依据：list.vue:85 的 v-if 判断。",
  "原因是 SN 校验不通过，商品编码 000002 当前状态为不可售。依据：SubServiceImpl.java:2350 的 checkSnValid 方法返回 false。",
];

for (const sample of progressSamples) {
  assert.equal(isFinalAnswerReady(sample), false, `应判定为非最终答案：${sample.slice(0, 30)}...`);
}

for (const sample of finalSamples) {
  assert.equal(isFinalAnswerReady(sample), true, `应判定为最终答案：${sample.slice(0, 30)}...`);
}

console.log("过程话术与最终答案判定验证通过");
