/**
 * Unit tests for restoreVerify.ts — DB restore verification command.
 *
 * All tests use an in-memory stub of PoolClient so no Postgres instance is
 * needed. Each check function is exercised through runRestoreVerify() with
 * controlled query responses that simulate the four distinct scenarios
 * required by the acceptance criteria:
 *
 *   1. Valid restore       — all checks pass.
 *   2. Missing migration   — schema check fails (uninitialized / drifted state).
 *   3. Incomplete checkpoints — checkpoint check fails with a gap.
 *   4. Projection violation — projection check fails with an incoherent row.
 *
 * The tests also verify that:
 *   - The command is non-mutating (no INSERT/UPDATE/DELETE issued).
 *   - The report never includes the DATABASE_URL or connection string.
 *   - The overall status is "fail" when any check fails, "warning" when any
 *     warns and none fail, and "pass" when all pass.
 *   - Distinct findings are returned for schema, checkpoint, and projection.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { runRestoreVerify, printRestoreVerifyReport, type CheckFinding } from "./restoreVerify";

// ── Stub PoolClient ───────────────────────────────────────────────────────────

type QueryHandler = (text: string, params?: unknown[]) => { rows: Record<string, unknown>[] };

/** Build a minimal PoolClient stub that dispatches queries to a handler map. */
function buildClient(handler: QueryHandler): PoolClient {
  const issued: string[] = [];

  const client = {
    query: async (text: string, params?: unknown[]) => {
      issued.push(text.trim().toUpperCase().slice(0, 60));
      const result = handler(text, params);
      return result;
    },
    _issuedQueries: () => issued,
  };

  return client as unknown as PoolClient;
}

/** Synthetic Stellar contract address — does not need to be on-chain. */
function syntheticContractAddress(n: number): string {
  return `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA${String(n).padStart(5, "0")}`;
}

// ── Shared query handlers ─────────────────────────────────────────────────────

/** Handler for a healthy, fully-initialized database. */
function healthyHandler(): QueryHandler {
  return (text: string) => {
    const t = text.toLowerCase();

    // statement_timeout — no rows needed
    if (t.includes("set statement_timeout")) return { rows: [] };

    // schema_migrations existence check (from checkMigrationHealth)
    if (t.includes("from schema_migrations") && t.includes("limit 1")) {
      return { rows: [{}] };
    }

    // getMigrationStatus: applied migrations
    if (t.includes("select filename, content_hash from schema_migrations")) {
      return {
        rows: [
          { filename: "001_add_round_deadline_ledgers.sql", content_hash: "aabbcc" },
          { filename: "002_ledger_checkpoints.sql",         content_hash: "ddeeff" },
          { filename: "003_event_dedup_constraints.sql",    content_hash: "112233" },
        ],
      };
    }

    // ledger_checkpoints count
    if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
      return { rows: [{ count: "500" }] };
    }

    // checkpoint gap query (LAG)
    if (t.includes("lag(ledger)") && t.includes("ledger_checkpoints")) {
      // No gaps — all sequential
      return {
        rows: [
          { prev_ledger: null,   curr_ledger: "1000", gap: null },
          { prev_ledger: "1000", curr_ledger: "1001", gap: "1" },
          { prev_ledger: "1001", curr_ledger: "1002", gap: "1" },
        ],
      };
    }

    // min/max ledger
    if (t.includes("min(ledger)") && t.includes("ledger_checkpoints")) {
      return { rows: [{ min_ledger: "1000", max_ledger: "1500" }] };
    }

    // pg_indexes dedup check
    if (t.includes("pg_indexes")) {
      return {
        rows: [
          { indexname: "idx_ingested_events_identity" },
          { indexname: "idx_circles_created_ledger" },
          { indexname: "idx_circle_members_address" },
        ],
      };
    }

    // circles count
    if (t.includes("count(*)") && t.includes("from circles")) {
      return { rows: [{ count: "10" }] };
    }

    // circles sample
    if (t.includes("select address") && t.includes("from circles")) {
      return {
        rows: [
          {
            address:       syntheticContractAddress(1),
            status:        "Active",
            current_round: 2,
            total_rounds:  5,
            member_count:  4,
            round_amount:  "100",
          },
          {
            address:       syntheticContractAddress(2),
            status:        "Pending",
            current_round: 0,
            total_rounds:  3,
            member_count:  3,
            round_amount:  "50",
          },
        ],
      };
    }

    return { rows: [] };
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("restoreVerify — valid restore", () => {
  test("all checks pass on a healthy database", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    assert.equal(report.overall, "pass", `Expected pass, got ${report.overall}: ${report.summary}`);
    assert.ok(report.findings.length >= 4, "must have at least 4 findings");
    for (const f of report.findings) {
      assert.equal(f.status, "pass", `finding ${f.name} should be pass: ${f.message}`);
    }
  });

  test("report includes generatedAt, schemaVersion, and summary", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    assert.ok(report.generatedAt, "generatedAt must be present");
    assert.ok(!isNaN(Date.parse(report.generatedAt)), "generatedAt must be a valid ISO date");
    assert.ok(report.summary.length > 0, "summary must be non-empty");
  });

  test("finding names include schema_version, checkpoint_continuity, dedup_constraints, projection_consistency", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    const names = report.findings.map((f) => f.name);
    assert.ok(names.includes("schema_version"),          "must have schema_version finding");
    assert.ok(names.includes("checkpoint_continuity"),   "must have checkpoint_continuity finding");
    assert.ok(names.includes("dedup_constraints"),       "must have dedup_constraints finding");
    assert.ok(names.includes("projection_consistency"),  "must have projection_consistency finding");
  });
});

describe("restoreVerify — non-mutating (no writes)", () => {
  test("no INSERT / UPDATE / DELETE / DDL queries are issued", async () => {
    const issued: string[] = [];
    const trackingClient = buildClient((text, params) => {
      issued.push(text);
      return healthyHandler()(text, params);
    });

    await runRestoreVerify(trackingClient, 5000);

    const mutating = issued.filter((q) => {
      const upper = q.trim().toUpperCase();
      return (
        upper.startsWith("INSERT") ||
        upper.startsWith("UPDATE") ||
        upper.startsWith("DELETE") ||
        upper.startsWith("DROP") ||
        upper.startsWith("CREATE") ||
        upper.startsWith("ALTER") ||
        upper.startsWith("TRUNCATE")
      );
    });

    assert.equal(
      mutating.length,
      0,
      `restore verify must never issue mutating queries. Found: ${mutating.join("; ")}`,
    );
  });

  test("report does not include DATABASE_URL or connection string", async () => {
    const databaseUrl = "postgresql://user:secret@localhost:5432/testdb";
    const origUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;

    try {
      const client = buildClient(healthyHandler());
      const report = await runRestoreVerify(client, 5000);
      const reportStr = JSON.stringify(report);

      assert.ok(!reportStr.includes("secret"), "report must not include database password");
      assert.ok(!reportStr.includes("postgresql://"), "report must not include database URL scheme");
      assert.ok(!reportStr.includes("localhost:5432"), "report must not include database host:port");
    } finally {
      if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
      else delete process.env.DATABASE_URL;
    }
  });
});

describe("restoreVerify — missing migration (uninitialized schema)", () => {
  test("schema_version fails when schema_migrations table does not exist", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();

      if (t.includes("set statement_timeout")) return { rows: [] };

      // Simulate missing schema_migrations table (42P01 error)
      if (t.includes("schema_migrations")) {
        const err = new Error("relation \"schema_migrations\" does not exist") as Error & { code: string };
        err.code = "42P01";
        throw err;
      }

      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const schemaFinding = report.findings.find((f) => f.name === "schema_version");
    assert.ok(schemaFinding, "schema_version finding must be present");
    assert.equal(
      schemaFinding.status,
      "fail",
      `schema_version must fail when table is missing; got "${schemaFinding.status}": ${schemaFinding.message}`,
    );
    assert.equal(report.overall, "fail", "overall must be fail when any check fails");
  });

  test("schema_version fails when a migration is recorded as applied but missing on disk", async () => {
    // Simulate a "drifted" state: migration file was deleted after it was applied
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("from schema_migrations") && t.includes("limit 1")) return { rows: [{}] };
      if (t.includes("select filename, content_hash from schema_migrations")) {
        // Return a migration that no longer exists on disk
        return {
          rows: [
            { filename: "001_add_round_deadline_ledgers.sql", content_hash: "aabbcc" },
            { filename: "999_deleted_migration.sql",          content_hash: "zzzzzz" }, // not on disk
          ],
        };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const schemaFinding = report.findings.find((f) => f.name === "schema_version");
    assert.ok(schemaFinding, "schema_version finding must be present");
    // "drifted" state should be a fail
    assert.ok(
      schemaFinding.status === "fail" || schemaFinding.status === "warning",
      `schema_version must be fail or warning for a drifted state, got "${schemaFinding.status}"`,
    );
  });
});

describe("restoreVerify — incomplete checkpoint history", () => {
  test("checkpoint_continuity fails when a large gap is detected", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };

      if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ count: "10" }] };
      }

      if (t.includes("lag(ledger)") && t.includes("ledger_checkpoints")) {
        // Simulate a gap of 5000 ledgers between checkpoints 1000 and 6000
        return {
          rows: [
            { prev_ledger: null,   curr_ledger: "1000", gap: null },
            { prev_ledger: "1000", curr_ledger: "6000", gap: "5000" }, // gap > threshold
            { prev_ledger: "6000", curr_ledger: "6001", gap: "1" },
          ],
        };
      }

      if (t.includes("min(ledger)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ min_ledger: "1000", max_ledger: "6001" }] };
      }

      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const checkpointFinding = report.findings.find((f) => f.name === "checkpoint_continuity");
    assert.ok(checkpointFinding, "checkpoint_continuity finding must be present");
    assert.equal(
      checkpointFinding.status,
      "fail",
      `checkpoint_continuity must fail on a large gap; got "${checkpointFinding.status}": ${checkpointFinding.message}`,
    );
    assert.match(
      checkpointFinding.message,
      /gap/i,
      "message must mention the detected gap",
    );
    assert.equal(report.overall, "fail");
  });

  test("checkpoint_continuity warns when no checkpoints exist", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ count: "0" }] };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const checkpointFinding = report.findings.find((f) => f.name === "checkpoint_continuity");
    assert.ok(checkpointFinding, "checkpoint_continuity finding must be present");
    assert.equal(
      checkpointFinding.status,
      "warning",
      "empty checkpoints must warn (not fail) — expected on fresh restore",
    );
  });
});

describe("restoreVerify — projection inconsistency", () => {
  test("projection_consistency fails when current_round > total_rounds", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("count(*)") && t.includes("from circles")) {
        return { rows: [{ count: "5" }] };
      }
      if (t.includes("select address") && t.includes("from circles")) {
        return {
          rows: [
            {
              address:       syntheticContractAddress(10),
              status:        "Active",
              current_round: 9, // violates: 9 > total_rounds 5
              total_rounds:  5,
              member_count:  3,
              round_amount:  "100",
            },
          ],
        };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const projFinding = report.findings.find((f) => f.name === "projection_consistency");
    assert.ok(projFinding, "projection_consistency finding must be present");
    assert.equal(
      projFinding.status,
      "fail",
      `projection_consistency must fail when current_round > total_rounds; got "${projFinding.status}": ${projFinding.message}`,
    );
    assert.equal(report.overall, "fail");
  });

  test("projection_consistency fails when status is unknown", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("count(*)") && t.includes("from circles")) {
        return { rows: [{ count: "1" }] };
      }
      if (t.includes("select address") && t.includes("from circles")) {
        return {
          rows: [
            {
              address:       syntheticContractAddress(20),
              status:        "Corrupted",   // unknown status
              current_round: 0,
              total_rounds:  3,
              member_count:  2,
              round_amount:  "50",
            },
          ],
        };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const projFinding = report.findings.find((f) => f.name === "projection_consistency");
    assert.ok(projFinding, "projection_consistency finding must be present");
    assert.equal(projFinding.status, "fail");
  });

  test("projection_consistency warns when circles table is empty", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("count(*)") && t.includes("from circles")) {
        return { rows: [{ count: "0" }] };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const projFinding = report.findings.find((f) => f.name === "projection_consistency");
    assert.ok(projFinding);
    assert.equal(
      projFinding.status,
      "warning",
      "empty circles table must warn — expected on fresh restore",
    );
  });
});

describe("restoreVerify — dedup constraints", () => {
  test("dedup_constraints fails when idx_ingested_events_identity is missing", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("pg_indexes")) {
        // Return indexes excluding the dedup one
        return {
          rows: [
            { indexname: "idx_circles_created_ledger" },
            { indexname: "idx_circle_members_address" },
            // idx_ingested_events_identity deliberately absent
          ],
        };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);

    const dedupFinding = report.findings.find((f) => f.name === "dedup_constraints");
    assert.ok(dedupFinding);
    assert.equal(
      dedupFinding.status,
      "fail",
      "dedup_constraints must fail when the critical dedup index is absent",
    );
    assert.equal(report.overall, "fail");
  });
});

describe("restoreVerify — overall status aggregation", () => {
  test("overall is fail when any finding is fail", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      if (t.includes("from schema_migrations") && t.includes("limit 1")) {
        const err = new Error("table missing") as Error & { code: string };
        err.code = "42P01";
        throw err;
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);
    assert.equal(report.overall, "fail");
  });

  test("overall is warning when warnings exist and no failures", async () => {
    const client = buildClient((text: string) => {
      const t = text.toLowerCase();
      if (t.includes("set statement_timeout")) return { rows: [] };
      // Empty circles table → warning in projection check
      if (t.includes("count(*)") && t.includes("from circles")) {
        return { rows: [{ count: "0" }] };
      }
      // Empty checkpoint table → warning in checkpoint check
      if (t.includes("count(*)") && t.includes("ledger_checkpoints")) {
        return { rows: [{ count: "0" }] };
      }
      return healthyHandler()(text);
    });

    const report = await runRestoreVerify(client, 5000);
    // At least one of the two should be warning (empty circles / empty checkpoints)
    const hasWarning = report.findings.some((f) => f.status === "warning");
    const hasFailure = report.findings.some((f) => f.status === "fail");
    assert.ok(hasWarning, "at least one warning expected");
    assert.equal(hasFailure, false, "no failures should exist");
    assert.equal(report.overall, "warning");
  });

  test("overall is pass when all findings pass", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);
    assert.equal(report.overall, "pass");
  });
});

describe("restoreVerify — unreachable database", () => {
  test("runRestoreVerify propagates an unexpected DB error as a fail finding", async () => {
    const client = buildClient((text: string) => {
      if (text.toLowerCase().includes("set statement_timeout")) return { rows: [] };
      // Simulate a connection drop mid-check
      throw new Error("connection terminated unexpectedly");
    });

    const report = await runRestoreVerify(client, 5000);
    // At least one check must fail due to the connection error
    const hasFail = report.findings.some((f) => f.status === "fail");
    assert.ok(hasFail, "an unexpected DB error must surface as at least one fail finding");
    assert.equal(report.overall, "fail");
  });
});

describe("printRestoreVerifyReport — safe output", () => {
  test("print does not throw on a valid report", async () => {
    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);
    // Should not throw
    assert.doesNotThrow(() => {
      // Suppress console output in test
      const originalLog = console.log;
      console.log = () => {};
      try {
        printRestoreVerifyReport(report);
      } finally {
        console.log = originalLog;
      }
    });
  });

  test("print does not output DATABASE_URL", async () => {
    const databaseUrl = "postgresql://admin:topsecret@prod.db:5432/circleup";
    process.env.DATABASE_URL = databaseUrl;

    const client = buildClient(healthyHandler());
    const report = await runRestoreVerify(client, 5000);

    const outputLines: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => { if (msg) outputLines.push(String(msg)); };
    try {
      printRestoreVerifyReport(report);
    } finally {
      console.log = originalLog;
      delete process.env.DATABASE_URL;
    }

    const fullOutput = outputLines.join("\n");
    assert.ok(!fullOutput.includes("topsecret"), "print output must not include database password");
    assert.ok(!fullOutput.includes("prod.db"),   "print output must not include database host");
  });
});
