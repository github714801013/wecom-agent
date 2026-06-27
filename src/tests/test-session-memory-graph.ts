import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  appendCompressionToSessionMemoryGraph,
  appendMessagesToSessionMemoryGraph,
  querySessionMemoryGraph,
} from "../session-memory-graph.js";

async function runTest() {
  let graph = appendMessagesToSessionMemoryGraph(undefined, [
    new HumanMessage("submitFilmYearOrder 这个方法调用链路"),
    new AIMessage("已确认 submitFilmYearOrder 位于 ShellFilmServiceImpl.java，submitFilmYearOrder:300~500 已分析，submitFilmYearOrder 调用 ShellFilmServiceImpl.getYearPackageInfo，ShellFilmServiceImpl.getYearPackageInfo 调用 SmallproFilmCardServiceImpl.repurchaseBuyTime"),
    new HumanMessage("常用资产历史价取值逻辑"),
    new AIMessage("历史价来自 asset_price 表，这条和当前目标无关"),
  ], 1000);

  const callChainResult = querySessionMemoryGraph(graph, "submitFilmYearOrder 调用链路", 4);
  assert.equal(callChainResult.has_memory, true);
  assert.match(callChainResult.relationship_index, /submitFilmYearOrder --calls--> ShellFilmServiceImpl\.getYearPackageInfo/);
  assert.match(callChainResult.relationship_index, /ShellFilmServiceImpl\.getYearPackageInfo --calls--> SmallproFilmCardServiceImpl\.repurchaseBuyTime/);
  assert.match(callChainResult.analyzed_code_range_index, /submitFilmYearOrder:300~500/);
  assert.ok(callChainResult.records.some(record => record.summary.includes("ShellFilmServiceImpl.java")));
  assert.ok(callChainResult.records.every(record => !record.summary.includes("asset_price")));

  graph = appendCompressionToSessionMemoryGraph(graph, {
    intent: "排查物流轨迹为空",
    keyEvidence: ["GetExpressInfoV2 查询 recover_sub_id=1859390 后 routeList 为空"],
    missingInfo: [],
    sections: [{
      file_path: "recoverindexapi/GetExpressInfoV2.java",
      symbol: "GetExpressInfoV2",
      lines: "120~180",
      content: "GetExpressInfoV2 调用 ExpressRouteService.queryRoute，ExpressRouteService.queryRoute 查询 waybill_no",
    }],
    callChain: [
      { from: "GetExpressInfoV2", relation: "调用", to: "ExpressRouteService.queryRoute" },
      { from: "ExpressRouteService.queryRoute", relation: "查询", to: "waybill_no" },
    ],
  }, 2000);

  const routeResult = querySessionMemoryGraph(graph, "GetExpressInfoV2 waybill_no routeList 为空", 4);
  assert.match(routeResult.relationship_index, /GetExpressInfoV2 --calls--> ExpressRouteService\.queryRoute/);
  assert.match(routeResult.relationship_index, /ExpressRouteService\.queryRoute --queries--> waybill_no/);
  assert.match(routeResult.analyzed_code_range_index, /GetExpressInfoV2:120~180/);

  console.log("[SUCCESS] session memory graph verified");
}

runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
