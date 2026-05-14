import { getModelContextSize } from "@langchain/core/language_models/base";
import { config } from "../config.js";

function testContextSize() {
  const modelName = config.LLM_MODEL_NAME;
  try {
    const size = getModelContextSize(modelName);
    console.log(`Model: ${modelName}, Context Size: ${size}`);
  } catch (e: any) {
    console.error(`Failed to get context size for ${modelName}:`, e?.message || e);
  }
}

testContextSize();
