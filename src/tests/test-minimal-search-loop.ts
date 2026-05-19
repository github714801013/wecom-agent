import assert from "node:assert/strict";
import { createMinimalSearchLoop } from "../graph.js";
import type { CompressorInput, SearchQuery } from "../graph.js";

async function runTest() {
  const executedQueries: string[] = [];
  const compressedInputs: any[] = [];

  const loop = createMinimalSearchLoop({
    planner: async () => ({
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
        { query: "短信模板来源", type: "semantic", priority: 2, reason: "语义兜底" },
      ],
      hypotheses: [],
      search_plan: {
        primary: ["sms template"],
        secondary: ["短信模板来源"],
        exclude: [],
      },
      missing_info: [],
    }),
    searcher: async (query: SearchQuery) => {
      executedQueries.push(query.query);
      return query.query === "sms template"
        ? [{ id: "raw_1", source: "local", query: query.query, type: query.type, content: "入口命中，但缺少发送调用" }]
        : [{ id: "raw_2", source: "local", query: query.query, type: query.type, content: "sendSms 调用证据" }];
    },
    compressor: async (input: CompressorInput) => {
      compressedInputs.push(input);
      return {
        status: "ok",
        intent: "FLOW",
        partial: false,
        compressed_sections: [],
        call_chain: [],
        key_evidence: input.search_results.map((item: any) => item.content),
        dropped: [],
        missing_info: compressedInputs.length === 1 ? ["缺少发送调用"] : [],
        warnings: [],
        errors: [],
        budget: { input_est: 0, output_est: 0, target: 1000, mode: "balanced" },
      };
    },
    nextQueryPlanner: async ({ compression }: { compression: { missing_info: string[] } }) => ({
      query: compression.missing_info.length > 0 ? "sendSms template" : "",
      type: "keyword",
      priority: 1,
      reason: "补发送调用",
    }),
    maxIterations: 2,
  });

  const result = await loop.run("短信模板从哪里发送？");

  assert.deepEqual(executedQueries, ["sms template", "sendSms template"]);
  assert.equal(compressedInputs.length, 2);
  assert.equal(compressedInputs[0].search_results[0].content, "入口命中，但缺少发送调用");
  assert.equal(compressedInputs[1].search_results.length, 2);
  assert.equal(compressedInputs[1].search_results[1].content, "sendSms 调用证据");
  assert.equal(result.iterations, 2);
  console.log("[SUCCESS] minimal search loop verified");
}

runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
