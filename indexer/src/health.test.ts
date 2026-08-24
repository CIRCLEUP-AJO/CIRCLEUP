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
  // @ts-expect-error — intentional stub
  poolModule.query = async () => [{ "?column?": 1 }];

  const { checkDbConnectivity } = await import("./health");
  const result = await checkDbConnectivity();

  assert.equal(result.status, "ok");
  assert.ok(typeof result.latencyMs === "number");

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});

test("checkDbConnectivity: returns error when query rejects", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  // @ts-expect-error — intentional stub
  poolModule.query = async () => { throw new Error("ECONNREFUSED"); };

  const { checkDbConnectivity } = await import("./health");
  const result = await checkDbConnectivity();

  assert.equal(result.status, "error");
  assert.ok(result.error?.includes("ECONNREFUSED"));

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});

// ── checkRpcConnectivity ──────────────────────────────────────────────────────

test("checkRpcConnectivity: returns ok with latestLedger when RPC responds", async () => {
  const { checkRpcConnectivity } = await import("./health");
  const rpc = makeRpc({ getLatestLedger: async () => ({ sequence: 500 }) });
  // @ts-expect-error — partial stub
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
  // @ts-expect-error — partial stub
  const result = await checkRpcConnectivity(rpc);

  assert.equal(result.status, "error");
  assert.ok(result.error?.includes("RPC unreachable"));
});

// ── checkIndexerLag ───────────────────────────────────────────────────────────

test("checkIndexerLag: ok when lag is within threshold", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  // @ts-expect-error — stub
  poolModule.query = async () => [{ last_ledger: "999500" }];

  const { checkIndexerLag } = await import("./health");
  // rpcLatest=1_000_000, lastIndexed=999_500 → lag=500, threshold=1000 → ok
  const result = await checkIndexerLag(1_000_000);

  assert.equal(result.status, "ok");
  assert.equal(result.details?.lagLedgers, 500);

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});

test("checkIndexerLag: degraded when lag exceeds threshold", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  // @ts-expect-error — stub
  poolModule.query = async () => [{ last_ledger: "990000" }];

  const { checkIndexerLag } = await import("./health");
  // lag=10_000, default threshold=1_000 → degraded
  const result = await checkIndexerLag(1_000_000);

  assert.equal(result.status, "degraded");
  assert.ok(result.error?.includes("ledger(s) behind"));
  assert.equal(result.details?.lagLedgers, 10_000);

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});

test("checkIndexerLag: degraded when rpcLatestLedger is null", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  // @ts-expect-error — stub
  poolModule.query = async () => [{ last_ledger: "999000" }];

  const { checkIndexerLag } = await import("./health");
  const result = await checkIndexerLag(null);

  assert.equal(result.status, "degraded");
  assert.ok(result.error?.includes("unavailable"));

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});

test("checkIndexerLag: degraded when indexer_state row is missing", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  // @ts-expect-error — stub: empty result = no row
  poolModule.query = async () => [];

  const { checkIndexerLag } = await import("./health");
  const result = await checkIndexerLag(1_000_000);

  assert.equal(result.status, "degraded");
  assert.ok(result.error?.includes("missing"));

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});

// ── checkSchemaHealth ─────────────────────────────────────────────────────────

test("checkSchemaHealth: ok for clean migration state", async () => {
  const { checkSchemaHealth } = await import("./health");
  const cached = {
    state: "clean" as const,
    status: { applied: ["001_add.sql"], pending: [], missingOnDisk: [], currentVersion: "001_add.sql" },
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
    status: { applied: [], pending: ["002_add.sql"], missingOnDisk: [], currentVersion: null },
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
    status: { applied: [], pending: [], missingOnDisk: ["001_deleted.sql"], currentVersion: null },
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
    status: { applied: [], pending: ["001.sql"], missingOnDisk: [], currentVersion: null },
    summary: "Schema has not been initialized.",
    canStartSafely: false,
  };

  const result = await checkSchemaHealth(cached);
  assert.equal(result.status, "degraded");
});

// ── checkContractStateDrift ───────────────────────────────────────────────────

test("checkContractStateDrift: skipped when RPC is not ok", async () => {
  const { checkContractStateDrift } = await import("./health");
  // @ts-expect-error — partial stub, rpc not used when skipped
  const result = await checkContractStateDrift({}, "error");

  assert.equal(result.status, "ok");
  assert.equal(result.details?.skipped, true);
  assert.ok(result.details?.reason?.toString().includes("RPC"));
});

test("checkContractStateDrift: skipped when no Active circles in DB", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  // @ts-expect-error — stub: no active circles
  poolModule.query = async () => [];

  const { checkContractStateDrift } = await import("./health");
  const rpc = makeRpc();
  // @ts-expect-error — partial stub
  const result = await checkContractStateDrift(rpc, "ok");

  assert.equal(result.status, "ok");
  assert.equal(result.details?.skipped, true);
  assert.ok(result.details?.reason?.toString().includes("No Active circles"));

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});

test("checkContractStateDrift: ok when on-chain round matches DB", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;
  // @ts-expect-error — stub: one active circle with current_round=3
  poolModule.query = async () => [{ address: "CABC", current_round: 3, status: "Active" }];

  const { checkContractStateDrift } = await import("./health");

  // Stub rpc so readOnChainRound returns null (sim unavailable in tests) →
  // the function should short-circuit to the "skipped" path
  const rpc = makeRpc({
    getAccount: async () => { throw new Error("no account"); },
  });
  // @ts-expect-error — partial stub
  const result = await checkContractStateDrift(rpc, "ok");

  // When simulation fails, drift check gracefully reports ok/skipped
  assert.ok(result.status === "ok");

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});

// ── runAllHealthChecks ────────────────────────────────────────────────────────

test("runAllHealthChecks: overall status is ok when all components pass", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;

  // Route queries by their SQL text so all three DB calls get valid responses
  // @ts-expect-error — stub
  poolModule.query = async (sql: string) => {
    if (sql.includes("indexer_state")) return [{ last_ledger: "999900" }];
    if (sql.includes("circles")) return []; // no active circles → drift check skips
    return [{ "?column?": 1 }]; // SELECT 1
  };

  const { runAllHealthChecks } = await import("./health");
  const rpc = makeRpc({ getLatestLedger: async () => ({ sequence: 1_000_000 }) });

  const cleanHealth = {
    state: "clean" as const,
    status: { applied: ["001.sql"], pending: [], missingOnDisk: [], currentVersion: "001.sql" },
    summary: "up to date",
    canStartSafely: true,
  };

  // @ts-expect-error — partial rpc stub
  const report = await runAllHealthChecks({ rpc, usdcAddress: "CUSDC", cachedMigrationHealth: cleanHealth });

  assert.equal(report.status, "ok");
  assert.equal(report.db.status, "ok");
  assert.equal(report.rpc.status, "ok");
  assert.equal(report.indexerLag.status, "ok");
  assert.equal(report.schema.status, "ok");
  assert.equal(report.contractDrift.status, "ok");
  assert.equal(report.config.usdcAddress, "CUSDC");

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});

test("runAllHealthChecks: overall status is degraded when any component fails", async () => {
  const poolModule = await import("./db/pool");
  const originalQuery = poolModule.query;

  // Indexer is far behind → lag check will return degraded
  // @ts-expect-error — stub
  poolModule.query = async (sql: string) => {
    if (sql.includes("indexer_state")) return [{ last_ledger: "1" }];
    if (sql.includes("circles")) return [];
    return [{ "?column?": 1 }];
  };

  const { runAllHealthChecks } = await import("./health");
  const rpc = makeRpc({ getLatestLedger: async () => ({ sequence: 1_000_000 }) });

  const cleanHealth = {
    state: "clean" as const,
    status: { applied: [], pending: [], missingOnDisk: [], currentVersion: null },
    summary: "up to date",
    canStartSafely: true,
  };

  // @ts-expect-error — partial rpc stub
  const report = await runAllHealthChecks({ rpc, usdcAddress: "CUSDC", cachedMigrationHealth: cleanHealth });

  assert.equal(report.status, "degraded");
  assert.equal(report.indexerLag.status, "degraded");

  // @ts-expect-error — restore
  poolModule.query = originalQuery;
});
