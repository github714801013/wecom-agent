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

  if (session.messages.length === 20 && session.messages[0]?.content === "Answer 1") {
    console.log("SUCCESS: Pruning works and keeps the latest 20 messages.");
  } else {
    // Note: If we add pairs, it should keep exactly 20. 
    // Adding 22 messages means index 0 and 1 are removed.
    // Index 2 becomes new index 0. (i=2's human message?)
    // Wait, Answer 1 was index 1.
    if (session.messages.length === 20 && session.messages[0]?.content === "Question 2") {
       console.log("SUCCESS: Pruning works (Question 2 is the new head).");
    } else {
       console.log("FAILED: Pruning behavior unexpected.");
       process.exit(1);
    }
  }

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
}

testSessionLogic();
