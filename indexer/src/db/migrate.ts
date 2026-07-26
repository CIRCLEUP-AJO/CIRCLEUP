import * as fs from "fs";
import * as path from "path";
import { pool } from "./pool";

const migrationsDir = path.join(__dirname, "migrations");

function migrationFilesOnDisk(): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic order, e.g. 001_..., 002_...
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  // Filenames recorded as applied in schema_migrations but missing on disk —
  // signals someone deleted/renamed a migration that already ran elsewhere.
  missingOnDisk: string[];
  // The most recently applied migration, or null if none have run yet. This
  // doubles as the schema's version identifier since migrations are ordered
  // and cumulative.
  currentVersion: string | null;
}

/**
 * Reads applied-migration state from the DB and compares it against the
 * migration files on disk. Requires schema_migrations to already exist
 * (see schema.sql), so callers should run the base schema first.
 */
export async function getMigrationStatus(): Promise<MigrationStatus> {
  const filesOnDisk = migrationFilesOnDisk();

  let appliedSet: Set<string>;
  try {
    const { rows } = await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    appliedSet = new Set(rows.map((r) => r.filename));
  } catch (err) {
    // undefined_table — schema.sql hasn't been applied yet, so nothing has run.
    if ((err as { code?: string }).code === "42P01") {
      appliedSet = new Set();
    } else {
      throw err;
    }
  }

  const applied = filesOnDisk.filter((f) => appliedSet.has(f));
  const pending = filesOnDisk.filter((f) => !appliedSet.has(f));
  const missingOnDisk = [...appliedSet].filter((f) => !filesOnDisk.includes(f));

  return {
    applied,
    pending,
    missingOnDisk,
    currentVersion: applied.length > 0 ? applied[applied.length - 1] : null,
  };
}

function logStatus(status: MigrationStatus) {
  console.log(
    `[migrate] Schema version: ${status.currentVersion ?? "(none applied)"} ` +
      `— ${status.applied.length} applied, ${status.pending.length} pending`,
  );
  if (status.missingOnDisk.length > 0) {
    console.warn(
      `[migrate] Warning: ${status.missingOnDisk.length} migration(s) recorded ` +
        `as applied but missing from src/db/migrations/: ${status.missingOnDisk.join(", ")}`,
    );
  }
}

/**
 * Apply the base schema (idempotent CREATE TABLE IF NOT EXISTS statements)
 * followed by any additive .sql migration files in src/db/migrations/, ordered
 * by filename.  Each migration is wrapped in a transaction so a partial failure
 * leaves the DB in the last-good state.
 */
export async function runMigrations(): Promise<MigrationStatus> {
  const client = await pool.connect();
  try {
    // ── Base schema ─────────────────────────────────────────────────────────
    const schemaPath = path.join(__dirname, "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf-8");
    await client.query(schemaSql);
    console.log("[migrate] Base schema applied");

    // ── Additive migrations ──────────────────────────────────────────────────
    const files = migrationFilesOnDisk();
    if (files.length === 0) {
      console.log("[migrate] No migrations directory found — skipping");
    }

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
  } finally {
    client.release();
  }

  const status = await getMigrationStatus();
  logStatus(status);
  return status;
}

// Run directly: npx ts-node src/db/migrate.ts [--status]
if (require.main === module) {
  const statusOnly = process.argv.includes("--status");

  (statusOnly ? getMigrationStatus().then(logStatus) : runMigrations().then(() => {}))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate] Error:", err);
      process.exit(1);
    });
}
