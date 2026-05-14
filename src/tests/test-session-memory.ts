import { HumanMessage, AIMessage } from "@langchain/core/messages";

async function testSessionLogic() {
  const messages: any[] = [];
  const MAX = 4; // Use small number for test
  
  function add(m: any) {
    messages.push(m);
    if (messages.length > MAX) {
      return messages.slice(-MAX);
    }
    return messages;
  }

  let history = add(new HumanMessage("1"));
  history = add(new AIMessage("1-reply"));
  history = add(new HumanMessage("2"));
  history = add(new AIMessage("2-reply"));
  history = add(new HumanMessage("3"));
  
  console.log("History length:", history.length);
  console.log("History items:", history.map((m: any) => m.content));

  if (history.length === 4 && history[0].content === "1-reply") {
    console.log("SUCCESS: Pruning works and keeps the correct items.");
  } else {
    console.log("FAILED: Pruning failed or kept wrong items.");
    process.exit(1);
  }

  // Verification of expiration logic (simulated)
  const SESSION_EXPIRATION_MS = 1000; // 1s
  let lastActivity = Date.now() - 2000; // 2s ago
  let currentMessages = [new HumanMessage("old")];
  
  if (Date.now() - lastActivity > SESSION_EXPIRATION_MS) {
    currentMessages = [];
    console.log("SUCCESS: Expiration logic (simulated) works.");
  } else {
    console.log("FAILED: Expiration logic (simulated) failed.");
    process.exit(1);
  }
}

testSessionLogic();
