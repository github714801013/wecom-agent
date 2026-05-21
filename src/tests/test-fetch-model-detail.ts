import { config } from "../config.js";

async function fetchModelDetail() {
  const url = `${config.llm.baseUrl}/models/${config.llm.modelName}`;
  console.log(`Fetching from: ${url}`);
  try {
    const resp = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${config.llm.apiKey}`
      }
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
    const data: any = await resp.json();
    console.log("Model detail:", JSON.stringify(data, null, 2));
  } catch (e: any) {
    console.error("Failed to fetch model detail:", e.message);
  }
}

fetchModelDetail();
