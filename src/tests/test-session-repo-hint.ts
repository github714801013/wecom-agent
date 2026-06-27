import assert from "node:assert/strict";
import { SessionManager } from "../session-manager.js";
import { extractExplicitRepoHints } from "../graph.js";

async function runTest() {
  const manager = new SessionManager();
  const sessionKey = "repo-inheritance";

  assert.deepEqual(manager.resolveRepoHints(sessionKey, ["oa-pc"]), ["oa-pc"]);
  assert.deepEqual(manager.resolveRepoHints(sessionKey, []), ["oa-pc"]);
  assert.deepEqual(manager.resolveRepoHints(sessionKey, ["oa-after"]), ["oa-after"]);
  assert.deepEqual(manager.resolveRepoHints(sessionKey, []), ["oa-after"]);
  assert.deepEqual(manager.resolveRepoHints(sessionKey, ["oa-pc", "oa-after"]), ["oa-pc", "oa-after"]);
  assert.deepEqual(manager.resolveRepoHints(sessionKey, []), ["oa-pc", "oa-after"]);

  manager.clearSession(sessionKey);
  assert.deepEqual(manager.resolveRepoHints(sessionKey, []), []);

  assert.deepEqual(
    extractExplicitRepoHints("截图里写着 oanew / oa999DAL / orderServices.cs:6516 和 subCheckOp", ["oanew", "oa-stock"]),
    ["oanew"],
  );

  console.log("[SUCCESS] session repo inheritance verified");
}

runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
