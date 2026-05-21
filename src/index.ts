import { startBots } from "./wecom-adapter.js";

startBots().catch((err) => {
  console.error("Failed to start bots:", err);
  process.exit(1);
});
