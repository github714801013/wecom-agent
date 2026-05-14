import { getModelContextWindow } from "../graph.js";
import { config } from "../config.js";

function testContextDetection() {
  const window = getModelContextWindow();
  console.log(`Detected Context Window for ${config.LLM_MODEL_NAME}: ${window} tokens`);
  
  if (config.LLM_MODEL_NAME === "MiniMax-M2.5") {
    if (window === 200000) {
      console.log("Validation: SUCCESS (Matched hardcoded map)");
    } else {
      console.log("Validation: FAILED (Expected 200000)");
      process.exit(1);
    }
  } else {
    console.log("Validation: Manual check required for non-MiniMax model");
  }
}

testContextDetection();
