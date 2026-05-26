import { strict as assert } from "node:assert";
import { startDiagnosticServer, stopDiagnosticServer } from "../diagnostic-server.js";

process.env.DIAGNOSTIC_HOST = "0.0.0.0";
process.env.DIAGNOSTIC_PORT = "3011";

const server = startDiagnosticServer();

try {
  await new Promise(resolve => setTimeout(resolve, 300));

  const statusResponse = await fetch("http://127.0.0.1:3011/__debug/status");
  assert.equal(statusResponse.status, 200, "status endpoint should be callable without WeCom");
  const status = await statusResponse.json() as any;
  assert.equal(status.ok, true);
  assert.deepEqual(status.cases, ["progress", "tool-context", "human-loop"]);

  const evaluateResponse = await fetch("http://127.0.0.1:3011/__debug/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: "progress",
      content: "已读取问题，继续核实中。已定位候选文件，继续核实中。",
      activeCall: "> 🔍 正在调用: query...",
    }),
  });
  assert.equal(evaluateResponse.status, 200, "evaluate endpoint should be callable without WeCom");
  const evaluate = await evaluateResponse.json() as any;
  assert.equal(evaluate.collapsed, "已定位候选文件，继续核实中。");
  assert.equal(evaluate.streamContent, "已定位候选文件，继续核实中。\n\n> 🔍 正在调用: query...");
} finally {
  await stopDiagnosticServer(server);
}

console.log("diagnostic HTTP 查询验证通过");
