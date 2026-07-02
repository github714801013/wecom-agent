import assert from "node:assert/strict";
import { extractExplicitRepoHints } from "../graph.js";
import {
  buildDirectEvidenceRuntimeInstruction,
  hasDirectEvidenceAnchors,
  shouldUseDirectEvidenceFastPath,
  shouldUseWeComDirectEvidenceFastPath,
} from "../direct-evidence.js";

const question = `curl -X POST -d "sub_id=18117666&sub_check=2&TakeMobile=&mobile_basket_id=&confirmInfo=" "https://oa.dev.9ji.com/addOrder/subCheckOp"
【图片识别结果】
原因分析/调用链/代码位置：subCheckOp(sub_check=2) -> CheckSubKcGovSn -> payGatewayServices.SnQuery() -> oanew/oa999DAL/orderServices.cs:6516`;

assert.equal(hasDirectEvidenceAnchors(question), true, "should detect screenshot-style direct evidence");
assert.equal(shouldUseDirectEvidenceFastPath(question), false, "should require root-cause evidence before fast path");
assert.deepEqual(
  extractExplicitRepoHints(question, ["oanew", "oa-stock"]),
  ["oanew"],
  "should extract repo hint from path-style evidence",
);

const rootCauseQuestion = `${question}
根本原因/排查方向：第三方接口返回状态码导致拦截`;
assert.equal(shouldUseDirectEvidenceFastPath(rootCauseQuestion), true, "should allow fast path for root-cause direct evidence");
assert.equal(shouldUseWeComDirectEvidenceFastPath(rootCauseQuestion), false, "WeCom live flow should still query tools for direct evidence");

const lookupQuestion = `${rootCauseQuestion}
这个队列 cm_returned_imeis 是干啥的，谁消费？`;
assert.equal(shouldUseDirectEvidenceFastPath(lookupQuestion), false, "should not skip tools for lookup or usage questions");

const runtimeInstruction = buildDirectEvidenceRuntimeInstruction();
assert.match(runtimeInstruction, /优先核实这些精确锚点/);
assert.match(runtimeInstruction, /不要反问请求参数是否应该有值/);
assert.match(runtimeInstruction, /跳过额外预检索/);

console.log("direct evidence 验证通过");
