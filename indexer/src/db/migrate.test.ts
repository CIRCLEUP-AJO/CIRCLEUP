import { test } from "node:test";
import assert from "node:assert/strict";
import { runMigrations, getMigrationStatus } from "./migrate";
import { pool } from "./pool";

// Requires a reachable Postgres at DATABASE_URL (see docker-compose.yml).
test("runMigrations is idempotent and reports an up-to-date status", async () => {
  await runMigrations();
  const status = await runMigrations();

  assert.equal(status.pending.length, 0);
  assert.equal(status.missingOnDisk.length, 0);
  assert.ok(status.currentVersion, "expected a currentVersion once migrations exist");
  assert.ok(status.applied.includes(status.currentVersion!));
});

test("getMigrationStatus flags a schema_migrations row with no file on disk", async () => {
  await runMigrations();
  await pool.query(
    "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
    ["999_never_existed.sql"],
  );

  try {
    const status = await getMigrationStatus();
    assert.ok(status.missingOnDisk.includes("999_never_existed.sql"));
  } finally {
    await pool.query("DELETE FROM schema_migrations WHERE filename = $1", [
      "999_never_existed.sql",
    ]);
  }
});

test.after(async () => {
  await pool.end();
});
