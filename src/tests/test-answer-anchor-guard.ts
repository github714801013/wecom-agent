import { strict as assert } from "node:assert";
import {
  extractPriorityAnswerAnchors,
  getMissingPriorityAnswerAnchors,
  repairAnswerForMissingPriorityAnchors,
} from "../answer-anchor-guard.js";

const questionWithHistory = `【历史上下文整合】
相关历史：
已确认锚点清单（必须优先继承，禁止因历史摘要截断而丢弃）：
优先锚点（历史已标记为关键线索，当前追问必须先看）：
- SmallproFilmCardServiceImpl.java
- repurchaseBuyTime
- repurchaseBuyExpireMsg
- oa-after
- 贴膜 年包服务 1年2次 已超过复购时间
旁证/已排除锚点（历史已说明不是直接来源，不得作为主结论）：
- SubServiceImpl.java
- checkYearPackageRepurchase

当前问题：
点 立即购买按钮 提示的 重点看这个后端接口`;

const anchors = extractPriorityAnswerAnchors(questionWithHistory);
assert.deepEqual(anchors, [
  "SmallproFilmCardServiceImpl.java",
  "repurchaseBuyTime",
  "repurchaseBuyExpireMsg",
]);

const missing = getMissingPriorityAnswerAnchors(
  questionWithHistory,
  "结论来自 repurchaseBuyTime，提示为已超过复购时间。",
);
assert.deepEqual(missing, ["SmallproFilmCardServiceImpl.java", "repurchaseBuyExpireMsg"]);

const repaired = await repairAnswerForMissingPriorityAnchors({
  questionWithHistory,
  answer: "结论来自 repurchaseBuyTime，提示为已超过复购时间。",
  model: {
    invoke: async messages => {
      const text = messages.map(message => message.content.toString()).join("\n");
      assert.match(text, /SmallproFilmCardServiceImpl\.java/);
      assert.match(text, /repurchaseBuyExpireMsg/);
      return { content: "SmallproFilmCardServiceImpl.java 的 repurchaseBuyTime 和 repurchaseBuyExpireMsg 共同决定该提示。" };
    },
  },
});
assert.match(repaired, /SmallproFilmCardServiceImpl\.java/);
assert.match(repaired, /repurchaseBuyExpireMsg/);

console.log("answer anchor guard 验证通过");
