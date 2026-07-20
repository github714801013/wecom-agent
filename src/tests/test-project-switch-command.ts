import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HumanMessage } from "@langchain/core/messages";
import { SessionManager } from "../session-manager.js";
import {
  buildMcpEnvironmentQueryNotice,
  buildMcpHeaderSwitchReply,
  buildQueryableProjectsReply,
  extractProjectsFromMcpHeaders,
  isQueryableProjectsQuestion,
  parseMcpHeaderCommand,
  prependMcpEnvironmentQueryNotice,
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

  const defaultEnvironmentCommand = {
    command: "/oa",
    label: "oa",
    headersByServer: {
      gitnexus: {
        projects: "oa-stock,jiuji-m,9ji-admin",
        env: "pro,iteng",
      },
    },
  };
  const neoEnvironmentCommand = {
    command: "/neo",
    label: "neo",
    headersByServer: {
      gitnexus: {
        projects: "small-oa,jiuyun-oa",
        "x-api-key": "neo-secret-value",
      },
    },
  };
  const neoSwitchReply = buildMcpHeaderSwitchReply(neoEnvironmentCommand);
  assert.match(neoSwitchReply, /已切换到 \/neo 环境/);
  assert.match(neoSwitchReply, /small-oa, jiuyun-oa/);
  assert.doesNotMatch(neoSwitchReply, /x-api-key|neo-secret-value|env/);

  assert.equal(buildMcpEnvironmentQueryNotice("/neo", "/oa"), "当前按 /neo 环境查询");
  assert.equal(buildMcpEnvironmentQueryNotice("neo", "/oa"), "当前按 /neo 环境查询");
  assert.equal(buildMcpEnvironmentQueryNotice("/oa", "/oa"), "");
  assert.equal(buildMcpEnvironmentQueryNotice(undefined, "/oa"), "");
  assert.equal(
    prependMcpEnvironmentQueryNotice("正在处理你的问题，请稍候。", "/neo", "/oa"),
    "当前按 /neo 环境查询\n\n正在处理你的问题，请稍候。",
  );
  assert.equal(
    prependMcpEnvironmentQueryNotice("当前按 /neo 环境查询\n\n最终答案", "/neo", "/oa"),
    "当前按 /neo 环境查询\n\n最终答案",
    "environment notice should not be duplicated",
  );
  assert.equal(
    prependMcpEnvironmentQueryNotice("最终答案", "/oa", "/oa"),
    "最终答案",
    "default environment should not add reply noise",
  );

  for (const question of [
    "现在你能查哪些项目",
    "当前可以查询哪些项目？",
    "你能查什么仓库",
    "当前查询范围是什么",
    "可查询项目列表",
  ]) {
    assert.equal(isQueryableProjectsQuestion(question), true, `should detect queryable project scope question: ${question}`);
  }
  for (const question of [
    "neo-oa 项目里订单接口在哪里",
    "查一下 oa-order 项目的支付逻辑",
    "哪些项目调用了这个接口",
    "现在你能查哪些项目的代码逻辑",
  ]) {
    assert.equal(isQueryableProjectsQuestion(question), false, `should not hijack business project question: ${question}`);
  }
  assert.equal(
    buildQueryableProjectsReply(["small-oa", "jiuyun-oa", "neo-oa", "jiuyun-moa"]),
    "当前可查询项目（4 个）：\n- small-oa\n- jiuyun-oa\n- neo-oa\n- jiuyun-moa",
  );
  assert.equal(buildQueryableProjectsReply([]), "当前环境未配置可查询项目。请检查该环境的 projects 配置。");

  const manager = new SessionManager();
  const sessionKey = "mcp-header-switch";
  const neoCommand = parseMcpHeaderCommand("/neo", [gitnexusServer, dbServer]);
  assert.ok(neoCommand);
  manager.setMcpHeaderOverrides(sessionKey, neoCommand.headersByServer);
  manager.setActiveMcpHeaderCommand(sessionKey, neoCommand.command);
  manager.setRepoHints(sessionKey, extractProjectsFromMcpHeaders(neoCommand.headersByServer));
  assert.deepEqual(manager.resolveMcpHeaders(sessionKey), { gitnexus: { projects: "small-oa,jiuyun-oa" }, db: { "x-database": "neo-db" } });
  assert.deepEqual(manager.resolveRepoHints(sessionKey, [], ["oa-stock", "jiuji-m", "9ji-admin"]), ["small-oa", "jiuyun-oa"]);
  assert.deepEqual(manager.resolveMcpHeaders(sessionKey), { gitnexus: { projects: "small-oa,jiuyun-oa" }, db: { "x-database": "neo-db" } });
  assert.deepEqual(manager.resolveRepoHints(sessionKey, []), ["small-oa", "jiuyun-oa"]);
  assert.equal(manager.resolveActiveMcpHeaderCommand(sessionKey), "/neo");

  manager.getOrCreateSession(sessionKey).messages.push(new HumanMessage("上一轮问题"));
  manager.setRepoHints(sessionKey, ["small-oa"]);
  manager.clearConversationHistory(
    sessionKey,
    extractProjectsFromMcpHeaders(manager.resolveMcpHeaders(sessionKey)),
  );
  assert.equal(manager.getOrCreateSession(sessionKey).messages.length, 0, "automatic history cleanup should clear messages");
  assert.equal(manager.resolveActiveMcpHeaderCommand(sessionKey), "/neo", "automatic history cleanup should preserve explicit environment command");
  assert.deepEqual(manager.resolveMcpHeaders(sessionKey), { gitnexus: { projects: "small-oa,jiuyun-oa" }, db: { "x-database": "neo-db" } });
  assert.deepEqual(manager.resolveRepoHints(sessionKey, []), ["small-oa", "jiuyun-oa"]);

  const oaCommand = parseMcpHeaderCommand("/oa", [gitnexusServer, dbServer]);
  assert.ok(oaCommand);
  manager.setMcpHeaderOverrides(sessionKey, oaCommand.headersByServer);
  manager.setActiveMcpHeaderCommand(sessionKey, oaCommand.command);
  manager.setRepoHints(sessionKey, extractProjectsFromMcpHeaders(oaCommand.headersByServer));
  assert.deepEqual(manager.resolveMcpHeaders(sessionKey), { gitnexus: { projects: "oa-stock,jiuji-m,9ji-admin" } });
  assert.deepEqual(manager.resolveRepoHints(sessionKey, []), ["oa-stock", "jiuji-m", "9ji-admin"]);
  assert.equal(manager.resolveActiveMcpHeaderCommand(sessionKey), "/oa");

  manager.clearSession(sessionKey);
  assert.equal(manager.resolveActiveMcpHeaderCommand(sessionKey), undefined, "explicit session clear should remove environment command");
  assert.deepEqual(manager.resolveMcpHeaders(sessionKey), {});

  const expiringSessionKey = "mcp-header-expiry";
  manager.setMcpHeaderOverrides(expiringSessionKey, neoCommand.headersByServer);
  manager.setActiveMcpHeaderCommand(expiringSessionKey, neoCommand.command);
  const expiringSession = manager.getOrCreateSession(expiringSessionKey);
  expiringSession.lastActivity = Date.now() - 61 * 60 * 1000;
  manager.getOrCreateSession(expiringSessionKey, true);
  assert.deepEqual(manager.resolveMcpHeaders(expiringSessionKey), {});
  assert.equal(manager.resolveActiveMcpHeaderCommand(expiringSessionKey), undefined);
  assert.deepEqual(
    resolveMcpHeaderCommand(botConfig.defaultMcpHeaderCommand, [gitnexusServer, dbServer])?.headersByServer,
    { gitnexus: { projects: "oa-stock,jiuji-m,9ji-admin" } },
    "会话过期清空当前切换指令后，下一轮应回落到 bot 默认指令",
  );

  const adapterSource = readFileSync(new URL("../wecom-adapter.ts", import.meta.url), "utf-8");
  assert.match(adapterSource, /setActiveMcpHeaderCommand\(sessionKey, mcpHeaderCommand\.command\)/);
  assert.match(adapterSource, /withMcpEnvironmentNotice\(buildThinkingHeartbeatContent/);
  assert.match(adapterSource, /withMcpEnvironmentNotice\("正在处理你的问题，请稍候。"\)/);
  assert.match(adapterSource, /withMcpEnvironmentNotice\(safeContent \|\| "未获取到有效回复"\)/);
  assert.match(adapterSource, /clearConversationHistory\(sessionKey, retainedProfileRepoHints\)/);
  assert.match(adapterSource, /isQueryableProjectsQuestion\(originalUserQuestion\)/);
  assert.match(adapterSource, /withMcpEnvironmentNotice\(buildQueryableProjectsReply\(queryableProjects\)\)/);
  assert.match(adapterSource, /main_title:\s*\{[\s\S]*title: "当前可查询项目"/);
  assert.match(adapterSource, /direct project scope fast path/);
  assert.doesNotMatch(
    adapterSource,
    /extractMcpProjectCandidates\(config\.mcpServers\)/,
    "current command repo candidates must not include projects from inactive profiles",
  );
  assert.match(
    adapterSource,
    /extractExplicitRepoHints\(\s*textToPlan,\s*defaultRepoHints,?\s*\)/,
    "explicit repo detection should only use projects from the active command profile",
  );
  assert.ok(
    adapterSource.indexOf("if (isQueryableProjectsQuestion(originalUserQuestion))")
      < adapterSource.indexOf("const runtimeTodoList = createRuntimeTodoList()"),
    "project scope fast path should run before runtime TodoList and generic progress flow",
  );

  console.log("[SUCCESS] project switch command verified");
}

runTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
