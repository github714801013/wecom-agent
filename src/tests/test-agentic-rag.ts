import assert from "node:assert/strict";
import {
  runAgenticRag,
  type AgenticRagEvidence,
  type AgenticRagGrade,
  type AgenticRagQuery,
} from "../agentic-rag.js";

function query(value: string, priority = 1): AgenticRagQuery {
  return {
    query: value,
    type: "keyword",
    priority,
    reason: `query ${value}`,
  };
}

function evidence(id: string, content: string): AgenticRagEvidence {
  return {
    id,
    content,
    source: "test",
  };
}

function incompleteGrade(missingInfo = ["缺少调用方"]): AgenticRagGrade {
  return {
    relevant: true,
    sufficient: false,
    reason: "证据相关但不充分",
    missingInfo,
  };
}

async function testStopsWhenEvidenceIsSufficient() {
  const calls: string[] = [];
  const result = await runAgenticRag({
    question: "短信模板从哪里发送？",
    queries: [query("sms template"), query("sendSms")],
    retrieve: async currentQuery => {
      calls.push(currentQuery.query);
      return [evidence("e1", "SmsService.sendSms")];
    },
    grade: async () => ({
      relevant: true,
      sufficient: true,
      reason: "入口和发送调用均已命中",
      missingInfo: [],
    }),
  });

  assert.deepEqual(calls, ["sms template"]);
  assert.equal(result.complete, true);
  assert.equal(result.stopReason, "evidence_sufficient");
  assert.equal(result.iterations, 1);
  assert.ok(result.trace.some(item => item.node === "grade"));
  assert.equal(result.trace[result.trace.length - 1]?.node, "complete");
}

async function testUsesNextPlannedQueryBeforeRewrite() {
  const calls: string[] = [];
  let gradeCount = 0;
  let rewriteCount = 0;
  const result = await runAgenticRag({
    question: "短信模板从哪里发送？",
    queries: [query("sms template", 1), query("sendSms call", 2)],
    retrieve: async currentQuery => {
      calls.push(currentQuery.query);
      return [evidence(`e${calls.length}`, currentQuery.query)];
    },
    grade: async () => {
      gradeCount += 1;
      return gradeCount === 1
        ? incompleteGrade()
        : { relevant: true, sufficient: true, reason: "证据充分", missingInfo: [] };
    },
    rewrite: async () => {
      rewriteCount += 1;
      return query("should-not-run");
    },
  });

  assert.deepEqual(calls, ["sms template", "sendSms call"]);
  assert.equal(rewriteCount, 0);
  assert.equal(result.complete, true);
  assert.equal(result.rewrittenQueries.length, 0);
}

async function testRewritesAfterPlannedQueriesAreExhausted() {
  const calls: string[] = [];
  let gradeCount = 0;
  const result = await runAgenticRag({
    question: "短信模板从哪里发送？",
    queries: [query("sms template")],
    retrieve: async currentQuery => {
      calls.push(currentQuery.query);
      return [evidence(`e${calls.length}`, currentQuery.query)];
    },
    grade: async () => {
      gradeCount += 1;
      return gradeCount === 1
        ? incompleteGrade(["缺少真实发送调用"])
        : { relevant: true, sufficient: true, reason: "补查后证据充分", missingInfo: [] };
    },
    rewrite: async input => {
      assert.deepEqual(input.grade.missingInfo, ["缺少真实发送调用"]);
      return query("sendSms invocation");
    },
  });

  assert.deepEqual(calls, ["sms template", "sendSms invocation"]);
  assert.deepEqual(result.rewrittenQueries.map(item => item.query), ["sendSms invocation"]);
  assert.equal(result.complete, true);
  assert.ok(result.trace.some(item => item.node === "rewrite"));
}

async function testRejectsDuplicateRewriteQuery() {
  const calls: string[] = [];
  const result = await runAgenticRag({
    question: "短信模板从哪里发送？",
    queries: [query("sms template")],
    retrieve: async currentQuery => {
      calls.push(currentQuery.query);
      return [evidence("e1", "partial evidence")];
    },
    grade: async () => incompleteGrade(),
    rewrite: async () => query("  SMS   TEMPLATE  "),
  });

  assert.deepEqual(calls, ["sms template"]);
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, "duplicate_query");
  assert.equal(result.iterations, 1);
}

async function testRejectsEmptyRewriteQuery() {
  const result = await runAgenticRag({
    question: "短信模板从哪里发送？",
    queries: [query("sms template")],
    retrieve: async () => [evidence("e1", "partial evidence")],
    grade: async () => incompleteGrade(),
    rewrite: async () => query("   "),
  });

  assert.equal(result.complete, false);
  assert.equal(result.stopReason, "empty_rewrite");
}

async function testDeduplicatesEvidenceByIdOrContent() {
  let gradeCount = 0;
  const result = await runAgenticRag({
    question: "短信模板从哪里发送？",
    queries: [query("sms template", 1), query("sendSms", 2)],
    retrieve: async currentQuery => currentQuery.query === "sms template"
      ? [
          evidence("shared-id", "same content"),
          evidence("same-content-other-id", "same content"),
        ]
      : [
          evidence("shared-id", "changed content"),
          evidence("unique-id", "unique content"),
        ],
    grade: async input => {
      gradeCount += 1;
      return gradeCount === 1
        ? incompleteGrade()
        : { relevant: true, sufficient: true, reason: "证据充分", missingInfo: [] };
    },
  });

  assert.equal(result.evidence.length, 2);
  assert.deepEqual(result.evidence.map(item => item.id), ["shared-id", "unique-id"]);
}

async function testStopsAtIterationLimit() {
  const calls: string[] = [];
  const result = await runAgenticRag({
    question: "短信模板从哪里发送？",
    queries: [query("q1", 1), query("q2", 2), query("q3", 3)],
    retrieve: async currentQuery => {
      calls.push(currentQuery.query);
      return [evidence(currentQuery.query, currentQuery.query)];
    },
    grade: async () => incompleteGrade(),
    maxIterations: 2,
  });

  assert.deepEqual(calls, ["q1", "q2"]);
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, "max_iterations");
  assert.equal(result.iterations, 2);
}

async function testStopsAtRewriteLimit() {
  let rewriteCount = 0;
  const result = await runAgenticRag({
    question: "短信模板从哪里发送？",
    queries: [query("q1")],
    retrieve: async currentQuery => [evidence(currentQuery.query, currentQuery.query)],
    grade: async () => incompleteGrade(),
    rewrite: async () => {
      rewriteCount += 1;
      return query(`rewrite-${rewriteCount}`);
    },
    maxIterations: 4,
    maxRewrites: 1,
  });

  assert.equal(rewriteCount, 1);
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, "max_rewrites");
  assert.deepEqual(result.executedQueries.map(item => item.query), ["q1", "rewrite-1"]);
}

async function runTest() {
  await testStopsWhenEvidenceIsSufficient();
  await testUsesNextPlannedQueryBeforeRewrite();
  await testRewritesAfterPlannedQueriesAreExhausted();
  await testRejectsDuplicateRewriteQuery();
  await testRejectsEmptyRewriteQuery();
  await testDeduplicatesEvidenceByIdOrContent();
  await testStopsAtIterationLimit();
  await testStopsAtRewriteLimit();
  console.log("[SUCCESS] agentic rag loop verified");
}

runTest().catch(error => {
  console.error(error);
  process.exit(1);
});
