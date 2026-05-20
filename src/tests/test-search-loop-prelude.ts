import assert from "node:assert/strict";
import { runSearchLoopPrelude } from "../graph.js";
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

  const projectListCalls: any[] = [];
  const skippedPrelude = await runSearchLoopPrelude({
    userQuestion: "能查询哪些项目",
    plannerResult: {
      ...plannerResult,
      normalized_question: "能查询哪些项目",
      queries: [
        { query: "项目", type: "keyword", priority: 1, reason: "项目清单" },
      ],
    },
    tools: [{
      name: "gitnexus_query",
      description: "Search code by query",
      schema: { shape: { query: {} } },
      invoke: async (args: any) => {
        projectListCalls.push(args);
        return { content: "should not be called" };
      },
    }],
    compressor: async () => {
      throw new Error("project list intent should skip prelude");
    },
  });

  assert.equal(skippedPrelude, "");
  assert.equal(projectListCalls.length, 0);
  console.log("[SUCCESS] search loop prelude verified");
}

runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
