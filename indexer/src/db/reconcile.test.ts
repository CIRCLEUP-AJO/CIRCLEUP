/**
 * Unit tests for dry-run reconciliation preview, plan generation, and apply confirmation (Issue #945).
 *
 * Tests run without requiring a live Postgres instance or RPC node by injecting
 * mock query and simulation functions.
 */

// ── Minimal env bootstrap ─────────────────────────────────────────────────────
// Must come before ANY import of ./reconcile or ./config so assertEnvVars() sees
// values when it executes at module-load time.
process.env.DATABASE_URL           = "postgresql://test:test@localhost:5432/test";
process.env.STELLAR_RPC_URL        = "https://soroban-testnet.stellar.org";
process.env.CIRCLE_FACTORY_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
process.env.REPUTATION_ADDRESS     = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
process.env.USDC_ADDRESS           = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { StrKey } from "@stellar/stellar-sdk";

// require() ensures process.env is populated before config.ts validation runs.
const {
  isFieldSupported,
  formatSqlPreview,
  compareDifferences,
  createRepairPlan,
  applyRepairPlan,
  repairDifferences,
  runReconciliationReport,
} = require("./reconcile");

import type {
  Difference,
  ReconciliationReport,
  QueryFn,
  SimulateReadFn,
} from "./reconcile";

// ── Test Fixtures ─────────────────────────────────────────────────────────────

const CIRCLE_ADDR = StrKey.encodeContract(Buffer.alloc(32, 1));
const CIRCLE_ADDR_2 = StrKey.encodeContract(Buffer.alloc(32, 2));
const MEMBER_ADDR_1 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
const MEMBER_ADDR_2 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));

function createMockReport(overrides: Partial<ReconciliationReport> = {}): ReconciliationReport {
  return {
    generatedAt: "2026-11-25T10:00:00.000Z",
    circlesScanned: 2,
    circlesSkippedGrace: 1,
    membersScanned: 3,
    reputationScanned: 2,
    unreadable: [
      {
        entity: "circle",
        key: CIRCLE_ADDR_2,
        error: "get_status: simulation failed: HostError",
      },
    ],
    differences: [
      {
        entity: "circle",
        key: CIRCLE_ADDR,
        field: "status",
        indexed: "Pending",
        canonical: "Active",
      },
      {
        entity: "circle_member",
        key: `${CIRCLE_ADDR}:${MEMBER_ADDR_1}`,
        field: "collateral",
        indexed: "0",
        canonical: "100000000",
      },
      {
        entity: "reputation",
        key: MEMBER_ADDR_1,
        field: "score",
        indexed: "50",
        canonical: "75",
      },
    ],
    ...overrides,
  };
}

// ── 1. Field Support Validation ───────────────────────────────────────────────

describe("isFieldSupported", () => {
  test("identifies supported circle fields", () => {
    assert.equal(isFieldSupported("circle", "status"), true);
    assert.equal(isFieldSupported("circle", "current_round"), true);
    assert.equal(isFieldSupported("circle", "total_rounds"), true);
    assert.equal(isFieldSupported("circle", "member_count"), true);
    assert.equal(isFieldSupported("circle", "round_amount"), true);
  });

  test("rejects unsupported circle fields", () => {
    assert.equal(isFieldSupported("circle", "address"), false);
    assert.equal(isFieldSupported("circle", "creator"), false);
    assert.equal(isFieldSupported("circle", "unknown_field"), false);
  });

  test("identifies supported circle_member fields", () => {
    assert.equal(isFieldSupported("circle_member", "collateral"), true);
    assert.equal(isFieldSupported("circle_member", "defaults"), true);
  });

  test("rejects unsupported circle_member fields", () => {
    assert.equal(isFieldSupported("circle_member", "payout_order"), false);
    assert.equal(isFieldSupported("circle_member", "member_address"), false);
  });

  test("identifies supported reputation fields", () => {
    assert.equal(isFieldSupported("reputation", "score"), true);
    assert.equal(isFieldSupported("reputation", "tier"), false);
  });

  test("rejects unknown entity types", () => {
    assert.equal(isFieldSupported("unknown" as unknown as Difference["entity"], "status"), false);
  });
});

// ── 2. SQL Preview Generation ────────────────────────────────────────────────

describe("formatSqlPreview", () => {
  test("formats preview for circle status with indexed condition", () => {
    const diff: Difference = {
      entity: "circle",
      key: CIRCLE_ADDR,
      field: "status",
      indexed: "Pending",
      canonical: "Active",
    };
    const sql = formatSqlPreview(diff);
    assert.ok(sql);
    assert.match(sql, /UPDATE circles SET status = \$1::text/);
    assert.match(sql, /WHERE address = \$2 AND status = \$3::text/);
    assert.match(sql, /canonical='Active'/);
    assert.match(sql, /indexed='Pending'/);
  });

  test("formats preview for circle_member field splitting compound key", () => {
    const diff: Difference = {
      entity: "circle_member",
      key: `${CIRCLE_ADDR}:${MEMBER_ADDR_1}`,
      field: "collateral",
      indexed: "0",
      canonical: "500",
    };
    const sql = formatSqlPreview(diff);
    assert.ok(sql);
    assert.match(sql, /UPDATE circle_members SET collateral = \$1::numeric/);
    assert.match(sql, /WHERE circle_address = \$2 AND member_address = \$3 AND collateral = \$4::numeric/);
    assert.match(sql, new RegExp(`circle='${CIRCLE_ADDR}'`));
    assert.match(sql, new RegExp(`member='${MEMBER_ADDR_1}'`));
  });

  test("formats preview for reputation score", () => {
    const diff: Difference = {
      entity: "reputation",
      key: MEMBER_ADDR_1,
      field: "score",
      indexed: "10",
      canonical: "25",
    };
    const sql = formatSqlPreview(diff);
    assert.ok(sql);
    assert.match(sql, /UPDATE reputation SET score = \$1::integer/);
    assert.match(sql, /WHERE member_address = \$2 AND score = \$3::integer/);
  });

  test("returns undefined for unsupported fields", () => {
    const diff: Difference = {
      entity: "circle",
      key: CIRCLE_ADDR,
      field: "unsupported_field",
      indexed: "a",
      canonical: "b",
    };
    assert.equal(formatSqlPreview(diff), undefined);
  });
});

// ── 3. Deterministic Sorting & Plan Generation ────────────────────────────────

describe("compareDifferences", () => {
  test("sorts deterministically by entity, key, and field", () => {
    const a: Difference = { entity: "circle", key: "A", field: "status", indexed: "1", canonical: "2" };
    const b: Difference = { entity: "circle", key: "B", field: "status", indexed: "1", canonical: "2" };
    const c: Difference = { entity: "circle_member", key: "A", field: "collateral", indexed: "1", canonical: "2" };
    const d: Difference = { entity: "circle", key: "A", field: "current_round", indexed: "1", canonical: "2" };

    const diffs = [c, b, a, d];
    diffs.sort(compareDifferences);

    // Order:
    // 1. entity "circle", key "A", field "current_round"
    // 2. entity "circle", key "A", field "status"
    // 3. entity "circle", key "B", field "status"
    // 4. entity "circle_member", key "A", field "collateral"
    assert.deepEqual(diffs, [d, a, b, c]);
  });
});

describe("createRepairPlan (deterministic preview)", () => {
  test("creates a complete dry-run plan without mutations", () => {
    const report = createMockReport();
    const plan = createRepairPlan(report);

    assert.equal(plan.dryRun, true);
    assert.equal(plan.totalDifferences, 3);
    assert.equal(plan.capped, false);
    assert.equal(plan.skippedGrace, 1);
    assert.equal(plan.unreadable.length, 1);
    assert.equal(plan.plannedRepairs.length, 3);

    assert.equal(plan.summary.circlesScanned, 2);
    assert.equal(plan.summary.circlesSkippedGrace, 1);
    assert.equal(plan.summary.differencesFound, 3);
    assert.equal(plan.summary.plannedRepairs, 3);
    assert.equal(plan.summary.unsupportedFields, 0);
    assert.equal(plan.summary.unreadableCount, 1);

    for (const repair of plan.plannedRepairs) {
      assert.equal(repair.supported, true);
      assert.ok(repair.sqlPreview);
    }
  });

  test("produces identical output on repeated runs with shuffled inputs", () => {
    const report1 = createMockReport();
    const report2 = createMockReport({
      differences: [...report1.differences].reverse(),
    });

    const plan1 = createRepairPlan(report1);
    const plan2 = createRepairPlan(report2);

    assert.deepEqual(plan1.plannedRepairs, plan2.plannedRepairs);
  });

  test("bounds output when maxRepairs cap is exceeded", () => {
    const report = createMockReport();
    const plan = createRepairPlan(report, { maxRepairs: 2 });

    assert.equal(plan.capped, true);
    assert.equal(plan.maxRepairs, 2);
    assert.equal(plan.totalDifferences, 3);
    assert.equal(plan.plannedRepairs.length, 2);
    assert.equal(plan.summary.plannedRepairs, 2);
    assert.equal(plan.summary.differencesFound, 3);
  });

  test("flags unsupported fields within the dry-run plan", () => {
    const report = createMockReport({
      differences: [
        {
          entity: "circle",
          key: CIRCLE_ADDR,
          field: "unsupported_attr",
          indexed: "1",
          canonical: "2",
        },
      ],
    });

    const plan = createRepairPlan(report);
    assert.equal(plan.plannedRepairs.length, 1);
    assert.equal(plan.plannedRepairs[0].supported, false);
    assert.equal(plan.plannedRepairs[0].sqlPreview, undefined);
    assert.equal(plan.summary.unsupportedFields, 1);
  });
});

// ── 4. Apply Confirmation & Guarded Updates ──────────────────────────────────

describe("applyRepairPlan", () => {
  test("rejects mutation when confirm is missing or false", async () => {
    const report = createMockReport();
    const plan = createRepairPlan(report);

    let queryExecuted = false;
    const mockQuery: QueryFn = async () => {
      queryExecuted = true;
      return [];
    };

    await assert.rejects(
      async () => {
        await applyRepairPlan(plan, {}, mockQuery);
      },
      {
        message: /Mutation rejected: applying a repair plan requires explicit confirmation/,
      },
    );

    await assert.rejects(
      async () => {
        await applyRepairPlan(plan, { confirm: false }, mockQuery);
      },
      {
        message: /Mutation rejected: applying a repair plan requires explicit confirmation/,
      },
    );

    assert.equal(queryExecuted, false, "Must not execute any queries when unconfirmed");
  });

  test("applies repairs when confirmed and reports outcomes", async () => {
    const report = createMockReport({
      differences: [
        {
          entity: "circle",
          key: CIRCLE_ADDR,
          field: "status",
          indexed: "Pending",
          canonical: "Active",
        },
      ],
    });
    const plan = createRepairPlan(report);

    const executedSql: { sql: string; params: unknown[] }[] = [];
    const mockQuery: QueryFn = async (sql, params) => {
      executedSql.push({ sql, params: params ?? [] });
      return [{ address: CIRCLE_ADDR }];
    };

    const outcomes = await applyRepairPlan(plan, { confirm: true }, mockQuery);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "applied");
    assert.equal(outcomes[0].entity, "circle");
    assert.equal(outcomes[0].field, "status");

    assert.equal(executedSql.length, 1);
    assert.match(executedSql[0].sql, /UPDATE circles SET status = \$1::text/);
    assert.match(executedSql[0].sql, /WHERE address = \$2 AND status = \$3::text/);
    assert.deepEqual(executedSql[0].params, ["Active", CIRCLE_ADDR, "Pending"]);
  });

  test("safely skips concurrent changes between preview and apply (skipped_stale)", async () => {
    const report = createMockReport({
      differences: [
        {
          entity: "circle",
          key: CIRCLE_ADDR,
          field: "current_round",
          indexed: "1",
          canonical: "2",
        },
      ],
    });
    const plan = createRepairPlan(report);

    // Simulate concurrent modification: row was updated so WHERE condition matches 0 rows
    const mockQuery: QueryFn = async () => [];

    const outcomes = await applyRepairPlan(plan, { confirm: true }, mockQuery);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "skipped_stale");
    assert.equal(outcomes[0].field, "current_round");
  });

  test("handles unsupported fields safely without issuing mutations", async () => {
    const report = createMockReport({
      differences: [
        {
          entity: "circle",
          key: CIRCLE_ADDR,
          field: "unsupported_field",
          indexed: "old",
          canonical: "new",
        },
      ],
    });
    const plan = createRepairPlan(report);

    let queryExecuted = false;
    const mockQuery: QueryFn = async () => {
      queryExecuted = true;
      return [];
    };

    const outcomes = await applyRepairPlan(plan, { confirm: true }, mockQuery);

    assert.equal(queryExecuted, false, "Must not execute query for unsupported field");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "unsupported_field");
  });

  test("handles database query errors gracefully", async () => {
    const report = createMockReport({
      differences: [
        {
          entity: "circle",
          key: CIRCLE_ADDR,
          field: "status",
          indexed: "Pending",
          canonical: "Active",
        },
      ],
    });
    const plan = createRepairPlan(report);

    const mockQuery: QueryFn = async () => {
      throw new Error("Connection pool exhausted");
    };

    const outcomes = await applyRepairPlan(plan, { confirm: true }, mockQuery);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "error");
    assert.equal(outcomes[0].error, "Connection pool exhausted");
  });

  test("repairDifferences backwards compatibility wrapper works with confirm", async () => {
    const diffs: Difference[] = [
      {
        entity: "circle",
        key: CIRCLE_ADDR,
        field: "status",
        indexed: "Pending",
        canonical: "Active",
      },
    ];

    const mockQuery: QueryFn = async () => [{ address: CIRCLE_ADDR }];
    const outcomes = await repairDifferences(diffs, {}, mockQuery);

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].outcome, "applied");
  });
});

// ── 5. End-to-end Reconciliation Report & Read-only Invariant ─────────────────

describe("runReconciliationReport", () => {
  test("read-only invariant: only issues SELECT queries", async () => {
    const issuedQueries: string[] = [];

    const mockQuery: QueryFn = async (sql, params) => {
      issuedQueries.push(sql);
      if (sql.includes("FROM circles")) {
        const offset = (params?.length === 3 ? params[2] : params?.[1]) as number;
        if (offset > 0) return [];
        return [
          {
            address: CIRCLE_ADDR,
            status: "Pending",
            current_round: 1,
            total_rounds: 3,
            member_count: 3,
            round_amount: "100000000",
            updated_at: new Date(Date.now() - 60000), // older than 30s grace window
          },
        ];
      }
      if (sql.includes("FROM circle_members")) {
        return [];
      }
      return [];
    };

    const mockSimRead: SimulateReadFn = async (_src, _contract, method) => {
      if (method === "get_status") {
        return { ok: true, value: "Active" };
      }
      if (method === "get_config") {
        return {
          ok: true,
          value: {
            members: [MEMBER_ADDR_1, MEMBER_ADDR_2, CIRCLE_ADDR],
            round_amount: 100000000n,
          },
        };
      }
      if (method === "get_current_round") {
        return { ok: true, value: { round_index: 1 } };
      }
      return { ok: false, error: "unknown method" };
    };

    const report = await runReconciliationReport({
      circleAddress: CIRCLE_ADDR,
      pageSize: 10,
      graceMs: 30000,
      queryFn: mockQuery,
      simulateRead: mockSimRead,
    });

    // Invariant: all queries must be SELECT
    for (const q of issuedQueries) {
      assert.match(q.trim(), /^SELECT/i, `Expected read-only SELECT query, got: ${q}`);
    }

    assert.equal(report.circlesScanned, 1);
    assert.equal(report.circlesSkippedGrace, 0);
    assert.equal(report.differences.length, 1);
    assert.equal(report.differences[0].field, "status");
    assert.equal(report.differences[0].indexed, "Pending");
    assert.equal(report.differences[0].canonical, "Active");

    // Previewing the plan from this report:
    const plan = createRepairPlan(report);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.plannedRepairs.length, 1);
    assert.equal(plan.plannedRepairs[0].supported, true);
  });

  test("skips circles within the grace window", async () => {
    const mockQuery: QueryFn = async (sql, params) => {
      if (sql.includes("FROM circles")) {
        const offset = (params?.length === 3 ? params[2] : params?.[1]) as number;
        if (offset > 0) return [];
        return [
          {
            address: CIRCLE_ADDR,
            status: "Pending",
            current_round: 1,
            total_rounds: 3,
            member_count: 3,
            round_amount: "100000000",
            updated_at: new Date(), // Just updated!
          },
        ];
      }
      return [];
    };

    let simCalled = false;
    const mockSimRead: SimulateReadFn = async () => {
      simCalled = true;
      return { ok: true, value: {} };
    };

    const report = await runReconciliationReport({
      circleAddress: CIRCLE_ADDR,
      graceMs: 30000,
      queryFn: mockQuery,
      simulateRead: mockSimRead,
    });

    assert.equal(report.circlesScanned, 0);
    assert.equal(report.circlesSkippedGrace, 1);
    assert.equal(report.differences.length, 0);
    assert.equal(simCalled, false, "Should not simulate RPC for records in grace window");

    const plan = createRepairPlan(report);
    assert.equal(plan.skippedGrace, 1);
    assert.equal(plan.plannedRepairs.length, 0);
  });

  test("captures unreadable RPC failures in report and repair plan", async () => {
    const mockQuery: QueryFn = async (sql, params) => {
      if (sql.includes("FROM circles")) {
        const offset = (params?.length === 3 ? params[2] : params?.[1]) as number;
        if (offset > 0) return [];
        return [
          {
            address: CIRCLE_ADDR,
            status: "Active",
            current_round: 1,
            total_rounds: 3,
            member_count: 3,
            round_amount: "100000000",
            updated_at: new Date(Date.now() - 60000),
          },
        ];
      }
      return [];
    };

    const mockSimRead: SimulateReadFn = async (_src, _contract, method) => {
      if (method === "get_status") {
        return { ok: false, error: "ContractNotFound" };
      }
      return { ok: true, value: {} };
    };

    const report = await runReconciliationReport({
      circleAddress: CIRCLE_ADDR,
      queryFn: mockQuery,
      simulateRead: mockSimRead,
    });

    assert.equal(report.circlesScanned, 1);
    assert.equal(report.unreadable.length, 1);
    assert.equal(report.unreadable[0].entity, "circle");
    assert.equal(report.unreadable[0].key, CIRCLE_ADDR);
    assert.match(report.unreadable[0].error, /ContractNotFound/);
    assert.equal(report.differences.length, 0);

    const plan = createRepairPlan(report);
    assert.equal(plan.unreadable.length, 1);
    assert.equal(plan.plannedRepairs.length, 0);
    assert.equal(plan.summary.unreadableCount, 1);
  });
});
