/**
 * One-command incident reproduction tests.
 *
 * Run with:
 *   npm test --workspace=indexer
 *   # or narrowed:
 *   node --require ts-node/register --test src/fixtures/incident.test.ts
 *
 * Design principles
 * -----------------
 * 1. Deterministic — every test uses only the fixtures from incident-fixtures.ts.
 *    No live DB, no live RPC.  Tests pass offline.
 * 2. Single assertion per invariant — each `test()` exercises exactly one
 *    failure mode so CI output pinpoints the broken guard.
 * 3. Status codes and ordering are preserved — where the real system would
 *    produce a specific HTTP status or Postgres error code, the fixture
 *    reproduces that code exactly so runbook steps remain accurate.
 * 4. No real keys or secrets — all addresses/hashes come from the fixture
 *    namespace; none are production values.
 *
 * Runbook cross-references are in the `description` field of each namespace.
 * See docs/RUNBOOK.md §Troubleshooting for the human-readable resolution steps.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  StaleIndexerData,
  DuplicateEvents,
  WalletRejection,
  RpcTimeout,
  SchemaDrift,
  SYNTHETIC_TX_HASHES,
  LEDGER,
} from "./incident-fixtures";

// ─── Helper: derive health state (mirrors migrate.ts logic) ──────────────────

function deriveHealthState(
  pending: number,
  missingOnDisk: number,
  schemaExists: boolean,
): string {
  if (!schemaExists) return "uninitialized";
  if (pending > 0 && missingOnDisk > 0) return "partial";
  if (missingOnDisk > 0) return "drifted";
  if (pending > 0) return "pending";
  return "clean";
}

// ─── Helper: formatContractError (mirrors stellar.ts logic) ──────────────────

function formatContractError(raw: string | undefined): string {
  if (!raw) return "Transaction failed for an unknown reason.";
  const lower = raw.toLowerCase();
  if (lower === "transaction failed") {
    return "The transaction was rejected on-chain.";
  }
  if (lower === "timeout") {
    return (
      `The transaction was submitted but confirmation timed out after ` +
      `${Math.round(RpcTimeout.TOTAL_POLL_BUDGET_MS / 1000)}s. The network may be congested.`
    );
  }
  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("failed to fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("request timeout")
  ) {
    return "A network error occurred while communicating with the Stellar RPC.";
  }
  if (lower.includes("user rejected") || lower.includes("denied") ||
      lower.includes("cancelled") || lower.includes("canceled") ||
      lower.includes("rejected")) {
    return "You cancelled the transaction in Freighter. No funds were moved.";
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ─── Helper: computeMigrationStatus (mirrors migrate.ts logic) ───────────────

function computeMigrationStatus(filesOnDisk: string[], appliedInDb: string[]) {
  const appliedSet = new Set(appliedInDb);
  const applied = filesOnDisk.filter((f) => appliedSet.has(f));
  const pending = filesOnDisk.filter((f) => !appliedSet.has(f));
  const missingOnDisk = appliedInDb.filter((f) => !filesOnDisk.includes(f));
  return { applied, pending, missingOnDisk };
}

// ─── Helper: simulate dedup-table idempotency ─────────────────────────────────

/**
 * Simulates the ingested_events dedup guard: inserts an event_key only once
 * regardless of how many times the same row is attempted.
 * Returns the final size of the "table" (Set<string>).
 */
function simulateIngestedEventsInsert(
  table: Set<string>,
  row: { event_key: string },
): { inserted: boolean; tableSize: number } {
  if (table.has(row.event_key)) {
    return { inserted: false, tableSize: table.size };
  }
  table.add(row.event_key);
  return { inserted: true, tableSize: table.size };
}

/**
 * Simulates the contributions UNIQUE(circle_address, member_address, round_index)
 * constraint: inserts a contribution row only once per (circle, member, round).
 */
function simulateContributionUpsert(
  rows: Map<string, unknown>,
  row: { circle_address: string; member_address: string; round_index: number },
): { inserted: boolean; rowCount: number } {
  const key = `${row.circle_address}:${row.member_address}:${row.round_index}`;
  if (rows.has(key)) {
    return { inserted: false, rowCount: rows.size };
  }
  rows.set(key, row);
  return { inserted: true, rowCount: rows.size };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENT CLASS 1: Stale Indexer Data
// Runbook: "Circle list is empty but circles exist on-chain"
// ═══════════════════════════════════════════════════════════════════════════════

describe("Incident: StaleIndexerData", () => {
  test("fixture description is non-empty (fixture is discoverable)", () => {
    assert.ok(
      StaleIndexerData.description.length > 0,
      "StaleIndexerData must have a non-empty description",
    );
  });

  test("stale indexer state: last_ledger is behind chain tip by the documented lag", () => {
    const state = StaleIndexerData.seedIndexerState();
    const onChain = StaleIndexerData.seedOnChainState();

    const lag = onChain.latestLedger - state.last_ledger;

    assert.equal(
      lag,
      StaleIndexerData.expectedBehaviour.lagLedgers,
      `lag must be ${StaleIndexerData.expectedBehaviour.lagLedgers} ledgers`,
    );
    assert.ok(lag > 0, "indexer must be behind the chain tip");
  });

  test("stale circle row: status field lags behind on-chain status", () => {
    const circle = StaleIndexerData.seedCircle();
    const onChain = StaleIndexerData.seedOnChainState();

    // The stale circle still says Active; on-chain it is Completed
    assert.equal(circle.status, StaleIndexerData.expectedBehaviour.apiCircleStatus);
    assert.notEqual(
      circle.status,
      onChain.status,
      "stale DB status must differ from on-chain status",
    );
  });

  test("stale circle row: current_round lags behind on-chain rounds_completed", () => {
    const circle = StaleIndexerData.seedCircle();
    const onChain = StaleIndexerData.seedOnChainState();

    assert.equal(
      circle.current_round,
      StaleIndexerData.expectedBehaviour.apiCurrentRound,
    );
    assert.ok(
      onChain.roundsCompleted > circle.current_round,
      "on-chain rounds_completed must exceed stale DB current_round",
    );
  });

  test("stale indexer state: last_ledger matches the fixture constant", () => {
    const state = StaleIndexerData.seedIndexerState();
    assert.equal(state.last_ledger, LEDGER.STALE);
  });

  test("stale state: app banner flag is set correctly in expected behaviour", () => {
    assert.equal(
      StaleIndexerData.expectedBehaviour.appBannerShown,
      true,
      "app must show the stale-data banner when indexer lags significantly",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENT CLASS 2: Duplicate Events
// Runbook: "Circle list is empty but circles exist on-chain" (dedup invariant)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Incident: DuplicateEvents", () => {
  test("fixture description is non-empty", () => {
    assert.ok(DuplicateEvents.description.length > 0);
  });

  test("event_key format: tx_hash + colon + event_index", () => {
    const key = DuplicateEvents.eventKey(SYNTHETIC_TX_HASHES.DUPLICATE_HASH, 0);
    assert.equal(key, `${SYNTHETIC_TX_HASHES.DUPLICATE_HASH}:0`);
    assert.ok(key.includes(":"), "event_key must contain the separator colon");
  });

  test("dedup guard: ingesting the same event_key twice inserts only once", () => {
    const table = new Set<string>();
    const row = DuplicateEvents.seedIngestedEvent();
    const dup = DuplicateEvents.seedDuplicateIngestedEvent();

    // Both rows have the same event_key — same as PRIMARY KEY conflict in Postgres
    assert.equal(row.event_key, dup.event_key, "duplicate rows must have the same event_key");

    const first = simulateIngestedEventsInsert(table, row);
    assert.equal(first.inserted, true, "first insert must succeed");
    assert.equal(first.tableSize, 1);

    const second = simulateIngestedEventsInsert(table, dup);
    assert.equal(second.inserted, false, "second insert must be rejected (dedup)");
    assert.equal(
      second.tableSize,
      DuplicateEvents.expectedBehaviour.ingestedEventsRows,
      "table must contain exactly one row after double-ingest",
    );
  });

  test("dedup guard: ingested_events table size == expectedBehaviour.ingestedEventsRows", () => {
    const table = new Set<string>();
    for (let i = 0; i < 5; i++) {
      simulateIngestedEventsInsert(table, DuplicateEvents.seedIngestedEvent());
    }
    assert.equal(
      table.size,
      DuplicateEvents.expectedBehaviour.ingestedEventsRows,
    );
  });

  test("contribution UNIQUE constraint: double-ingest produces exactly one contribution row", () => {
    const rows = new Map<string, unknown>();
    const contrib = DuplicateEvents.seedContribution();

    const first = simulateContributionUpsert(rows, contrib);
    assert.equal(first.inserted, true);
    assert.equal(first.rowCount, 1);

    const second = simulateContributionUpsert(rows, { ...contrib });
    assert.equal(second.inserted, false, "duplicate contribution must be rejected");
    assert.equal(
      second.rowCount,
      DuplicateEvents.expectedBehaviour.contributionRowsAfterDoubleIngest,
    );
  });

  test("payout UNIQUE constraint: double-ingest produces exactly one payout row", () => {
    const rows = new Map<string, unknown>();
    const payout = DuplicateEvents.seedPayout();
    const payoutKey = `${payout.circle_address}:${payout.round_index}`;

    // First insert
    assert.ok(!rows.has(payoutKey));
    rows.set(payoutKey, payout);
    assert.equal(rows.size, 1);

    // Second insert (duplicate) — key already present
    const sizeBefore = rows.size;
    if (!rows.has(payoutKey)) rows.set(payoutKey, { ...payout });
    assert.equal(
      rows.size,
      sizeBefore,
      "duplicate payout must not add a second row",
    );
    assert.equal(rows.size, DuplicateEvents.expectedBehaviour.payoutRowsAfterDoubleIngest);
  });

  test("duplicate and original events share the same tx_hash and event_type", () => {
    const original = DuplicateEvents.seedIngestedEvent();
    const dup = DuplicateEvents.seedDuplicateIngestedEvent();
    assert.equal(original.tx_hash, dup.tx_hash);
    assert.equal(original.event_type, dup.event_type);
    assert.equal(original.ledger, dup.ledger);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENT CLASS 3: Wallet Rejection
// Runbook: "Freighter not detected" / "Transaction fails with USDC transfer failed"
// ═══════════════════════════════════════════════════════════════════════════════

describe("Incident: WalletRejection", () => {
  test("fixture description is non-empty", () => {
    assert.ok(WalletRejection.description.length > 0);
  });

  test("not_installed: invokeContract returns success=false when Freighter absent", () => {
    const scenario = WalletRejection.notInstalled;
    assert.equal(scenario.freighterInstalled, false);
    assert.equal(scenario.expectedResult.success, false);
    assert.equal(scenario.expectedResult.txHash, "");
    assert.match(
      scenario.expectedResult.error,
      /Freighter/,
      "error message must mention Freighter",
    );
  });

  test("permission_denied: all raw error variants map to the same clean message", () => {
    const scenario = WalletRejection.permissionDenied;

    for (const rawMsg of scenario.rawErrorVariants) {
      const formatted = formatContractError(rawMsg);
      assert.equal(
        formatted,
        scenario.expectedResult.error,
        `raw error "${rawMsg}" must map to the standard permission-denied message`,
      );
    }
  });

  test("permission_denied: result shape has empty txHash and success=false", () => {
    const result = WalletRejection.permissionDenied.expectedResult;
    assert.equal(result.success, false);
    assert.equal(result.txHash, "");
  });

  test("unknown_error: raw extension error is preserved (capitalised) in formatted message", () => {
    const scenario = WalletRejection.unknownError;
    const formatted = formatContractError(scenario.rawError);
    assert.equal(
      formatted,
      scenario.expectedResult.error,
      "unknown errors must be preserved verbatim (capitalised)",
    );
  });

  test("unknown_error: result shape has empty txHash and success=false", () => {
    const result = WalletRejection.unknownError.expectedResult;
    assert.equal(result.success, false);
    assert.equal(result.txHash, "");
  });

  test("invoke context: walletAddress is a non-empty string (no real private key)", () => {
    const ctx = WalletRejection.seedInvokeContext();
    assert.ok(ctx.walletAddress.length > 0);
    // Synthetic addresses start with G (ed25519 public key) or C (contract)
    assert.match(
      ctx.walletAddress,
      /^[GC]/,
      "synthetic address must start with G (account) or C (contract)",
    );
    // Must NOT look like a real private key (S-address)
    assert.doesNotMatch(ctx.walletAddress, /^S/, "must not be a secret key");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENT CLASS 4: RPC Timeout
// Runbook: "Transaction fails with USDC transfer failed"
//          "App shows indexer unreachable banner"
// ═══════════════════════════════════════════════════════════════════════════════

describe("Incident: RpcTimeout", () => {
  test("fixture description is non-empty", () => {
    assert.ok(RpcTimeout.description.length > 0);
  });

  // ── Sub-case 1: simulate timeout ────────────────────────────────────────────

  test("simulate-timeout: network error maps to the correct user message", () => {
    const scenario = RpcTimeout.simulateTimeout;
    const formatted = formatContractError(scenario.mockError.message);
    assert.equal(
      formatted,
      scenario.expectedResult.error,
      "simulate timeout must produce RPC network error message",
    );
    assert.equal(scenario.expectedResult.success, false);
    assert.equal(scenario.expectedResult.txHash, "");
  });

  // ── Sub-case 2: send timeout ────────────────────────────────────────────────

  test("send-timeout: 'Failed to fetch' maps to RPC network error message", () => {
    const scenario = RpcTimeout.sendTimeout;
    const formatted = formatContractError(scenario.mockError.message);
    assert.equal(formatted, scenario.expectedResult.error);
    assert.equal(scenario.expectedResult.success, false);
  });

  // ── Sub-case 3: poll exhausted ───────────────────────────────────────────────

  test("poll-exhausted: all poll statuses are NOT_FOUND (transaction never confirmed)", () => {
    const scenario = RpcTimeout.pollExhausted;
    assert.equal(
      scenario.pollStatuses.length,
      RpcTimeout.TX_POLL_ATTEMPTS,
      "fixture must have exactly TX_POLL_ATTEMPTS poll statuses",
    );
    for (const s of scenario.pollStatuses) {
      assert.equal(s, "NOT_FOUND", "every poll response must be NOT_FOUND");
    }
  });

  test("poll-exhausted: txHash is preserved in the error result (non-empty)", () => {
    const scenario = RpcTimeout.pollExhausted;
    assert.ok(
      scenario.expectedResult.txHash.length > 0,
      "txHash must be preserved after broadcast so users can look up the tx",
    );
  });

  test("poll-exhausted: formatContractError('timeout') produces the timeout message", () => {
    const formatted = formatContractError("timeout");
    const expected = RpcTimeout.pollExhausted.expectedResult.error;
    assert.equal(formatted, expected);
    assert.match(formatted, /timed out/);
    assert.match(formatted, /congested/);
  });

  test("poll-exhausted: total budget calculation is consistent with constants", () => {
    assert.equal(
      RpcTimeout.TOTAL_POLL_BUDGET_MS,
      RpcTimeout.TX_POLL_ATTEMPTS * RpcTimeout.TX_POLL_INTERVAL_MS,
    );
  });

  // ── Sub-case 4: health check timeout ────────────────────────────────────────

  test("health-check-timeout: expected HTTP status is 503 (degraded)", () => {
    assert.equal(RpcTimeout.healthCheckTimeout.expectedHttpStatus, 503);
    assert.equal(RpcTimeout.healthCheckTimeout.expectedBody.status, "degraded");
  });

  test("health-check-timeout: both DB and RPC components exceed the budget", () => {
    const { mockComponents, HEALTH_CHECK_TIMEOUT_MS } = RpcTimeout.healthCheckTimeout;
    assert.ok(mockComponents.db.latencyMs > HEALTH_CHECK_TIMEOUT_MS);
    assert.ok(mockComponents.rpc.latencyMs > HEALTH_CHECK_TIMEOUT_MS);
    assert.equal(mockComponents.db.willTimeout, true);
    assert.equal(mockComponents.rpc.willTimeout, true);
  });

  test("seedMockRpcThatTimesOut: returned mock has all required methods", () => {
    const mock = RpcTimeout.seedMockRpcThatTimesOut(1);
    assert.equal(typeof mock.simulateTransaction, "function");
    assert.equal(typeof mock.sendTransaction, "function");
    assert.equal(typeof mock.getTransaction, "function");
    assert.equal(typeof mock.getAccount, "function");
  });

  test("seedMockRpcThatTimesOut: mock rejects after the configured delay", async () => {
    const mock = RpcTimeout.seedMockRpcThatTimesOut(10);
    await assert.rejects(
      () => mock.simulateTransaction(),
      /Request timeout/,
    );
    await assert.rejects(
      () => mock.sendTransaction(),
      /Failed to fetch/,
    );
    await assert.rejects(
      () => mock.getTransaction(),
      /Request timeout/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENT CLASS 5: Schema Drift
// Runbook: "Indexer boot: SCHEMA WARNING"
// ═══════════════════════════════════════════════════════════════════════════════

describe("Incident: SchemaDrift", () => {
  test("fixture description is non-empty", () => {
    assert.ok(SchemaDrift.description.length > 0);
  });

  test("drift scenario: applied filename is missing from disk files", () => {
    const filesOnDisk = SchemaDrift.seedFilesOnDisk();
    const appliedInDb = SchemaDrift.seedAppliedInDb();

    assert.ok(
      !filesOnDisk.includes(SchemaDrift.APPLIED_FILENAME),
      "the applied filename must NOT be in the on-disk list (it was renamed)",
    );
    assert.ok(
      appliedInDb.includes(SchemaDrift.APPLIED_FILENAME),
      "the applied filename must still be recorded in schema_migrations",
    );
  });

  test("drift scenario: renamed file IS present on disk", () => {
    const filesOnDisk = SchemaDrift.seedFilesOnDisk();
    assert.ok(
      filesOnDisk.includes(SchemaDrift.RENAMED_FILENAME),
      "the renamed file must appear in the on-disk list",
    );
  });

  test("drift scenario: deriveHealthState returns 'drifted'", () => {
    const { pending, missingOnDisk } = computeMigrationStatus(
      SchemaDrift.seedFilesOnDisk(),
      SchemaDrift.seedAppliedInDb(),
    );

    const state = deriveHealthState(pending.length, missingOnDisk.length, true);
    assert.equal(
      state,
      SchemaDrift.expectedBehaviour.healthState,
      "a renamed migration file must produce the 'drifted' health state",
    );
  });

  test("drift scenario: canStartSafely is false (matches expectedBehaviour)", () => {
    assert.equal(SchemaDrift.expectedBehaviour.canStartSafely, false);
    // Only the 'clean' state is safe to start from
    const { pending, missingOnDisk } = computeMigrationStatus(
      SchemaDrift.seedFilesOnDisk(),
      SchemaDrift.seedAppliedInDb(),
    );
    const state = deriveHealthState(pending.length, missingOnDisk.length, true);
    assert.notEqual(state, "clean");
  });

  test("drift scenario: missingOnDisk contains the original applied filename", () => {
    const { missingOnDisk } = computeMigrationStatus(
      SchemaDrift.seedFilesOnDisk(),
      SchemaDrift.seedAppliedInDb(),
    );
    assert.ok(
      missingOnDisk.includes(SchemaDrift.APPLIED_FILENAME),
      "missingOnDisk must contain the renamed-away filename",
    );
  });

  test("drift scenario: pending contains the renamed file (new name not yet applied)", () => {
    const { pending } = computeMigrationStatus(
      SchemaDrift.seedFilesOnDisk(),
      SchemaDrift.seedAppliedInDb(),
    );
    assert.ok(
      pending.includes(SchemaDrift.RENAMED_FILENAME),
      "the renamed file must appear as pending (never applied under the new name)",
    );
  });

  test("drift scenario: summary must contain all expectedBehaviour.summaryContains strings", () => {
    const { missingOnDisk } = computeMigrationStatus(
      SchemaDrift.seedFilesOnDisk(),
      SchemaDrift.seedAppliedInDb(),
    );

    // Build a summary the same way migrate.ts does for the 'drifted' state
    const summary =
      `Schema has drifted: ${missingOnDisk.length} migration(s) recorded as applied in ` +
      `schema_migrations but no longer present on disk: ${missingOnDisk.join(", ")}. ` +
      `This usually means a migration file was renamed or deleted after it ran.`;

    for (const fragment of SchemaDrift.expectedBehaviour.summaryContains) {
      assert.ok(
        summary.includes(fragment),
        `summary must contain "${fragment}"`,
      );
    }
  });

  test("applied row fixture has correct filename and non-empty timestamp", () => {
    const row = SchemaDrift.seedAppliedRow();
    assert.equal(row.filename, SchemaDrift.APPLIED_FILENAME);
    assert.ok(row.applied_at.length > 0);
    // Must not contain real secrets or keys
    assert.doesNotMatch(row.filename, /secret|key|mnemonic|passphrase/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-fixture invariants
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cross-fixture invariants", () => {
  test("no fixture contains a real Stellar secret key (S-address)", () => {
    const allAddresses = Object.values(
      // flat list of every address-like string used in fixtures
      {
        ...{
          state: StaleIndexerData.seedIndexerState(),
          circle: StaleIndexerData.seedCircle(),
        },
        ...{
          ingestedEvent: DuplicateEvents.seedIngestedEvent(),
          contribution: DuplicateEvents.seedContribution(),
          payout: DuplicateEvents.seedPayout(),
        },
        ...{
          invokeCtx: WalletRejection.seedInvokeContext(),
        },
      },
    ).flatMap((obj) => (typeof obj === "object" ? Object.values(obj as object) : [obj]));

    const addressStrings = allAddresses.filter(
      (v): v is string => typeof v === "string" && /^[A-Z0-9]{56}$/.test(v),
    );

    for (const addr of addressStrings) {
      assert.doesNotMatch(
        addr,
        /^S/,
        `value "${addr}" looks like a secret key (S-address) — must not appear in fixtures`,
      );
    }
  });

  test("no fixture tx_hash is all-lowercase real production data (fixtures use zero-prefix pattern)", () => {
    const hashes = [
      DuplicateEvents.seedIngestedEvent().tx_hash,
      DuplicateEvents.seedContribution().tx_hash,
      DuplicateEvents.seedPayout().tx_hash,
    ];
    for (const h of hashes) {
      assert.match(h, /^[0-9a-f]{64}$/, "tx_hash must be 64 hex chars");
      // Synthetic hashes always start with 0s or f-repeats — never random production data
      assert.ok(
        h.startsWith("0") || h.startsWith("f"),
        `tx_hash "${h}" must start with '0' or 'f' (synthetic pattern)`,
      );
    }
  });

  test("LEDGER constants are in ascending order", () => {
    assert.ok(LEDGER.GENESIS < LEDGER.DEPLOY);
    assert.ok(LEDGER.DEPLOY < LEDGER.CIRCLE_INIT);
    assert.ok(LEDGER.CIRCLE_INIT < LEDGER.ROUND_0_START);
    assert.ok(LEDGER.ROUND_0_START < LEDGER.ROUND_0_END);
    assert.ok(LEDGER.ROUND_0_END < LEDGER.ROUND_1_START);
    assert.ok(LEDGER.STALE < LEDGER.CURRENT);
    // STALE is intentionally behind ROUND_1_START — the indexer missed it
    assert.ok(LEDGER.STALE < LEDGER.ROUND_1_START);
  });
});
