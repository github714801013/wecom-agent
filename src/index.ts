import { startBots } from "./wecom-adapter.js";
import { startDiagnosticServer } from "./diagnostic-server.js";

startDiagnosticServer();
startBots().catch((err) => {
  console.error("Failed to start bots:", err);
  process.exit(1);
});
