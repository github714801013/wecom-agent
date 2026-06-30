import assert from "node:assert/strict";
import { buildHelpReply, isHelpCommand } from "../wecom-adapter.js";

assert.equal(isHelpCommand("help"), true);
assert.equal(isHelpCommand("/help"), true);
assert.equal(isHelpCommand("帮助"), true);
assert.equal(isHelpCommand("使用手册"), true);
assert.equal(isHelpCommand("@机器人 帮助"), true);
assert.equal(isHelpCommand("帮我查询帮助文档在哪个接口"), false);

const reply = buildHelpReply([
  { serverNames: ["gitnexus", "db"], command: "/neo", label: "neo" },
  { serverNames: ["gitnexus"], command: "/pay", label: "pay" },
]);
assert.match(reply, /清理会话/);
assert.match(reply, /清理项目限制/);
assert.match(reply, /\/neo/);
assert.match(reply, /\/pay/);
assert.match(reply, /当前支持指令/);
assert.match(reply, /\/neo：切换到 neo 配置（gitnexus、db）/);
assert.match(reply, /\/pay：切换到 pay 配置（gitnexus）/);
assert.doesNotMatch(reply, /`\/new`|`\/neo`|`\/pay`/);
assert.match(reply, /继续或停止/);
assert.match(reply, /SQL 参数/);

console.log("help command 验证通过");
