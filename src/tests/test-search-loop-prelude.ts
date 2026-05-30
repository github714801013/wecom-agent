import assert from "node:assert/strict";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { runSearchLoopPrelude, extractExplicitRepoHint, extractExplicitRepoHints, extractMcpProjectCandidates, buildMessagesForCurrentTurn, scopeToolsToRepo } from "../graph.js";
import type { CompressorInput, PlannerResult } from "../graph.js";

async function runTest() {
  const calls: any[] = [];
  const plannerResult: PlannerResult = {
    intent: "FLOW",
    secondary_intents: [],
    confidence: 0.9,
    normalized_question: "查询短信模板来源",
    business_terms: ["短信", "模板"],
    code_terms: {
      chinese: ["短信", "模板"],
      english: ["sms", "template"],
      pinyin: [],
      abbr: [],
      mixed: [],
      combined: "短信 模板 sms template",
      stripped_combined: "sms template",
    },
    queries: [
      { query: "sms template", type: "keyword", priority: 1, reason: "精确词" },
      { query: "sendSms template", type: "keyword", priority: 2, reason: "补发送调用" },
    ],
    hypotheses: [],
    search_plan: {
      primary: ["sms template"],
      secondary: ["sendSms template"],
      exclude: [],
    },
    missing_info: [],
  };

  const tools = [{
    name: "gitnexus_query",
    description: "Search code by query",
    schema: {
      shape: {
        query: {},
      },
    },
    invoke: async (args: any) => {
      calls.push(args);
      return args.query === "sms template"
        ? { filePath: "src/sms.ts", content: "入口命中，但缺少发送调用" }
        : { filePath: "src/send.ts", content: "sendSms 调用证据" };
    },
  }];

  const prelude = await runSearchLoopPrelude({
    userQuestion: "短信模板从哪里发送？",
    plannerResult,
    tools,
    compressor: async (input: CompressorInput) => ({
      status: "ok",
      intent: "FLOW",
      partial: false,
      compressed_sections: input.search_results.map((item, index) => ({
        section_id: `s${index}`,
        file_path: item.file_path || "",
        symbol: "",
        kind: "code",
        lines: "",
        score: 1,
        reason: "命中检索词",
        anchors: [],
        content: item.content,
        merged_from: [item.id],
      })),
      call_chain: [],
      key_evidence: input.search_results.map(item => item.content),
      dropped: [],
      missing_info: input.search_results.length === 1 ? ["缺少发送调用"] : [],
      warnings: [],
      errors: [],
      budget: { input_est: 0, output_est: 0, target: 1000, mode: "balanced" },
    }),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.query), ["sms template", "sendSms template"]);
  assert.match(prelude, /【预检索证据】/);
  assert.match(prelude, /sms template/);
  assert.match(prelude, /sendSms 调用证据/);
  assert.doesNotMatch(prelude, /sms template 缺少发送调用/);

  const nonQueryToolCalls: any[] = [];
  const skippedPrelude = await runSearchLoopPrelude({
    userQuestion: "能查询哪些项目",
    plannerResult: {
      ...plannerResult,
      normalized_question: "能查询哪些项目",
      queries: [
        { query: "项目", type: "keyword", priority: 1, reason: "项目清单" },
      ],
    },
    toolIntentResolver: async () => ({ toolName: "gitnexus_list_repos", shouldRunPrelude: false }),
    tools: [{
      name: "gitnexus_query",
      description: "Search code by query",
      schema: { shape: { query: {} } },
      invoke: async (args: any) => {
        nonQueryToolCalls.push(args);
        return { content: "should not be called" };
      },
    }],
    compressor: async () => {
      throw new Error("non-query tool intent should skip prelude");
    },
  });

  assert.equal(skippedPrelude, "");
  assert.equal(nonQueryToolCalls.length, 0);

  const queryIntentCalls: any[] = [];
  const queryIntentPrelude = await runSearchLoopPrelude({
    userQuestion: "查询短信模板来源",
    plannerResult,
    toolIntentResolver: async () => ({ toolName: "gitnexus_query", shouldRunPrelude: true }),
    tools: [{
      name: "gitnexus_query",
      description: "Search code by query",
      schema: { shape: { query: {} } },
      invoke: async (args: any) => {
        queryIntentCalls.push(args);
        return { filePath: "src/sms.ts", content: "query intent evidence" };
      },
    }],
    compressor: async (input: CompressorInput) => ({
      status: "ok",
      intent: "FLOW",
      partial: false,
      compressed_sections: input.search_results.map((item, index) => ({
        section_id: `q${index}`,
        file_path: item.file_path || "",
        symbol: "",
        kind: "code",
        lines: "",
        score: 1,
        reason: "命中检索词",
        anchors: [],
        content: item.content,
        merged_from: [item.id],
      })),
      call_chain: [],
      key_evidence: input.search_results.map(item => item.content),
      dropped: [],
      missing_info: [],
      warnings: [],
      errors: [],
      budget: { input_est: 0, output_est: 0, target: 1000, mode: "balanced" },
    }),
  });

  assert.equal(queryIntentCalls.length, 1);
  assert.match(queryIntentPrelude, /query intent evidence/);

  const gitnexusQueryCalls: any[] = [];
  const skippedGitnexusPrelude = await runSearchLoopPrelude({
    userQuestion: "oa-pc项目 备用机 押金支付 支持哪些支付方式逻辑",
    plannerResult,
    toolIntentResolver: async () => ({ toolName: "query", shouldRunPrelude: true }),
    tools: [{
      name: "query",
      description: "Query the code knowledge graph for execution flows related to a concept.",
      schema: {
        type: "object",
        properties: {
          query: {},
          zoekt: {},
          goal: {},
          max_symbols: {},
          repo: {},
        },
      },
      invoke: async (args: any) => {
        gitnexusQueryCalls.push(args);
        return { content: "slow gitnexus vector search" };
      },
    }],
    compressor: async () => {
      throw new Error("GitNexus query prelude should be skipped");
    },
  });

  assert.equal(skippedGitnexusPrelude, "");
  assert.equal(gitnexusQueryCalls.length, 0);

  const repoHintCalls: any[] = [];
  const repoHintPrelude = await runSearchLoopPrelude({
    userQuestion: "只查 oa-order 短信模板来源",
    plannerResult,
    repoHint: "oa-order",
    toolIntentResolver: async () => ({ toolName: "gitnexus_query", shouldRunPrelude: true }),
    tools: [{
      name: "gitnexus_query",
      description: "Search code by query in a repo",
      schema: { shape: { query: {}, repo: {} } },
      invoke: async (args: any) => {
        repoHintCalls.push(args);
        return { filePath: "src/sms.ts", content: "repo scoped evidence" };
      },
    }],
    compressor: async (input: CompressorInput) => ({
      status: "ok",
      intent: "FLOW",
      partial: false,
      compressed_sections: input.search_results.map((item, index) => ({
        section_id: `r${index}`,
        file_path: item.file_path || "",
        symbol: "",
        kind: "code",
        lines: "",
        score: 1,
        reason: "命中检索词",
        anchors: [],
        content: item.content,
        merged_from: [item.id],
      })),
      call_chain: [],
      key_evidence: input.search_results.map(item => item.content),
      dropped: [],
      missing_info: [],
      warnings: [],
      errors: [],
      budget: { input_est: 0, output_est: 0, target: 1000, mode: "balanced" },
    }),
  });

  assert.deepEqual(repoHintCalls, [{ query: "sms template", repo: "oa-order" }]);
  assert.match(repoHintPrelude, /repo scoped evidence/);

  const schemaWithoutRepoCalls: any[] = [];
  await runSearchLoopPrelude({
    userQuestion: "只查 oa-order 短信模板来源",
    plannerResult,
    repoHint: "oa-order",
    toolIntentResolver: async () => ({ toolName: "gitnexus_query", shouldRunPrelude: true }),
    tools: [{
      name: "gitnexus_query",
      description: "Search code by query",
      schema: { shape: { query: {} } },
      invoke: async (args: any) => {
        schemaWithoutRepoCalls.push(args);
        return { content: "schema without repo evidence" };
      },
    }],
    compressor: async () => ({
      status: "ok",
      intent: "FLOW",
      partial: false,
      compressed_sections: [],
      call_chain: [],
      key_evidence: [],
      dropped: [],
      missing_info: [],
      warnings: [],
      errors: [],
      budget: { input_est: 0, output_est: 0, target: 1000, mode: "balanced" },
    }),
  });

  assert.deepEqual(schemaWithoutRepoCalls, [{ query: "sms template" }]);
  assert.equal(extractExplicitRepoHint("只查 oa-order 短信模板来源", ["oa-order"]), "oa-order");
  assert.equal(extractExplicitRepoHint("只查 OA-ORDER 短信模板来源", ["oa-order"]), "oa-order");
  assert.equal(extractExplicitRepoHint("查询 sms template"), null);
  assert.equal(extractExplicitRepoHint("查询 sms template", ["sms"]), null);
  assert.equal(extractExplicitRepoHint("短信模板来源", ["oa-order"]), null);
  assert.deepEqual(
    extractExplicitRepoHints("只查 oa-pc、oa-after 项目短信模板来源", ["oa-pc", "oa-after"]),
    ["oa-pc", "oa-after"]
  );
  assert.deepEqual(
    extractMcpProjectCandidates([{ headers: { projects: "oa-pc,oa-after" } }]),
    ["oa-pc", "oa-after"]
  );
  assert.deepEqual(
    extractExplicitRepoHints("oa-pc 项目中, 个人业绩统计调用的后端接口是", extractMcpProjectCandidates([{ headers: { projects: "oa-pc,oa-after" } }])),
    ["oa-pc"]
  );

  const scopedToolCalls: any[] = [];
  const [scopedTool] = scopeToolsToRepo([{
    name: "gitnexus_query",
    description: "Search code by query in a repo",
    schema: { shape: { query: {}, repo: {} } },
    invoke: async (args: any) => {
      scopedToolCalls.push(args);
      return { content: "scoped tool evidence" };
    },
  }], "oa-order");
  await scopedTool.invoke({ query: "sms template" });
  assert.deepEqual(scopedToolCalls, [{ query: "sms template", repo: "oa-order" }]);

  const scopedMultiRepoCalls: any[] = [];
  const [scopedMultiRepoTool] = scopeToolsToRepo([{
    name: "gitnexus_query",
    description: "Search code by query in repos",
    schema: { shape: { query: {}, repo: {} } },
    invoke: async (args: any) => {
      scopedMultiRepoCalls.push(args);
      return { content: "multi repo scoped evidence" };
    },
  }], ["oa-pc", "oa-after"]);
  const scopedMultiRepoResult = await scopedMultiRepoTool.invoke({ query: "sms template", repo: "old-repo" });
  assert.deepEqual(scopedMultiRepoCalls, [
    { query: "sms template", repo: "oa-pc" },
    { query: "sms template", repo: "oa-after" },
  ]);
  assert.deepEqual(scopedMultiRepoResult, [
    { repo: "oa-pc", result: { content: "multi repo scoped evidence" } },
    { repo: "oa-after", result: { content: "multi repo scoped evidence" } },
  ]);

  const loggedMessages: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (message?: any, ...optionalParams: any[]) => {
    loggedMessages.push([message, ...optionalParams].map(String).join(" "));
  };
  try {
    const [loggedScopedTool] = scopeToolsToRepo([{
      name: "gitnexus_query",
      description: "Search code by query in a repo",
      schema: { shape: { query: {}, repo: {} } },
      invoke: async () => ({ content: "logged scoped evidence" }),
    }], "oa-pc");
    await loggedScopedTool.invoke({ query: "个人业绩统计" });
  } finally {
    console.log = originalConsoleLog;
  }
  assert.ok(loggedMessages.some(message => message.includes("[GitNexus Scope]") && message.includes('"repo":"oa-pc"') && message.includes('"queryLength":6')));
  assert.ok(loggedMessages.every(message => !message.includes("个人业绩统计")));

  const currentTurnMessages = buildMessagesForCurrentTurn({
    sessionMessages: [
      new HumanMessage("上一轮只查 oa-after"),
      new SystemMessage("历史上下文：目标项目 oa-after"),
    ],
    userContent: "只查 oa-order 短信模板来源",
    repoHint: "oa-order",
  });
  assert.equal(currentTurnMessages.length, 3);
  assert.equal(currentTurnMessages[0]?.content, "上一轮只查 oa-after");
  assert.equal(currentTurnMessages[2]?.content, "只查 oa-order 短信模板来源");
  console.log("[SUCCESS] search loop prelude verified");
}

runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
