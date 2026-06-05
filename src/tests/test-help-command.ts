import assert from "node:assert/strict";
import { buildHelpReply, isHelpCommand } from "../wecom-adapter.js";

assert.equal(isHelpCommand("help"), true);
assert.equal(isHelpCommand("/help"), true);
assert.equal(isHelpCommand("帮助"), true);
assert.equal(isHelpCommand("使用手册"), true);
assert.equal(isHelpCommand("@机器人 帮助"), true);
assert.equal(isHelpCommand("帮我查询帮助文档在哪个接口"), false);

const reply = buildHelpReply();
assert.match(reply, /清理会话/);
assert.match(reply, /清理项目限制/);
assert.match(reply, /继续或停止/);
assert.match(reply, /SQL 参数/);

console.log("help command 验证通过");
