import assert from "node:assert/strict";
import {
  buildRelationshipIndex,
  formatRelationshipIndex,
  relationshipEdgesFromText,
} from "../relationship-index.js";

const textEdges = relationshipEdgesFromText("接口A 调用 ServiceB，ServiceB 调用 MapperC");
assert.deepEqual(
  textEdges.map(edge => `${edge.from}:${edge.relation}:${edge.to}`),
  ["接口A:calls:ServiceB", "ServiceB:calls:MapperC"],
);

const mixedEdges = buildRelationshipIndex({
  callChain: [
    { from: "/kcApi/doSendWuLiu", relation: "calls_api", to: "WuLiuController.doSendWuLiu" },
    { from: "WuLiuController.doSendWuLiu", relation: "calls", to: "WuLiuService.send" },
  ],
  texts: [
    "WuLiuService.send 调用 SfExpressClient.createOrder",
    "WuLiuService.send 调用 SfExpressClient.createOrder",
  ],
});

assert.deepEqual(
  mixedEdges.map(edge => `${edge.from}:${edge.relation}:${edge.to}`),
  [
    "/kcApi/doSendWuLiu:calls_api:WuLiuController.doSendWuLiu",
    "WuLiuController.doSendWuLiu:calls:WuLiuService.send",
    "WuLiuService.send:calls:SfExpressClient.createOrder",
  ],
);

const formatted = formatRelationshipIndex(mixedEdges);
assert.match(formatted, /\/kcApi\/doSendWuLiu --calls_api--> WuLiuController\.doSendWuLiu/);
assert.match(formatted, /WuLiuService\.send --calls--> SfExpressClient\.createOrder/);

console.log("relationship index 验证通过");
