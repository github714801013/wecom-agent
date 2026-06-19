import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { SessionManager } from "../session-manager.js";

async function testSessionLogic() {
  const sm = new SessionManager();
  const key = "test-session";
  
  // 模拟 11 轮对话 (22 条消息)
  for (let i = 1; i <= 11; i++) {
    sm.addMessages(key, [
      new HumanMessage(`Question ${i}`),
      new AIMessage(`Answer ${i}`)
    ]);
  }

  const session = sm.getOrCreateSession(key);
  console.log("History length:", session.messages.length);
  console.log("First message content:", session.messages[0]?.content);
  console.log("Last message content:", session.messages[session.messages.length - 1]?.content);

  if (session.messages.length === 22 && session.messages[0]?.content === "Question 1") {
    console.log("SUCCESS: Session keeps messages below pruning limit.");
  } else {
    console.log("FAILED: Session message retention behavior unexpected.");
    process.exit(1);
  }

  const expiringSession = sm.getOrCreateSession("expiry-session");
  expiringSession.messages.push(new HumanMessage("old question"));
  expiringSession.lastActivity = Date.now() - 31 * 60 * 1000;
  await sm.addMessages("expiry-session", [new HumanMessage("new question")]);

  const refreshedSession = sm.getOrCreateSession("expiry-session");
  if (refreshedSession.messages.some(message => message.content === "old question")) {
    console.log("FAILED: Expired session history should be cleared before adding new messages.");
    process.exit(1);
  }
  if (!refreshedSession.messages.some(message => message.content === "new question")) {
    console.log("FAILED: New message should remain after expired session cleanup.");
    process.exit(1);
  }
  console.log("SUCCESS: Expired sessions clear old history before appending new messages.");

  // Verify AI recovery response recording logic (simulation)
  const recoveryAnswer = "Final synthesized answer post-recovery";
  sm.addMessages(key, [new HumanMessage("Complex Question"), new AIMessage(recoveryAnswer)]);
  
  const finalSession = sm.getOrCreateSession(key);
  const lastMsg = finalSession.messages[finalSession.messages.length - 1];
  if (lastMsg?.content === recoveryAnswer) {
    console.log("SUCCESS: Final AI response recorded correctly.");
  } else {
    console.log("FAILED: Final response missing.");
    process.exit(1);
  }

  sm.setPendingHumanLoop(key, {
    reason: "clarification_required",
    question: "请补充订单号",
    resumeInstruction: "继续排查订单状态",
    contextSnapshot: {
      userQuestion: "订单状态不对",
      knownFacts: [],
      missingFacts: ["订单号"],
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    originalMessageId: "msg-1",
    resumeCount: 0,
  });

  if (!sm.getPendingHumanLoop(key)) {
    console.log("FAILED: Pending human-loop should be stored.");
    process.exit(1);
  }

  sm.incrementPendingHumanLoopResume(key);
  if (sm.getPendingHumanLoop(key)?.resumeCount !== 1) {
    console.log("FAILED: Pending human-loop resume count should increment.");
    process.exit(1);
  }

  sm.clearPendingHumanLoop(key);
  if (sm.getPendingHumanLoop(key)) {
    console.log("FAILED: Pending human-loop should be cleared.");
    process.exit(1);
  }
  console.log("SUCCESS: Pending human-loop lifecycle works.");

  const cleanupKey = "cleanup-session";
  await sm.addMessages(cleanupKey, [
    new HumanMessage("old cleanup question"),
    new AIMessage("old cleanup answer"),
  ]);
  sm.resolveRepoHints(cleanupKey, ["wecom-agent"]);
  sm.setPendingHumanLoop(cleanupKey, {
    reason: "clarification_required",
    question: "请补充需求编号",
    resumeInstruction: "继续处理",
    contextSnapshot: {
      userQuestion: "历史问题",
      knownFacts: [],
      missingFacts: ["需求编号"],
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    originalMessageId: "msg-cleanup",
    resumeCount: 0,
  });

  sm.clearSession(cleanupKey);
  const cleanedSession = sm.getOrCreateSession(cleanupKey);
  if (cleanedSession.messages.length !== 0) {
    console.log("FAILED: clearSession should remove messages.");
    process.exit(1);
  }
  if (sm.resolveRepoHints(cleanupKey, []).length !== 0) {
    console.log("FAILED: clearSession should remove repo hints.");
    process.exit(1);
  }
  if (sm.getPendingHumanLoop(cleanupKey)) {
    console.log("FAILED: clearSession should remove pending human-loop.");
    process.exit(1);
  }
  cleanedSession.messages.push(new HumanMessage("stale after cleanup"));
  cleanedSession.lastActivity = Date.now() - 31 * 60 * 1000;
  const expiredAfterCleanup = sm.getOrCreateSession(cleanupKey, true);
  if (expiredAfterCleanup.messages.length !== 0) {
    console.log("FAILED: session recreated after clearSession should still expire when requested.");
    process.exit(1);
  }
  console.log("SUCCESS: clearSession removes history state.");
}

testSessionLogic();
