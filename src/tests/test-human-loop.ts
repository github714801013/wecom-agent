import {
  buildHumanLoopReply,
  buildHumanLoopResumeContent,
  detectHumanLoopRequest,
  isAmbiguousNewTopicWhilePending,
} from "../human-loop.js";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const clarification = detectHumanLoopRequest(`前置说明
\`\`\`json
{
  "human_loop": {
    "reason": "clarification_required",
    "question": "请补充订单号和环境。",
    "resume_instruction": "用户补充后继续排查订单状态。",
    "context_snapshot": {
      "user_question": "订单状态不对",
      "known_facts": ["用户反馈订单状态异常"],
      "missing_facts": ["订单号", "环境"]
    }
  }
}
\`\`\``);

assertEqual(clarification?.reason, "clarification_required", "should parse clarification reason");
assertEqual(clarification?.question, "请补充订单号和环境。", "should parse question");

const prodSql = detectHumanLoopRequest(JSON.stringify({
  human_loop: {
    reason: "prod_sql_required",
    sql: "SELECT id, status FROM order_info WHERE id = 123 LIMIT 20;",
    expected_result_format: "请返回 id、status 两列。",
    resume_instruction: "根据生产查询结果继续判断状态异常原因。",
    context_snapshot: {
      user_question: "生产订单 123 状态不对",
      known_facts: ["用户指明生产订单"],
      missing_facts: ["生产订单当前状态"],
    },
  },
}));

assertEqual(prodSql?.reason, "prod_sql_required", "should parse prod sql reason");
assertEqual(buildHumanLoopReply(prodSql!).includes("我无法直接查询生产库"), true, "prod sql reply should explain boundary");
assertEqual(buildHumanLoopReply(prodSql!).includes("SELECT id, status FROM order_info"), true, "prod sql reply should include SQL");

const unsafeSql = detectHumanLoopRequest(JSON.stringify({
  human_loop: {
    reason: "prod_sql_required",
    sql: "UPDATE order_info SET status = 1 WHERE id = 123;",
    resume_instruction: "继续处理",
    context_snapshot: {
      user_question: "修复生产订单",
      known_facts: [],
      missing_facts: [],
    },
  },
}));

assertEqual(unsafeSql, null, "unsafe SQL should be rejected");

const resume = buildHumanLoopResumeContent(prodSql!, "id,status\n123,已支付");
assertEqual(resume.includes("【Human Loop 恢复】"), true, "resume should include marker");
assertEqual(resume.includes("id,status"), true, "resume should include user result");

assertEqual(isAmbiguousNewTopicWhilePending("帮我查会员短信哪里发的"), true, "new task while pending should be ambiguous");
assertEqual(isAmbiguousNewTopicWhilePending("id,status\n123,已支付"), false, "table-like result should be treated as resume input");

console.log("human-loop 协议解析验证通过");
