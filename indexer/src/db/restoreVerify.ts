/**
 * restoreVerify.ts — Read-only database restore verification (Issue #db-restore)
 *
 * Operators may restore a backup or cloned database for incident investigation.
 * This command performs bounded, read-only checks against the configured
 * database and reports pass, warning, or failure for:
 *
 *   1. schema_version   — schema_migrations table exists and its state is
 *                         either "clean" or "pending" (not uninitialized,
 *                         drifted, partial, or modified).
 *   2. checkpoint_continuity — ledger_checkpoints rows exist and there are no
 *                         ledger-sequence gaps larger than CHECKPOINT_GAP_THRESHOLD.
 *   3. dedup_constraints — the unique indexes that enforce event idempotency
 *                         are present in pg_indexes.
 *   4. projection_consistency — a sample of circles rows are internally
 *                         coherent: current_round ≤ total_rounds, member_count
 *                         > 0, and status is a known value.
 *
 * Safety guarantees:
 *   - Every query is SELECT / SHOW only. No INSERT, UPDATE, DELETE, or DDL.
 *   - Queries run with statement_timeout = QUERY_TIMEOUT_MS to bound
 *     execution time on large datasets.
 *   - The database URL is never logged or included in the output report.
 *   - The report is machine-readable (JSON) and includes a human summary.
 *   - The command never runs migrations or modifies schema state.
 *
 * Exit codes:
 *   0 — All checks pass.
 *   1 — One or more checks failed or returned a warning.
 *   2 — Could not connect to the database (unreachable / bad credentials).
 *
 * Usage:
 *   ts-node src/db/restoreVerify.ts [--json] [--timeout-ms=<n>]
 *
 * Flags:
 *   --json          Print the machine-readable JSON report to stdout.
 *   --timeout-ms=N  Per-query statement_timeout in ms (default 10000).
 */

import { Pool, PoolClient } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default per-query statement_timeout, in ms. Keeps checks bounded on large DBs. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** A ledger gap larger than this between consecutive checkpoints is flagged. */
const CHECKPOINT_GAP_THRESHOLD = 1_000;

/** Sample size for the projection consistency check. */
const PROJECTION_SAMPLE_SIZE = 200;

/** Known valid circle status values (must stay in sync with schema). */
const KNOWN_STATUSES = new Set(["Pending", "Active", "Completed", "Cancelled", "Closed"]);

// ── Types ─────────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "warning" | "fail";

export interface CheckFinding {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface RestoreVerifyReport {
  /** ISO-8601 timestamp when the report was generated. */
  generatedAt: string;
  /** Overall status: pass only when all checks pass, fail when any check fails,
   *  warning when at least one check warns and none fail. */
  overall: CheckStatus;
  /** Per-check findings. */
  findings: CheckFinding[];
  /** Human-readable one-line summary suitable for incident attachments. */
  summary: string;
  /** Schema version string from the latest applied migration (or null). */
  schemaVersion: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pass(name: string, message: string, detail?: string): CheckFinding {
  return { name, status: "pass", message, ...(detail ? { detail } : {}) };
}

function warn(name: string, message: string, detail?: string): CheckFinding {
  return { name, status: "warning", message, ...(detail ? { detail } : {}) };
}

function fail(name: string, message: string, detail?: string): CheckFinding {
  return { name, status: "fail", message, ...(detail ? { detail } : {}) };
}

/** Set the statement_timeout for the current transaction/session so no single
 *  check can block indefinitely on a large dataset. */
async function setQueryTimeout(client: PoolClient, ms: number): Promise<void> {
  await client.query(`SET statement_timeout = ${ms}`);
}

// ── Individual checks ─────────────────────────────────────────────────────────

/**
 * Check 1 — Schema version
 *
 * Reuses checkMigrationHealth() from migrate.ts (read-only; never applies
 * migrations). Reports:
 *   pass    — "clean" or "pending" state: the DB is coherent with its migration ledger.
 *   warning — "pending": behind but not corrupt; safe for read-only investigation.
 *   fail    — "uninitialized", "drifted", "partial", or "modified": the schema
 *             ledger is inconsistent with what we expect.
 */
async function checkSchemaVersion(
  client: PoolClient,
): Promise<CheckFinding & { schemaVersion: string | null }> {
  try {
    // Dynamically import to avoid pulling migrate.ts file-system deps into
    // all consumers; the import is cheap (already loaded at runtime).
    const { checkMigrationHealth } = await import("./migrate");
    const health = await checkMigrationHealth(client);

    const schemaVersion = health.status.currentVersion;

    if (health.state === "clean") {
      return {
        ...pass(
          "schema_version",
          `Schema is clean at version ${schemaVersion ?? "(base only)"}.`,
          health.summary,
        ),
        schemaVersion,
      };
    }

    if (health.state === "pending") {
      return {
        ...warn(
          "schema_version",
          `Schema is behind: ${health.status.pending.length} migration(s) pending. ` +
            `Safe for read-only investigation; run migrations to bring up to date.`,
          health.summary,
        ),
        schemaVersion,
      };
    }

    // uninitialized / drifted / partial / modified — coherence broken
    return {
      ...fail("schema_version", health.summary, `state=${health.state}`),
      schemaVersion,
    };
  } catch (err) {
    return {
      ...fail(
        "schema_version",
        `Schema check failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
      schemaVersion: null,
    };
  }
}

/**
 * Check 2 — Checkpoint continuity
 *
 * Reads ledger_checkpoints and detects:
 *   - Missing table (uninitialized restore).
 *   - No rows at all (indexer never ran or data was truncated).
 *   - Gaps between consecutive ledger sequence numbers larger than
 *     CHECKPOINT_GAP_THRESHOLD — signals missing ledgers that may leave
 *     projection state incomplete.
 *
 * Uses a bounded window query so the check is O(rows) not O(n²).
 */
async function checkCheckpointContinuity(client: PoolClient): Promise<CheckFinding> {
  try {
    // Count rows first (cheap)
    const countResult = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM ledger_checkpoints",
    );
    const totalRows = Number(countResult.rows[0]?.count ?? 0);

    if (totalRows === 0) {
      return warn(
        "checkpoint_continuity",
        "ledger_checkpoints has no rows — indexer may not have processed any ledgers yet.",
        "An empty checkpoint table is expected on a fresh restore before the indexer runs.",
      );
    }

    // Look for gaps using LAG() — bounded by planner stats, safe on large tables
    // with the idx_ledger_checkpoints_ledger DESC index.
    const gapResult = await client.query<{
      prev_ledger: string;
      curr_ledger: string;
      gap: string;
    }>(`
      SELECT
        LAG(ledger) OVER (ORDER BY ledger ASC) AS prev_ledger,
        ledger                                 AS curr_ledger,
        ledger - LAG(ledger) OVER (ORDER BY ledger ASC) AS gap
      FROM ledger_checkpoints
      ORDER BY ledger ASC
    `);

    const gaps = gapResult.rows
      .filter((r) => r.gap !== null && Number(r.gap) > CHECKPOINT_GAP_THRESHOLD)
      .map((r) => ({
        from: Number(r.prev_ledger),
        to:   Number(r.curr_ledger),
        gap:  Number(r.gap),
      }));

    if (gaps.length > 0) {
      const worst = gaps.reduce((a, b) => (b.gap > a.gap ? b : a));
      return fail(
        "checkpoint_continuity",
        `${gaps.length} ledger gap(s) exceeding threshold (${CHECKPOINT_GAP_THRESHOLD}) detected. ` +
          `Largest: ${worst.gap} ledgers (${worst.from}→${worst.to}).`,
        `Gaps indicate missing ledger batches that may leave projection state (circles, members) incomplete. ` +
          `Total checkpoints: ${totalRows}.`,
      );
    }

    const rangeResult = await client.query<{ min_ledger: string; max_ledger: string }>(
      "SELECT MIN(ledger) AS min_ledger, MAX(ledger) AS max_ledger FROM ledger_checkpoints",
    );
    const { min_ledger, max_ledger } = rangeResult.rows[0];

    return pass(
      "checkpoint_continuity",
      `${totalRows} checkpoint(s) present, no gaps > ${CHECKPOINT_GAP_THRESHOLD} ledgers. ` +
        `Ledger range: ${min_ledger}–${max_ledger}.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("relation") && message.includes("does not exist")) {
      return fail(
        "checkpoint_continuity",
        "ledger_checkpoints table does not exist — schema may be uninitialized.",
        "Run migrations before using this database with the indexer.",
      );
    }
    return fail(
      "checkpoint_continuity",
      `Checkpoint continuity check failed: ${message}`,
    );
  }
}

/**
 * Check 3 — Dedup constraints
 *
 * Verifies that the unique indexes enforcing event idempotency (issue #28)
 * exist in pg_indexes. A restored database that is missing these indexes
 * would allow duplicate events to be re-ingested, causing double-counting.
 *
 * Checks for:
 *   idx_ingested_events_identity — (ledger, tx_hash, event_index) partial unique index
 */
async function checkDedupConstraints(client: PoolClient): Promise<CheckFinding> {
  const REQUIRED_INDEXES = [
    { name: "idx_ingested_events_identity",  table: "ingested_events" },
    { name: "idx_circles_created_ledger",    table: "circles" },
    { name: "idx_circle_members_address",    table: "circle_members" },
  ];

  try {
    const result = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = ANY($1::text[])`,
      [REQUIRED_INDEXES.map((i) => i.name)],
    );

    const found = new Set(result.rows.map((r) => r.indexname));
    const missing = REQUIRED_INDEXES.filter((i) => !found.has(i.name));

    if (missing.length > 0) {
      return fail(
        "dedup_constraints",
        `${missing.length} required index(es) missing: ${missing.map((i) => i.name).join(", ")}.`,
        "Missing indexes may allow duplicate event ingestion or degrade query performance. " +
          "Run migrations on this restore to recreate them.",
      );
    }

    // Specifically verify the partial unique index that gates dedup
    const dedupIndex = found.has("idx_ingested_events_identity");
    if (!dedupIndex) {
      return fail(
        "dedup_constraints",
        "Critical dedup index idx_ingested_events_identity is absent.",
        "This index enforces at-least-once idempotency for event ingestion (issue #28). " +
          "Without it, replayed ledgers would create duplicate records.",
      );
    }

    return pass(
      "dedup_constraints",
      `All ${REQUIRED_INDEXES.length} required index(es) present including dedup constraint.`,
    );
  } catch (err) {
    return fail(
      "dedup_constraints",
      `Dedup constraint check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Check 4 — Projection consistency
 *
 * Samples up to PROJECTION_SAMPLE_SIZE circles rows and validates that each
 * is internally coherent:
 *   • current_round ≤ total_rounds
 *   • member_count  > 0
 *   • status is a known value
 *   • round_amount is numeric and positive
 *
 * A consistency violation here does not necessarily mean data loss — it may
 * reflect an in-flight event during the backup — but it is a signal that the
 * restore should be treated as incomplete until investigated.
 */
async function checkProjectionConsistency(client: PoolClient): Promise<CheckFinding> {
  try {
    const countResult = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM circles",
    );
    const totalCircles = Number(countResult.rows[0]?.count ?? 0);

    if (totalCircles === 0) {
      return warn(
        "projection_consistency",
        "circles table is empty — no projection data to verify.",
        "This is expected on a fresh database; investigate if you expected indexed data to be present.",
      );
    }

    const sampleResult = await client.query<{
      address: string;
      status: string;
      current_round: number;
      total_rounds: number;
      member_count: number;
      round_amount: string;
    }>(
      `SELECT address, status, current_round, total_rounds, member_count, round_amount
       FROM circles
       ORDER BY updated_at DESC
       LIMIT $1`,
      [PROJECTION_SAMPLE_SIZE],
    );

    const violations: string[] = [];

    for (const row of sampleResult.rows) {
      if (!KNOWN_STATUSES.has(row.status)) {
        violations.push(`circle ${row.address}: unknown status "${row.status}"`);
      }
      if (Number(row.current_round) > Number(row.total_rounds)) {
        violations.push(
          `circle ${row.address}: current_round (${row.current_round}) > total_rounds (${row.total_rounds})`,
        );
      }
      if (Number(row.member_count) <= 0) {
        violations.push(`circle ${row.address}: member_count is ${row.member_count} (must be > 0)`);
      }
      const amount = Number(row.round_amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        violations.push(`circle ${row.address}: round_amount "${row.round_amount}" is not a positive number`);
      }
    }

    if (violations.length > 0) {
      return fail(
        "projection_consistency",
        `${violations.length} projection inconsistency(ies) found in sample of ` +
          `${sampleResult.rows.length} circles (total: ${totalCircles}).`,
        violations.slice(0, 10).join("\n") +
          (violations.length > 10 ? `\n…and ${violations.length - 10} more.` : ""),
      );
    }

    return pass(
      "projection_consistency",
      `Sample of ${sampleResult.rows.length} circles (total: ${totalCircles}) is internally coherent.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("relation") && message.includes("does not exist")) {
      return fail(
        "projection_consistency",
        "circles table does not exist — schema may be uninitialized.",
      );
    }
    return fail(
      "projection_consistency",
      `Projection consistency check failed: ${message}`,
    );
  }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

/**
 * Run all restore-verification checks against a single Postgres client.
 *
 * The client must already be connected. This function only issues SELECT
 * queries and a SET statement_timeout — it never mutates data or schema.
 *
 * @param client    Connected pg PoolClient to run checks against.
 * @param timeoutMs Per-query statement_timeout in ms (default 10000).
 */
export async function runRestoreVerify(
  client: PoolClient,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RestoreVerifyReport> {
  await setQueryTimeout(client, timeoutMs);

  const schemaResult = await checkSchemaVersion(client);
  const [checkpoint, dedup, projection] = await Promise.all([
    checkCheckpointContinuity(client),
    checkDedupConstraints(client),
    checkProjectionConsistency(client),
  ]);

  const findings: CheckFinding[] = [
    { name: schemaResult.name, status: schemaResult.status, message: schemaResult.message, ...(schemaResult.detail ? { detail: schemaResult.detail } : {}) },
    checkpoint,
    dedup,
    projection,
  ];

  const hasFailure = findings.some((f) => f.status === "fail");
  const hasWarning = findings.some((f) => f.status === "warning");

  const overall: CheckStatus = hasFailure ? "fail" : hasWarning ? "warning" : "pass";

  const passingCount = findings.filter((f) => f.status === "pass").length;
  const warnCount    = findings.filter((f) => f.status === "warning").length;
  const failCount    = findings.filter((f) => f.status === "fail").length;

  const summary =
    overall === "pass"
      ? `Restore verification passed: all ${findings.length} checks passed.`
      : overall === "warning"
      ? `Restore verification has warnings: ${passingCount} passed, ${warnCount} warned, ${failCount} failed.`
      : `Restore verification FAILED: ${failCount} check(s) failed, ${warnCount} warned, ${passingCount} passed.`;

  return {
    generatedAt: new Date().toISOString(),
    overall,
    findings,
    summary,
    schemaVersion: schemaResult.schemaVersion,
  };
}

// ── Pretty printer ────────────────────────────────────────────────────────────

export function printRestoreVerifyReport(report: RestoreVerifyReport): void {
  const statusIcon = { pass: "✅", warning: "⚠️ ", fail: "❌" };
  console.log("\n[restore-verify] Database restore verification report");
  console.log(`  Generated at   : ${report.generatedAt}`);
  console.log(`  Schema version : ${report.schemaVersion ?? "(none)"}`);
  console.log(`  Overall        : ${statusIcon[report.overall]} ${report.overall.toUpperCase()}`);
  console.log("─".repeat(60));
  for (const f of report.findings) {
    console.log(`  ${statusIcon[f.status]} [${f.status.padEnd(7)}] ${f.name}: ${f.message}`);
    if (f.detail) {
      for (const line of f.detail.split("\n")) {
        console.log(`              ${line}`);
      }
    }
  }
  console.log("─".repeat(60));
  console.log(`  ${report.summary}`);
}

// ── CLI entry point ────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const printJson = args.includes("--json");
    const timeoutArg = args.find((a) => a.startsWith("--timeout-ms="));
    const timeoutMs = timeoutArg ? Number(timeoutArg.replace("--timeout-ms=", "")) : DEFAULT_TIMEOUT_MS;

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error("[restore-verify] DATABASE_URL environment variable is not set.");
      process.exit(2);
    }

    // Create a minimal pool just for this command — we never log the URL.
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    let client: PoolClient | null = null;

    try {
      try {
        client = await pool.connect();
      } catch (connErr) {
        console.error(
          "[restore-verify] Could not connect to the database. " +
            "Check DATABASE_URL and that the database is reachable.",
        );
        // Deliberately omit the connection error message to avoid leaking credentials.
        process.exit(2);
      }

      const report = await runRestoreVerify(client, timeoutMs);

      if (printJson) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printRestoreVerifyReport(report);
      }

      const exitCode = report.overall === "pass" ? 0 : 1;
      process.exit(exitCode);
    } finally {
      client?.release();
      await pool.end();
    }
  })();
}
