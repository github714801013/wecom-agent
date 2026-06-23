import { strict as assert } from "node:assert";
import { startDiagnosticServer, stopDiagnosticServer } from "../diagnostic-server.js";

process.env.DIAGNOSTIC_HOST = "0.0.0.0";
process.env.DIAGNOSTIC_PORT = "3011";

const server = startDiagnosticServer();

try {
  await new Promise(resolve => setTimeout(resolve, 300));

  const statusResponse = await fetch("http://127.0.0.1:3011/__debug/status");
  assert.equal(statusResponse.status, 200, "status endpoint should be callable without WeCom");
  const status = await statusResponse.json() as any;
  assert.equal(status.ok, true);
  assert.deepEqual(status.cases, ["progress", "tool-context", "human-loop", "audit-fallback", "question-history", "agent-question"]);

  const evaluateResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "progress",
      content: "已读取问题，继续核实中。已定位候选文件，继续核实中。",
      activeCall: "> 🔍 正在调用: query...",
    }),
  });
  assert.equal(evaluateResponse.status, 200, "evaluate endpoint should be callable without WeCom");
  const evaluate = await evaluateResponse.json() as any;
  assert.equal(evaluate.collapsed, "已定位候选文件，继续核实中。");
  assert.equal(evaluate.streamContent, "已定位候选文件，继续核实中。\n\n> 🔍 正在调用: query...");

  const overwriteResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "progress",
      content: "已读取问题，继续核实中。\n\n> 🔍 正在调用: query...\n\n已命中入口，继续核实中。",
      activeCall: "> 🔍 正在调用: code_snippet...",
    }),
  });
  assert.equal(overwriteResponse.status, 200, "overwrite evaluate endpoint should be callable");
  const overwrite = await overwriteResponse.json() as any;
  assert.equal(overwrite.streamContent, "已命中入口，继续核实中。\n\n> 🔍 正在调用: code_snippet...");

  const auditFallbackResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "audit-fallback",
      question: "常用资产历史价显示这里的取值逻辑帮我看看",
      itemIds: ["project_scope_audited", "evidence_audited"],
    }),
  });
  assert.equal(auditFallbackResponse.status, 200, "audit fallback evaluate endpoint should be callable");
  const auditFallback = await auditFallbackResponse.json() as any;
  assert.equal(auditFallback.case, "audit-fallback");
  assert.match(auditFallback.reply, /常用资产历史价/);
  assert.match(auditFallback.reply, /请补充/);
  assert.doesNotMatch(auditFallback.reply, /审核未完成/);
  assert.doesNotMatch(auditFallback.reply, /project_scope_audited|runtime_todolist_update/);

  const questionHistoryResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "question-history",
      question: "点 立即购买按钮 提示的 重点看这个后端接口",
      history: [
        { role: "user", content: "保护膜详情页，弹窗提示贴膜 年包服务 1年2次 已超过复购时间！" },
        {
          role: "system",
          content: `【本轮工具上下文摘要】 有效工具证据: ${"摘要 ".repeat(120)}
repo=oa-api filePath=oaapi-service/src/main/java/com/jiuji/oaapi/service/impl/SubServiceImpl.java method=checkYearPackageRepurchase`,
        },
        {
          role: "assistant",
          content: `${"继续核实中。".repeat(120)}
第二次检索命中了关键线索：oa-after 仓库 SmallproFilmCardServiceImpl.java 中的 repurchaseBuyTime（743行）和 repurchaseBuyExpireMsg（760行）。`,
        },
      ],
    }),
  });
  assert.equal(questionHistoryResponse.status, 200, "question history evaluate endpoint should be callable");
  const questionHistory = await questionHistoryResponse.json() as any;
  assert.equal(questionHistory.historyCount, 3);
  assert.match(questionHistory.question, /已确认锚点清单/);
  assert.match(questionHistory.question, /oa-after/);
  assert.match(questionHistory.question, /oa-api/);
  assert.match(questionHistory.question, /SmallproFilmCardServiceImpl\.java/);
  assert.match(questionHistory.question, /SubServiceImpl\.java/);
  assert.match(questionHistory.question, /repurchaseBuyTime/);
  assert.match(questionHistory.question, /repurchaseBuyExpireMsg/);
  assert.match(questionHistory.question, /立即购买按钮/);

  const askValidationResponse = await fetch("http://127.0.0.1:3011/__debug/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(askValidationResponse.status, 400, "ask endpoint should validate required question");
  const askValidation = await askValidationResponse.json() as any;
  assert.equal(askValidation.ok, false);
  assert.match(askValidation.error, /question is required/);
} finally {
  await stopDiagnosticServer(server);
}

console.log("diagnostic HTTP 查询验证通过");
