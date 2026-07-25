import * as fs from "fs";
import * as path from "path";
import { pool } from "./pool";

/**
 * Apply the base schema (idempotent CREATE TABLE IF NOT EXISTS statements)
 * followed by any additive .sql migration files in src/db/migrations/, ordered
 * by filename.  Each migration is wrapped in a transaction so a partial failure
 * leaves the DB in the last-good state.
 */
export async function runMigrations() {
  const client = await pool.connect();
  try {
    // ── Base schema ─────────────────────────────────────────────────────────
    const schemaPath = path.join(__dirname, "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf-8");
    await client.query(schemaSql);
    console.log("[migrate] Base schema applied");

    // ── Additive migrations ──────────────────────────────────────────────────
    // Ensure the tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, "migrations");
    if (!fs.existsSync(migrationsDir)) {
      console.log("[migrate] No migrations directory found — skipping");
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort(); // lexicographic order, e.g. 001_..., 002_...

    for (const file of files) {
      const { rows } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file],
      );
      if (rows.length > 0) {
        console.log(`[migrate] Already applied: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log(`[migrate] Applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`[migrate] Failed on ${file}: ${err}`);
      }
    }

    console.log("[migrate] All migrations applied successfully");
  } finally {
    client.release();
  }
}

// Run directly: npx ts-node src/db/migrate.ts
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate] Error:", err);
      process.exit(1);
    });
}
