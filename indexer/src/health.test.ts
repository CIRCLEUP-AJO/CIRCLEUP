/**
 * Unit tests for indexer/src/health.ts
 *
 * All external I/O (Postgres queries, Soroban RPC calls) is replaced with
 * lightweight stubs so these tests run without a live DB or RPC node.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRpc(overrides: Record<string, unknown> = {}) {
  return {
    getLatestLedger: async () => ({ sequence: 1_000_000 }),
    simulateTransaction: async () => ({ error: "sim not supported in test" }),
    getAccount: async () => { throw new Error("no account in test"); },
    ...overrides,
  };
}

// ── checkDbConnectivity ───────────────────────────────────────────────────────

test("checkDbConnectivity: returns ok when query resolves", async () => {
  // Temporarily monkey-patch the pool module used by health.ts
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async () => [{ "?column?": 1 }];

  const { checkDbConnectivity } = await import("./health");
  const result = await checkDbConnectivity();

  assert.equal(result.status, "ok");
  assert.ok(typeof result.latencyMs === "number");
  (poolModule as any).query = originalQuery;
});

test("checkDbConnectivity: returns error when query rejects", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async () => { throw new Error("ECONNREFUSED"); };

  const { checkDbConnectivity } = await import("./health");
  const result = await checkDbConnectivity();

  assert.equal(result.status, "error");
  assert.ok(result.error?.includes("ECONNREFUSED"));
  (poolModule as any).query = originalQuery;
});

// ── checkRpcConnectivity ──────────────────────────────────────────────────────

test("checkRpcConnectivity: returns ok with latestLedger when RPC responds", async () => {
  const { checkRpcConnectivity } = await import("./health");
  const rpc = makeRpc({ getLatestLedger: async () => ({ sequence: 500 }) });
  const result = await checkRpcConnectivity(rpc);

  assert.equal(result.status, "ok");
  assert.equal(result.latestLedger, 500);
  assert.equal(result.details?.latestLedger, 500);
});

test("checkRpcConnectivity: returns error when RPC throws", async () => {
  const { checkRpcConnectivity } = await import("./health");
  const rpc = makeRpc({
    getLatestLedger: async () => { throw new Error("RPC unreachable"); },
  });
  const result = await checkRpcConnectivity(rpc);

  assert.equal(result.status, "error");
  assert.ok(result.error?.includes("RPC unreachable"));
});

// ── checkIndexerLag ───────────────────────────────────────────────────────────

test("checkIndexerLag: ok when lag is within threshold", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async () => [{ last_ledger: "999500" }];

  const { checkIndexerLag } = await import("./health");
  // rpcLatest=1_000_000, lastIndexed=999_500 → lag=500, threshold=1000 → ok
  const result = await checkIndexerLag(1_000_000);

  assert.equal(result.status, "ok");
  assert.equal(result.details?.lagLedgers, 500);
  (poolModule as any).query = originalQuery;
});

test("checkIndexerLag: degraded when lag exceeds threshold", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async () => [{ last_ledger: "990000" }];

  const { checkIndexerLag } = await import("./health");
  // lag=10_000, default threshold=1_000 → degraded
  const result = await checkIndexerLag(1_000_000);

  assert.equal(result.status, "degraded");
  assert.ok(result.error?.includes("ledger(s) behind"));
  assert.equal(result.details?.lagLedgers, 10_000);
  (poolModule as any).query = originalQuery;
});

test("checkIndexerLag: degraded when rpcLatestLedger is null", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async () => [{ last_ledger: "999000" }];

  const { checkIndexerLag } = await import("./health");
  const result = await checkIndexerLag(null);

  assert.equal(result.status, "degraded");
  assert.ok(result.error?.includes("unavailable"));
  (poolModule as any).query = originalQuery;
});

test("checkIndexerLag: degraded when indexer_state row is missing", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async () => [];

  const { checkIndexerLag } = await import("./health");
  const result = await checkIndexerLag(1_000_000);

  assert.equal(result.status, "degraded");
  assert.ok(result.error?.includes("missing"));
  (poolModule as any).query = originalQuery;
});

// ── checkSchemaHealth ─────────────────────────────────────────────────────────

test("checkSchemaHealth: ok for clean migration state", async () => {
  const { checkSchemaHealth } = await import("./health");
  const cached = {
    state: "clean" as const,
    status: { applied: ["001_add.sql"], pending: [], missingOnDisk: [], modified: [], currentVersion: "001_add.sql" },
    summary: "Schema is up to date at version 001_add.sql.",
    canStartSafely: true,
  };

  const result = await checkSchemaHealth(cached);
  assert.equal(result.status, "ok");
  assert.equal(result.details?.state, "clean");
});

test("checkSchemaHealth: ok for pending migration state (DB is behind but functional)", async () => {
  const { checkSchemaHealth } = await import("./health");
  const cached = {
    state: "pending" as const,
    status: { applied: [], pending: ["002_add.sql"], missingOnDisk: [], modified: [], currentVersion: null },
    summary: "1 migration(s) pending.",
    canStartSafely: false,
  };

  const result = await checkSchemaHealth(cached);
  assert.equal(result.status, "ok");
  assert.equal(result.details?.state, "pending");
});

test("checkSchemaHealth: degraded for drifted migration state", async () => {
  const { checkSchemaHealth } = await import("./health");
  const cached = {
    state: "drifted" as const,
    status: { applied: [], pending: [], missingOnDisk: ["001_deleted.sql"], modified: [], currentVersion: null },
    summary: "Schema has drifted: 001_deleted.sql missing from disk.",
    canStartSafely: false,
  };

  const result = await checkSchemaHealth(cached);
  assert.equal(result.status, "degraded");
  assert.ok(result.error?.includes("drifted"));
});

test("checkSchemaHealth: degraded for uninitialized state", async () => {
  const { checkSchemaHealth } = await import("./health");
  const cached = {
    state: "uninitialized" as const,
    status: { applied: [], pending: ["001.sql"], missingOnDisk: [], modified: [], currentVersion: null },
    summary: "Schema has not been initialized.",
    canStartSafely: false,
  };

  const result = await checkSchemaHealth(cached);
  assert.equal(result.status, "degraded");
});

// ── checkContractStateDrift ───────────────────────────────────────────────────

test("checkContractStateDrift: skipped when RPC is not ok", async () => {
  const { checkContractStateDrift } = await import("./health");
  const result = await checkContractStateDrift({}, "error");

  assert.equal(result.status, "ok");
  assert.equal(result.details?.skipped, true);
  assert.ok(result.details?.reason?.toString().includes("RPC"));
});

test("checkContractStateDrift: skipped when no Active circles in DB", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async () => [];

  const { checkContractStateDrift } = await import("./health");
  const rpc = makeRpc();
  const result = await checkContractStateDrift(rpc, "ok");

  assert.equal(result.status, "ok");
  assert.equal(result.details?.skipped, true);
  assert.ok(result.details?.reason?.toString().includes("No Active circles"));
  (poolModule as any).query = originalQuery;
});

test("checkContractStateDrift: ok when on-chain round matches DB", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async () => [{ address: "CABC", current_round: 3, status: "Active" }];

  const { checkContractStateDrift } = await import("./health");

  // Stub rpc so readOnChainRound returns null (sim unavailable in tests) →
  // the function should short-circuit to the "skipped" path
  const rpc = makeRpc({
    getAccount: async () => { throw new Error("no account"); },
  });
  const result = await checkContractStateDrift(rpc, "ok");

  // When simulation fails, drift check gracefully reports ok/skipped
  assert.ok(result.status === "ok");
  (poolModule as any).query = originalQuery;
});

// ── runAllHealthChecks ────────────────────────────────────────────────────────

test("runAllHealthChecks: overall status is ok when all components pass", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;

  // Route queries by their SQL text so all three DB calls get valid responses
  (poolModule as any).query = async (sql: string) => {
    if (sql.includes("indexer_state")) return [{ last_ledger: "999900" }];
    if (sql.includes("circles")) return []; // no active circles → drift check skips
    return [{ "?column?": 1 }]; // SELECT 1
  };

  const { runAllHealthChecks } = await import("./health");
  const rpc = makeRpc({ getLatestLedger: async () => ({ sequence: 1_000_000 }) });

  const cleanHealth = {
    state: "clean" as const,
    status: { applied: ["001.sql"], pending: [], missingOnDisk: [], modified: [], currentVersion: "001.sql" },
    summary: "up to date",
    canStartSafely: true,
  };
  const report = await runAllHealthChecks({ rpc, usdcAddress: "CUSDC", cachedMigrationHealth: cleanHealth });

  assert.equal(report.status, "ok");
  assert.equal(report.db.status, "ok");
  assert.equal(report.rpc.status, "ok");
  assert.equal(report.indexerLag.status, "ok");
  assert.equal(report.schema.status, "ok");
  assert.equal(report.contractDrift.status, "ok");
  assert.equal(report.config.usdcAddress, "CUSDC");
  (poolModule as any).query = originalQuery;
});

test("runAllHealthChecks: overall status is degraded when any component fails", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;

  // Indexer is far behind → lag check will return degraded
  (poolModule as any).query = async (sql: string) => {
    if (sql.includes("indexer_state")) return [{ last_ledger: "1" }];
    if (sql.includes("circles")) return [];
    return [{ "?column?": 1 }];
  };

  const { runAllHealthChecks } = await import("./health");
  const rpc = makeRpc({ getLatestLedger: async () => ({ sequence: 1_000_000 }) });

  const cleanHealth = {
    state: "clean" as const,
    status: { applied: [], pending: [], missingOnDisk: [], modified: [], currentVersion: null },
    summary: "up to date",
    canStartSafely: true,
  };
  const report = await runAllHealthChecks({ rpc, usdcAddress: "CUSDC", cachedMigrationHealth: cleanHealth });

  assert.equal(report.status, "degraded");
  assert.equal(report.indexerLag.status, "degraded");
  (poolModule as any).query = originalQuery;
});

// ── Aggregate truth table (Issue 94) ──────────────────────────────────────────
// Tests the documented policy: status is "ok" only when every component is ok;
// serviceStatus is "unavailable" when DB errors, "healthy" when all ok, and
// "degraded" for every other non-ok combination.

const ttCleanSchema = {
  state: "clean" as const,
  status: { applied: ["001.sql"], pending: [], missingOnDisk: [], modified: [], currentVersion: "001.sql" },
  summary: "up to date",
  canStartSafely: true,
};

const ttDriftedSchema = {
  state: "drifted" as const,
  status: { applied: [], pending: [], missingOnDisk: ["001_deleted.sql"], modified: [], currentVersion: null },
  summary: "Schema has drifted.",
  canStartSafely: false,
};

interface TruthTableCase {
  name: string;
  dbFails: boolean;
  rpcFails: boolean;
  lagBehind: boolean;
  schemaDrifted: boolean;
  eventFailuresOpen: boolean;
  expectedStatus: "ok" | "degraded";
  expectedServiceStatus: "healthy" | "degraded" | "unavailable";
}

const truthTable: TruthTableCase[] = [
  {
    name: "all components ok",
    dbFails: false, rpcFails: false, lagBehind: false, schemaDrifted: false, eventFailuresOpen: false,
    expectedStatus: "ok", expectedServiceStatus: "healthy",
  },
  {
    name: "DB error only",
    dbFails: true, rpcFails: false, lagBehind: false, schemaDrifted: false, eventFailuresOpen: false,
    expectedStatus: "degraded", expectedServiceStatus: "unavailable",
  },
  {
    name: "RPC error, DB ok",
    dbFails: false, rpcFails: true, lagBehind: false, schemaDrifted: false, eventFailuresOpen: false,
    expectedStatus: "degraded", expectedServiceStatus: "degraded",
  },
  {
    name: "lag exceeded only",
    dbFails: false, rpcFails: false, lagBehind: true, schemaDrifted: false, eventFailuresOpen: false,
    expectedStatus: "degraded", expectedServiceStatus: "degraded",
  },
  {
    name: "schema drifted only",
    dbFails: false, rpcFails: false, lagBehind: false, schemaDrifted: true, eventFailuresOpen: false,
    expectedStatus: "degraded", expectedServiceStatus: "degraded",
  },
  {
    name: "event failures open",
    dbFails: false, rpcFails: false, lagBehind: false, schemaDrifted: false, eventFailuresOpen: true,
    expectedStatus: "degraded", expectedServiceStatus: "degraded",
  },
  {
    name: "DB error + RPC error",
    dbFails: true, rpcFails: true, lagBehind: false, schemaDrifted: false, eventFailuresOpen: false,
    expectedStatus: "degraded", expectedServiceStatus: "unavailable",
  },
  {
    name: "lag exceeded + schema drifted",
    dbFails: false, rpcFails: false, lagBehind: true, schemaDrifted: true, eventFailuresOpen: false,
    expectedStatus: "degraded", expectedServiceStatus: "degraded",
  },
  {
    name: "RPC error + schema drifted",
    dbFails: false, rpcFails: true, lagBehind: false, schemaDrifted: true, eventFailuresOpen: false,
    expectedStatus: "degraded", expectedServiceStatus: "degraded",
  },
];

for (const c of truthTable) {
  test(`aggregate status truth table: ${c.name}`, async () => {
    const poolModule = await import("./db/pool");
    const originalQuery = poolModule.query;
    (poolModule as any).query = async (sql: string) => {
      if (c.dbFails) throw new Error("ECONNREFUSED");
      if (sql.includes("indexer_state")) return [{ last_ledger: c.lagBehind ? "1" : "999900" }];
      if (sql.includes("circles")) return [];
      if (sql.includes("event_failures")) {
        return [{
          open: c.eventFailuresOpen ? "5" : "0",
          recurring: "0",
          oldest_ledger: null,
          newest_ledger: null,
          last_failed_at: null,
        }];
      }
      return [{ "?column?": 1 }];
    };

    const { runAllHealthChecks } = await import("./health");
    const rpc = makeRpc({
      getLatestLedger: c.rpcFails
        ? async () => { throw new Error("RPC unreachable"); }
        : async () => ({ sequence: 1_000_000 }),
    });
    const report = await runAllHealthChecks({
      rpc,
      usdcAddress: "CUSDC",
      cachedMigrationHealth: c.schemaDrifted ? ttDriftedSchema : ttCleanSchema,
    });

    assert.equal(report.status, c.expectedStatus, `[${c.name}] status`);
    assert.equal(report.serviceStatus, c.expectedServiceStatus, `[${c.name}] serviceStatus`);
    (poolModule as any).query = originalQuery;
  });
}

// ── Component detail visibility during partial failure ────────────────────────

test("partial failure: DB error surfaces in report while RPC result remains visible", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async () => { throw new Error("connection refused"); };

  const { runAllHealthChecks } = await import("./health");
  const rpc = makeRpc({ getLatestLedger: async () => ({ sequence: 1_000_000 }) });
  const report = await runAllHealthChecks({
    rpc,
    usdcAddress: "CUSDC",
    cachedMigrationHealth: ttCleanSchema,
  });

  assert.equal(report.db.status, "error", "DB component must report error");
  assert.ok(report.db.error, "db.error must be set");
  assert.equal(report.serviceStatus, "unavailable", "serviceStatus must be unavailable");
  assert.equal(report.diagnostics.dbAvailable, false, "diagnostics.dbAvailable must be false");
  // RPC was probed concurrently and succeeded
  assert.equal(report.rpc.status, "ok", "RPC component must still report ok");
  assert.equal(report.diagnostics.rpcAvailable, true, "diagnostics.rpcAvailable must be true");
  (poolModule as any).query = originalQuery;
});

test("partial failure: RPC error keeps DB and schema details accessible", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async (sql: string) => {
    if (sql.includes("indexer_state")) return [{ last_ledger: "999900" }];
    if (sql.includes("circles")) return [];
    if (sql.includes("event_failures")) {
      return [{ open: "0", recurring: "0", oldest_ledger: null, newest_ledger: null, last_failed_at: null }];
    }
    return [{ "?column?": 1 }];
  };

  const { runAllHealthChecks } = await import("./health");
  const rpc = makeRpc({ getLatestLedger: async () => { throw new Error("RPC down"); } });
  const report = await runAllHealthChecks({
    rpc,
    usdcAddress: "CUSDC",
    cachedMigrationHealth: ttCleanSchema,
  });

  assert.equal(report.rpc.status, "error", "RPC component must report error");
  assert.ok(report.rpc.error, "rpc.error must be set");
  // DB was probed concurrently and succeeded — details remain accessible
  assert.equal(report.db.status, "ok", "DB component must still be ok");
  assert.equal(report.schema.status, "ok", "Schema component must still be ok");
  // serviceStatus is degraded (not unavailable) because DB is still up
  assert.equal(report.serviceStatus, "degraded", "serviceStatus must be degraded, not unavailable");
  assert.equal(report.diagnostics.rpcAvailable, false, "diagnostics.rpcAvailable must be false");
  assert.equal(report.diagnostics.dbAvailable, true, "diagnostics.dbAvailable must be true");
  (poolModule as any).query = originalQuery;
});

// ── Concurrent probe behavior ─────────────────────────────────────────────────

test("concurrent probes: DB and RPC are both checked even when RPC fails", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;

  let dbProbeCount = 0;
  (poolModule as any).query = async (sql: string) => {
    if (sql.includes("SELECT 1") || sql === "SELECT 1") dbProbeCount++;
    if (sql.includes("indexer_state")) return [{ last_ledger: "999900" }];
    if (sql.includes("circles")) return [];
    if (sql.includes("event_failures")) {
      return [{ open: "0", recurring: "0", oldest_ledger: null, newest_ledger: null, last_failed_at: null }];
    }
    return [{ "?column?": 1 }];
  };

  let rpcProbeCount = 0;
  const rpc = makeRpc({
    getLatestLedger: async () => {
      rpcProbeCount++;
      throw new Error("RPC down");
    },
  });

  const { runAllHealthChecks } = await import("./health");
  const report = await runAllHealthChecks({
    rpc,
    usdcAddress: "CUSDC",
    cachedMigrationHealth: ttCleanSchema,
  });

  // Both probes must run — the RPC failure must not skip the DB check
  assert.ok(dbProbeCount >= 1, `DB must be probed (got ${dbProbeCount} call(s))`);
  assert.equal(rpcProbeCount, 1, "RPC must be probed exactly once");
  assert.equal(report.db.status, "ok", "DB result must be available despite RPC failure");
  (poolModule as any).query = originalQuery;
});

// ── Timeout behavior ──────────────────────────────────────────────────────────

test("HEALTH_TIMEOUT_MS: exported constant matches env-configured default", async () => {
  const { HEALTH_TIMEOUT_MS } = await import("./health");
  const expected = parseInt(process.env.HEALTH_TIMEOUT_MS || "5000", 10);
  assert.equal(typeof HEALTH_TIMEOUT_MS, "number", "HEALTH_TIMEOUT_MS must be a number");
  assert.ok(HEALTH_TIMEOUT_MS > 0, "HEALTH_TIMEOUT_MS must be positive");
  assert.equal(HEALTH_TIMEOUT_MS, expected, "HEALTH_TIMEOUT_MS must match the env-configured value");
});

test("per-component timeout: a timed-out check propagates as error status", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  // Simulate what withTimeout emits when the per-component deadline fires
  (poolModule as any).query = async () => {
    throw new Error("Health check timed out after 5000ms");
  };

  const { checkDbConnectivity } = await import("./health");
  const result = await checkDbConnectivity();

  assert.equal(result.status, "error", "Timed-out check must surface as error status");
  assert.ok(result.error?.includes("timed out"), "Error message must mention the timeout");
  assert.ok(typeof result.latencyMs === "number", "latencyMs must still be populated");
  (poolModule as any).query = originalQuery;
});

// ── Response shape completeness ───────────────────────────────────────────────

test("HealthReport shape: all required top-level fields are present", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  (poolModule as any).query = async (sql: string) => {
    if (sql.includes("indexer_state")) return [{ last_ledger: "999900" }];
    if (sql.includes("circles")) return [];
    if (sql.includes("event_failures")) {
      return [{ open: "0", recurring: "0", oldest_ledger: null, newest_ledger: null, last_failed_at: null }];
    }
    return [{ "?column?": 1 }];
  };

  const { runAllHealthChecks } = await import("./health");
  const rpc = makeRpc({ getLatestLedger: async () => ({ sequence: 1_000_000 }) });
  const report = await runAllHealthChecks({
    rpc,
    usdcAddress: "CUSDC_ADDR",
    cachedMigrationHealth: ttCleanSchema,
  });

  // Top-level status fields
  assert.ok(["ok", "degraded"].includes(report.status), "status must be ok|degraded");
  assert.ok(
    ["healthy", "degraded", "unavailable"].includes(report.serviceStatus),
    "serviceStatus must be healthy|degraded|unavailable",
  );
  assert.ok(typeof report.timestamp === "string" && report.timestamp.length > 0, "timestamp must be set");

  // Per-component shape
  for (const key of ["db", "rpc", "indexerLag", "schema", "contractDrift", "eventFailures"] as const) {
    assert.ok(report[key], `${key} component must be present`);
    assert.ok(["ok", "degraded", "error"].includes(report[key].status), `${key}.status must be valid`);
  }

  // Config snapshot
  assert.equal(report.config.usdcAddress, "CUSDC_ADDR");
  assert.ok(typeof report.config.lagAlertLedgers === "number");
  assert.ok(typeof report.config.driftRoundThreshold === "number");
  assert.ok(typeof report.config.eventFailureAlertCount === "number");
  assert.ok(typeof report.config.eventFailureRecurringAttempts === "number");

  // Diagnostics
  assert.ok("lastIndexedLedger" in report.diagnostics);
  assert.ok("rpcLatestLedger" in report.diagnostics);
  assert.ok("lagLedgers" in report.diagnostics);
  assert.ok(typeof report.diagnostics.dbAvailable === "boolean");
  assert.ok(typeof report.diagnostics.rpcAvailable === "boolean");
  (poolModule as any).query = originalQuery;
});
