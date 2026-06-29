import * as dotenv from "dotenv";
dotenv.config();

import { runMigrations } from "./db/migrate";
import { startIndexer } from "./indexer";
import { createApp } from "./api";

const PORT = parseInt(process.env.PORT || "3001", 10);

async function main() {
  console.log("[circleup-indexer] Booting...");

  // Apply DB schema
  await runMigrations();

  // Start REST API
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[circleup-indexer] API listening on http://localhost:${PORT}`);
  });

  // Start event indexer
  await startIndexer();
}

main().catch((err) => {
  console.error("[circleup-indexer] Fatal error:", err);
  process.exit(1);
});
