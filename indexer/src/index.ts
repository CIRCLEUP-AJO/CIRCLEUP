import * as dotenv from "dotenv";
dotenv.config();

// Importing ./config validates all required env vars (DATABASE_URL,
// STELLAR_RPC_URL, CIRCLE_FACTORY_ADDRESS, REPUTATION_ADDRESS, USDC_ADDRESS)
// and throws a single clear error listing what's missing if any are unset —
// deliberately before ./db/migrate and ./indexer run so a misconfigured
// deploy fails on boot instead of partway through migrations or polling.
import { PORT } from "./config";
import { connectWithRetry } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { startIndexer } from "./indexer";
import { createApp } from "./api";

async function main() {
  console.log("[circleup-indexer] Booting...");

  // Wait for Postgres to accept connections before migrating — it's common
  // for the DB container to still be starting up at this point.
  await connectWithRetry();

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
