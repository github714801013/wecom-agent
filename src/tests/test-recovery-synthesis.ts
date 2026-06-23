import { strict as assert } from "node:assert";
import { buildSqlAuditEvidence, isSqlAuditEvidenceBlocking } from "../runtime-todolist.js";
import { buildProgressLimitRecoverySystemPrompt, ensureRecoverySqlAuditMarker } from "../recovery-synthesis.js";

const prompt = buildProgressLimitRecoverySystemPrompt("业务基础提示");

assert.match(prompt, /可直接发送给用户的回答/, "恢复提示必须要求输出可发送回答");
assert.match(prompt, /禁止输出.*继续核实中/, "恢复提示必须禁止继续核实中");
assert.match(prompt, /现在读取/, "恢复提示必须覆盖现在读取类阶段性话术");
assert.match(prompt, /阶段性结论/, "恢复提示必须允许基于已有证据给阶段性结论");
assert.match(prompt, /除非最终回答输出具体 SQL/, "恢复提示必须避免非 SQL 问题误触发 SQL 审核");
assert.match(prompt, /dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构/, "恢复提示引用源码 SQL 时必须满足 SQL 审核例外标记");
assert.match(prompt, /不能只泛泛要求补充目标系统\/页面\/字段/, "恢复提示必须收敛最小缺口");

const recoveredSqlAnswer = ensureRecoverySqlAuditMarker([
  "结论：历史价取 avgPrice。",
  "```sql",
  "SELECT ROUND(AVG(Price), 2) avgPrice FROM AssetCaigouBasket;",
  "```",
].join("\n"));

assert.match(
  recoveredSqlAnswer,
  /dev 库无对应表，SQL 未做 dev 执行校验，已通过代码反推结构/,
  "恢复回答引用源码 SQL 时应自动补代码反推审核标记",
);
assert.equal(
  isSqlAuditEvidenceBlocking(buildSqlAuditEvidence(recoveredSqlAnswer)),
  false,
  "补充代码反推标记后的恢复回答不应被 SQL 审核兜底覆盖",
);

console.log("工具上限恢复提示验证通过");
