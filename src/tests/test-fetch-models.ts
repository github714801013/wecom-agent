import { config } from '../config.js';

async function checkModels() {
  const res = await fetch(`${config.LLM_BASE_URL}/models`, {
    headers: {
      "Authorization": `Bearer ${config.LLM_API_KEY}`
    }
  });
  if (res.ok) {
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log("Failed:", res.status, await res.text());
  }
}
checkModels();
