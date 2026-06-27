import { strict as assert } from "node:assert";
import { buildHumanLoopResumeContent } from "../human-loop.js";
import {
  buildStreamPauseResumeRequest,
  buildStreamPauseResumeRuntimeInstruction,
  isStreamPauseResumeRequest,
} from "../stream-pause-resume.js";
import { readFileSync } from "node:fs";

const request = buildStreamPauseResumeRequest({
  userQuestion: "GetExpressInfoV2?sub_id=1859390&type=1 查不到物流轨迹",
  currentQuestion: "排查测试环境 recoverindexapi/GetExpressInfoV2 sub_id=1859390 type=1 routeList 为空原因",
  partialAnswer: "已确认接口返回 success，但 waybillNo、company、routeList 均为空。",
  toolContextSummary: "【本轮工具上下文摘要】\n有效工具证据:\n- dev_db.query SELECT waybill_no FROM express WHERE sub_id=1859390\n  waybill_no 为空",
  repoHints: ["oa-api", "oa-pc"],
});

assert.equal(request.reason, "clarification_required", "stream pause should reuse resumable human loop channel");
assert.match(request.question ?? "", /继续/, "pause request should tell user to reply continue");
assert.match(request.resumeInstruction, /禁止从头重新识别问题/, "resume instruction should prevent restarting");
assert.match(request.resumeInstruction, /已核实过的逻辑和已分析过的代码范围视为已完成节点/, "resume instruction should continue from completed nodes");
assert.match(request.resumeInstruction, /只有所有可用路径都核实完仍无法回答/, "resume instruction should ask only after exhausting paths");
assert.equal(isStreamPauseResumeRequest(request), true, "stream pause request should be detectable");
assert.ok(
  request.contextSnapshot.knownFacts.some(item => item.includes("GetExpressInfoV2")),
  "known facts should preserve integrated request anchor",
);
assert.ok(
  request.contextSnapshot.knownFacts.some(item => item.includes("waybill_no 为空")),
  "known facts should preserve tool evidence summary",
);
assert.ok(
  request.contextSnapshot.knownFacts.some(item => item.includes("oa-api, oa-pc")),
  "known facts should preserve repo scope",
);

const resumeContent = buildHumanLoopResumeContent(request, "继续");
assert.match(resumeContent, /Human Loop 恢复/, "resume content should use existing resume protocol");
assert.match(resumeContent, /routeList 均为空/, "resume content should include partial answer");
assert.match(resumeContent, /dev_db\.query/, "resume content should include tool evidence");
assert.match(resumeContent, /禁止从头重新识别问题/, "resume content should carry restart prevention");

const runtimeInstruction = buildStreamPauseResumeRuntimeInstruction();
assert.match(runtimeInstruction, /禁止重新执行问题分类、宽泛规划、预检索或从头搜索/, "runtime instruction should suppress restart entry points");
assert.match(runtimeInstruction, /只能从未完成节点继续/, "runtime instruction should continue from unfinished nodes");
assert.match(runtimeInstruction, /所有可用工具路径、代码路径、测试\/dev 库路径/, "runtime instruction should require exhausting queryable paths before asking");

const adapterSource = readFileSync("src/wecom-adapter.ts", "utf8");
assert.match(adapterSource, /isStreamPauseResume/, "adapter should detect stream pause resume mode");
assert.match(adapterSource, /skipped planner\/prelude to avoid restarting from head/, "adapter should skip planner/prelude on stream resume");
assert.match(adapterSource, /!isStreamPauseResume && !hasDirectEvidence && plannerResult/, "adapter should not run prelude on stream resume");

console.log("stream pause resume 验证通过");
