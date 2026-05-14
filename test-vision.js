import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { config } from "./src/config.js";
async function test() {
    const model = new ChatOpenAI({
        modelName: config.LLM_MODEL_NAME,
        apiKey: config.LLM_API_KEY,
        configuration: {
            baseURL: config.LLM_BASE_URL,
        },
        temperature: 0,
    });
    // A tiny 1x1 transparent GIF base64
    const base64Image = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const msg = new HumanMessage({
        content: [
            { type: "text", text: "这张图片是什么颜色的？" },
            { type: "image_url", image_url: { url: base64Image } }
        ]
    });
    try {
        const res = await model.invoke([msg]);
        console.log("Model Response:", res.content);
    }
    catch (err) {
        console.error("Model Error:", err);
    }
}
test();
//# sourceMappingURL=test-vision.js.map