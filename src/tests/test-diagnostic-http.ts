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

  const thinkNoiseResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "progress",
      content: "</think></think></think>已读取第 510-570 行，继续核实中。",
    }),
  });
  assert.equal(thinkNoiseResponse.status, 200, "think noise evaluate endpoint should be callable");
  const thinkNoise = await thinkNoiseResponse.json() as any;
  assert.equal(thinkNoise.collapsed, "已读取第 510-570 行，继续核实中。");
  assert.doesNotMatch(thinkNoise.streamContent, /<\/?think/i);

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
  assert.doesNotMatch(auditFallback.reply, /请补充以下任一信息后我继续查/);
  assert.match(auditFallback.reply, /请说明你指的具体字段、按钮或区域/);
  assert.doesNotMatch(auditFallback.reply, /审核未完成/);
  assert.doesNotMatch(auditFallback.reply, /project_scope_audited|runtime_todolist_update/);

  const modelFallbackResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "audit-fallback",
      question: "你用了哪些模型",
      itemIds: ["project_scope_audited", "evidence_audited"],
    }),
  });
  assert.equal(modelFallbackResponse.status, 200, "model fallback evaluate endpoint should be callable");
  const modelFallback = await modelFallbackResponse.json() as any;
  assert.match(modelFallback.reply, /你用了哪些模型/);
  assert.match(modelFallback.reply, /哪个助手、哪次会话或哪个时间范围内的模型调用记录/);
  assert.doesNotMatch(modelFallback.reply, /你说的“这里”/);
  assert.doesNotMatch(modelFallback.reply, /具体指页面上的哪个字段或区域/);

  const llmModelFallbackResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "audit-fallback",
      question: "你用了哪些模型",
      itemIds: ["project_scope_audited", "evidence_audited"],
      llmReply: "我需要确认你问的是哪个助手、哪次会话或哪个时间范围内的模型调用记录。",
    }),
  });
  assert.equal(llmModelFallbackResponse.status, 200, "llm audit fallback endpoint should be callable");
  const llmModelFallback = await llmModelFallbackResponse.json() as any;
  assert.equal(
    llmModelFallback.reply,
    "我需要确认你问的是哪个助手、哪次会话或哪个时间范围内的模型调用记录。",
    "debug audit fallback should support LLM-generated guidance",
  );

  const guardedCurlAuditFallbackResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "audit-fallback",
      question: `curl -k -i --raw -o 0.dat -X POST -d "sub_id=18117666&sub_check=2&TakeMobile=&mobile_basket_id=&confirmInfo=" "https://oa.dev.9ji.com/addOrder/subCheckOp"
这个接口报这个异常是什么原因：SN校验不通过，000002 不可售,未查到
【图片识别结果】
原因分析/调用链/代码位置：subCheckOp(sub_check=2) -> CheckSubKcGovSn -> payGatewayServices.SnQuery() -> orderServices.cs:6516`,
      itemIds: ["project_scope_audited", "evidence_audited"],
      llmReply: `从 curl 来看，TakeMobile、mobile_basket_id、confirmInfo 三个参数都是空的。想确认几点：
1. 这三个参数是否应该有值？
2. mobile_basket_id 是否应该等于 Referer 里的 basketid？
3. 这个 sub_check=2 之前是否先经过了 sub_check=1？`,
    }),
  });
  assert.equal(guardedCurlAuditFallbackResponse.status, 200, "guarded curl audit fallback endpoint should be callable");
  const guardedCurlAuditFallback = await guardedCurlAuditFallbackResponse.json() as any;
  assert.doesNotMatch(guardedCurlAuditFallback.reply, /想确认几点/);
  assert.doesNotMatch(guardedCurlAuditFallback.reply, /TakeMobile.*是否应该有值/);
  assert.doesNotMatch(guardedCurlAuditFallback.reply, /mobile_basket_id.*basketid/);
  assert.doesNotMatch(guardedCurlAuditFallback.reply, /sub_check=1/);
  assert.match(guardedCurlAuditFallback.reply, /接口路径或请求参数锚点|继续围绕 subCheckOp/);

  const curlAuditFallbackResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "audit-fallback",
      question: "curl 'https://oawcf2.ch999.cn/kcApi/doSendWuLiu' --data-raw 'wlCompany=shunfeng&expressCategory=&wlIds=42836554'\n这个提交顺丰物流单，默认是标快还是特快",
      itemIds: ["project_scope_audited", "evidence_audited"],
    }),
  });
  assert.equal(curlAuditFallbackResponse.status, 200, "curl audit fallback endpoint should be callable");
  const curlAuditFallback = await curlAuditFallbackResponse.json() as any;
  assert.match(curlAuditFallback.reply, /接口路径或请求参数锚点/);
  assert.doesNotMatch(curlAuditFallback.reply, /请补充以下任一信息后我继续查/);
  assert.doesNotMatch(curlAuditFallback.reply, /所在系统、项目、页面、菜单路径或接口地址/);

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

  const curlQuestionHistoryResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "question-history",
      question: "这个提交顺丰物流单，默认是标快还是特快",
      history: [
        {
          role: "user",
          content: "curl 'https://oawcf2.ch999.cn/kcApi/doSendWuLiu' --data-raw 'wlCompany=shunfeng&expressCategory=&wlIds=42836554'",
        },
      ],
    }),
  });
  assert.equal(curlQuestionHistoryResponse.status, 200, "curl question history endpoint should be callable");
  const curlQuestionHistory = await curlQuestionHistoryResponse.json() as any;
  assert.match(curlQuestionHistory.question, /已确认锚点清单/);
  assert.match(curlQuestionHistory.question, /https:\/\/oawcf2\.ch999\.cn\/kcApi\/doSendWuLiu/);
  assert.match(curlQuestionHistory.question, /kcApi\/doSendWuLiu/);
  assert.match(curlQuestionHistory.question, /wlCompany=shunfeng/);
  assert.match(curlQuestionHistory.question, /expressCategory=/);
  assert.match(curlQuestionHistory.question, /wlIds=42836554/);
  assert.doesNotMatch(curlQuestionHistory.question, /pwd=/);

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
