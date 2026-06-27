import assert from "node:assert/strict";
import { SessionManager } from "../session-manager.js";
import {
  extractProjectsFromMcpHeaders,
  parseMcpHeaderCommand,
  resolveMcpHeaderCommand,
} from "../mcp-header-commands.js";
import type { BotConfig, McpServerConfig } from "../config.js";

async function runTest() {
  const gitnexusServer: McpServerConfig = {
    name: "gitnexus",
    url: "http://127.0.0.1:1348/sse",
    type: "sse",
    headers: { "x-server": "gitnexus" },
    headerProfiles: {
      "/oa": { projects: "oa-stock,jiuji-m,9ji-admin" },
      "/neo": { projects: "small-oa,jiuyun-oa" },
      "/pay": { projects: "oa-pay,iteng-sp" },
    },
  };
  const dbServer: McpServerConfig = {
    name: "db",
    url: "http://127.0.0.1:1248/sse",
    type: "sse",
    headers: {},
    headerProfiles: {
      "/neo": { "x-database": "neo-db" },
    },
  };
  const botConfig: BotConfig = {
    name: "robot-a",
    botId: "bot-id",
    secret: "secret",
    wsUrl: "wss://openws.work.weixin.qq.com",
    mcpHeaders: {},
    defaultMcpHeaderCommand: "/oa",
  };
  assert.ok(botConfig.defaultMcpHeaderCommand);

  assert.deepEqual(
    resolveMcpHeaderCommand(botConfig.defaultMcpHeaderCommand, [gitnexusServer, dbServer]),
    { command: "/oa", label: "oa", headersByServer: { gitnexus: { projects: "oa-stock,jiuji-m,9ji-admin" } } },
  );
  assert.deepEqual(
    parseMcpHeaderCommand("@机器人 /neo", [gitnexusServer, dbServer]),
    { command: "/neo", label: "neo", headersByServer: { gitnexus: { projects: "small-oa,jiuyun-oa" }, db: { "x-database": "neo-db" } } },
  );
  // 企业微信群消息里 @机器人名 后可能紧跟指令（无空格），此时不能把 /指令 当作名字的一部分吃掉
  assert.deepEqual(
    parseMcpHeaderCommand("@机器人/neo", [gitnexusServer, dbServer]),
    { command: "/neo", label: "neo", headersByServer: { gitnexus: { projects: "small-oa,jiuyun-oa" }, db: { "x-database": "neo-db" } } },
  );
  assert.deepEqual(
    parseMcpHeaderCommand("@机器人/oa", [gitnexusServer, dbServer]),
    { command: "/oa", label: "oa", headersByServer: { gitnexus: { projects: "oa-stock,jiuji-m,9ji-admin" } } },
  );
  assert.deepEqual(parseMcpHeaderCommand("/pay", [gitnexusServer, dbServer])?.headersByServer, { gitnexus: { projects: "oa-pay,iteng-sp" } });
  assert.equal(parseMcpHeaderCommand("/pay 查一下支付", [gitnexusServer, dbServer]), null);
  assert.equal(parseMcpHeaderCommand("https://example.com/pay", [gitnexusServer, dbServer]), null);
  assert.equal(parseMcpHeaderCommand("pay", [gitnexusServer, dbServer]), null);
  assert.deepEqual(extractProjectsFromMcpHeaders({ gitnexus: gitnexusServer.headerProfiles["/oa"]! }), ["oa-stock", "jiuji-m", "9ji-admin"]);

  const manager = new SessionManager();
  const sessionKey = "mcp-header-switch";
  const neoCommand = parseMcpHeaderCommand("/neo", [gitnexusServer, dbServer]);
  assert.ok(neoCommand);
  manager.setMcpHeaderOverrides(sessionKey, neoCommand.headersByServer);
  manager.setRepoHints(sessionKey, extractProjectsFromMcpHeaders(neoCommand.headersByServer));
  assert.deepEqual(manager.resolveMcpHeaders(sessionKey), { gitnexus: { projects: "small-oa,jiuyun-oa" }, db: { "x-database": "neo-db" } });
  assert.deepEqual(manager.resolveRepoHints(sessionKey, [], ["oa-stock", "jiuji-m", "9ji-admin"]), ["small-oa", "jiuyun-oa"]);
  assert.deepEqual(manager.resolveMcpHeaders(sessionKey), { gitnexus: { projects: "small-oa,jiuyun-oa" }, db: { "x-database": "neo-db" } });
  assert.deepEqual(manager.resolveRepoHints(sessionKey, []), ["small-oa", "jiuyun-oa"]);

  const oaCommand = parseMcpHeaderCommand("/oa", [gitnexusServer, dbServer]);
  assert.ok(oaCommand);
  manager.setMcpHeaderOverrides(sessionKey, oaCommand.headersByServer);
  manager.setRepoHints(sessionKey, extractProjectsFromMcpHeaders(oaCommand.headersByServer));
  assert.deepEqual(manager.resolveMcpHeaders(sessionKey), { gitnexus: { projects: "oa-stock,jiuji-m,9ji-admin" } });
  assert.deepEqual(manager.resolveRepoHints(sessionKey, []), ["oa-stock", "jiuji-m", "9ji-admin"]);

  console.log("[SUCCESS] project switch command verified");
}

runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
