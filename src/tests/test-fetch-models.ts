import { config } from "../config.js";

async function fetchModelInfo() {
  const url = `${config.LLM_BASE_URL}/models`;
  console.log(`Fetching from: ${url}`);
  try {
    const resp = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${config.LLM_API_KEY}`
      }
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
    const data: any = await resp.json();
    console.log("Models info:", JSON.stringify(data, null, 2));
    
    const currentModel = data.data?.find((m: any) => m.id === config.LLM_MODEL_NAME);
    if (currentModel) {
      console.log(`Found current model:`, currentModel);
    } else {
      console.log(`Model ${config.LLM_MODEL_NAME} not found in /models response`);
    }
  } catch (e: any) {
    console.error("Failed to fetch model info:", e.message);
  }
}

fetchModelInfo();
