import { strict as assert } from "node:assert";
import { evaluateDiagnosticCase } from "../diagnostic-server.js";

const progressResult = evaluateDiagnosticCase("progress", {
  content: "已读取问题，继续核实中。已定位候选文件，继续核实中。",
  activeCall: "> 🔍 正在调用: query...",
});

assert.equal(
  progressResult.streamContent,
  "正在查询相关信息，请稍候。",
  "diagnostic progress case should expose user-facing progress status",
);

const toolResult = evaluateDiagnosticCase("tool-context", {
  name: "query",
  args: JSON.stringify({ query: "售后维修撤销按钮" }),
  content: "No results found",
});

assert.equal(toolResult.case, "tool-context");
assert.match(
  toolResult.filteredContent,
  /本次检索未获得相关结果/,
  "diagnostic tool-context case should expose actual filter result",
);

const humanLoopResult = evaluateDiagnosticCase("human-loop", {
  content: JSON.stringify({
    human_loop: {
      reason: "clarification_required",
      question: "请补充项目名",
      resume_instruction: "拿到项目名后继续定位按钮权限",
      context_snapshot: {
        user_question: "撤销按钮权值是什么",
        known_facts: [],
        missing_facts: ["项目名"],
      },
    },
  }),
});

assert.equal(
  humanLoopResult.request?.reason,
  "clarification_required",
  "diagnostic human-loop case should expose actual parser result",
);

console.log("diagnostic server 规则查询验证通过");
