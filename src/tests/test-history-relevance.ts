import assert from "node:assert/strict";
import {
  classifyHistoryRelevance,
  type ConversationContextItem,
} from "../interaction-control.js";

const baseHistory: ConversationContextItem[] = [
  { role: "user", content: "请帮我排查 XSWL-26474 为什么没有回调" },
  { role: "assistant", content: "当前排查到 XSWL-26474 需要继续看回调日志。" },
];

const wecomAgentHistory: ConversationContextItem[] = [
  { role: "user", content: "优化 D:\\workplace\\typescript\\wecom-agent 的历史会话管理" },
  { role: "assistant", content: "当前在看 wecom-agent 的 session-manager.ts。" },
];

const apiOrderQueryHistory: ConversationContextItem[] = [
  { role: "user", content: "排查 /api/order/query 接口为什么超时" },
  { role: "assistant", content: "当前接口锚点是 /api/order/query。" },
];

const docsPathHistory: ConversationContextItem[] = [
  { role: "user", content: "整理 /docs/api.md 的接口说明" },
  { role: "assistant", content: "当前文档锚点是 /docs/api.md。" },
];

function assertDecision(
  currentQuestion: string,
  expected: "related" | "independent" | "uncertain",
  history: ConversationContextItem[] = baseHistory,
) {
  const actual = classifyHistoryRelevance(history, currentQuestion);
  assert.equal(
    actual.decision,
    expected,
    `${currentQuestion} expected ${expected}, got ${actual.decision}: ${actual.reason}`,
  );
}

assertDecision("继续查", "related");
assertDecision("另外一个问题，帮我看 XSWL-26488 的状态", "independent");
assertDecision("请排查 XSWL-26488 为什么没有回调", "independent");
assertDecision(
  "优化 D:\\workplace\\typescript\\GitNexus 的检索历史",
  "independent",
  wecomAgentHistory,
);
assertDecision(
  "wecom-agent src/session-manager.ts 怎么改",
  "uncertain",
  wecomAgentHistory,
);
assertDecision(
  "这个 a/b 的写法是什么意思",
  "uncertain",
  apiOrderQueryHistory,
);
assertDecision(
  "排查 /api/user/query 为什么超时",
  "independent",
  apiOrderQueryHistory,
);
assertDecision(
  "继续整理 /docs/readme.md",
  "uncertain",
  docsPathHistory,
);
assertDecision("继续排查", "uncertain", []);
assertDecision("   ", "uncertain");
assertDecision("请继续排查 XSWL-26474", "uncertain", baseHistory);
assertDecision("新问题：请继续排查 XSWL-26474", "independent");
assertDecision(
  "请排查 XSWL-26474 为什么没有回调",
  "uncertain",
  [{ role: "user", content: "请帮我排查 XSWL-26474 为什么没有回调" }],
);
assertDecision(
  "请排查 XSWL-26488 为什么没有回调",
  "independent",
  [
    { role: "user", content: "请帮我排查 XSWL-26474 为什么没有回调" },
    { role: "assistant", content: "当前排查到 XSWL-26474 需要继续看回调日志。" },
    { role: "user", content: "继续查日志" },
  ],
);
assertDecision("怎么验证", "related");
assertDecision("帮我整理一下今天的问题", "uncertain");

console.log("history relevance 判断规则验证通过");
