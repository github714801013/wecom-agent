import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { SessionManager } from "../session-manager.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

function runTest() {
  const originalDateNow = Date.now;
  let now = 1_750_000_000_000;
  Date.now = () => now;

  try {
    const manager = new SessionManager();
    const sessionKey = "session-expiration-one-hour";
    const session = manager.getOrCreateSession(sessionKey);

    session.messages.push(new HumanMessage("保留这一小时内的会话历史"));
    manager.setRepoHints(sessionKey, ["wecom-agent"]);
    manager.setMcpHeaderOverrides(sessionKey, {
      gitnexus: { projects: "wecom-agent" },
    });
    manager.setActiveMcpHeaderCommand(sessionKey, "/wecom");
    manager.setPendingHumanLoop(sessionKey, {
      reason: "clarification_required",
      question: "请补充确认信息",
      resumeInstruction: "用户确认后继续",
      contextSnapshot: {
        userQuestion: "测试会话过期",
        knownFacts: [],
        missingFacts: ["确认信息"],
      },
      createdAt: now,
      expiresAt: now + ONE_HOUR_MS,
      originalMessageId: "message-1",
      resumeCount: 0,
    });
    session.isCompressed = true;
    session.memoryGraph = {
      records: [],
      relationships: [],
      analyzedRanges: [],
      updatedAt: now,
    };

    now += ONE_HOUR_MS - 1000;
    const retainedSession = manager.getOrCreateSession(sessionKey, true);

    assert.equal(retainedSession.messages.length, 1, "一小时内应保留会话历史");
    assert.deepEqual(retainedSession.currentRepoHints, ["wecom-agent"], "一小时内应保留项目提示");
    assert.deepEqual(
      retainedSession.currentMcpHeaders,
      { gitnexus: { projects: "wecom-agent" } },
      "一小时内应保留 MCP Header",
    );
    assert.equal(retainedSession.currentMcpHeaderCommand, "/wecom", "一小时内应保留环境切换命令");
    assert.ok(retainedSession.pendingHumanLoop, "一小时内应保留待处理人工确认");
    assert.equal(retainedSession.isCompressed, true, "一小时内应保留压缩状态");
    assert.ok(retainedSession.memoryGraph, "一小时内应保留会话记忆图");
    assert.equal(retainedSession.lastActivity, now, "访问会话后应刷新最后活动时间");

    now += ONE_HOUR_MS + 1;
    const expiredSession = manager.getOrCreateSession(sessionKey, true);

    assert.equal(expiredSession.messages.length, 0, "超过一小时无活动后应清空会话历史");
    assert.equal(expiredSession.currentRepoHints, undefined, "过期后应清空项目提示");
    assert.equal(expiredSession.currentMcpHeaders, undefined, "过期后应清空 MCP Header");
    assert.equal(expiredSession.currentMcpHeaderCommand, undefined, "过期后应清空环境切换命令");
    assert.equal(expiredSession.pendingHumanLoop, undefined, "过期后应清空待处理人工确认");
    assert.equal(expiredSession.isCompressed, false, "过期后应重置压缩状态");
    assert.equal(expiredSession.memoryGraph, undefined, "过期后应清空会话记忆图");
    assert.equal(expiredSession.lastActivity, now, "过期清理后应刷新最后活动时间");

    console.log("session expiration one-hour verification passed");
  } finally {
    Date.now = originalDateNow;
  }
}

runTest();
