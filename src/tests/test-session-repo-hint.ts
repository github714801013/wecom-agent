import assert from "node:assert/strict";
import { SessionManager } from "../session-manager.js";

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

  console.log("[SUCCESS] session repo inheritance verified");
}

runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
