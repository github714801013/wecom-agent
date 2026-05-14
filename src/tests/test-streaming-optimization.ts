import { HumanMessage, AIMessage } from "@langchain/core/messages";

async function simulateStream() {
  const mockStream = [
    [new AIMessage({ content: "我来帮您查询一下相关信息。", tool_calls: [{ name: "test_tool", args: {}, id: "1" }] }), {}],
    [new AIMessage({ content: "查询结果如下：\n- 状态：正常\n- 时间：2026-05-14" }), {}]
  ];

  let fullContent = "";
  console.log("--- Starting Simulation ---");

  for (const [message, metadata] of mockStream) {
    const msg = message as any;
    
    // Logic from wecom-adapter.ts
    if (msg._getType() === "ai" && msg.tool_calls && msg.tool_calls.length > 0) {
      console.log("[Stream] Detected intermediate tool call, skipping preamble.");
      fullContent = "";
      continue;
    }

    if (msg._getType() === "ai" && msg.content) {
      const delta = msg.content.toString();
      fullContent += delta;
      console.log(`[Stream Update] Current fullContent: "${fullContent}"`);
    }
  }

  console.log("--- Final Result ---");
  console.log(fullContent);

  if (fullContent.includes("查询结果如下") && !fullContent.includes("我来帮您查询")) {
    console.log("\n✅ SUCCESS: Preamble filtered out, only final result delivered.");
  } else {
    console.error("\n❌ FAILED: Filtering logic did not work as expected.");
    process.exit(1);
  }
}

simulateStream();
