/**
 * Sanitized cross-package incident fixtures.
 *
 * Every constant in this file is entirely synthetic:
 *  - Stellar addresses are valid base32 C-addresses whose underlying key is
 *    all-zeros (the well-known "burn" address pattern used in tests).
 *  - Transaction hashes are lowercase hex strings of the right length but
 *    carry no cryptographic meaning.
 *  - Ledger numbers are chosen so relative ordering is obvious (e.g.
 *    STALE_LEDGER < CURRENT_LEDGER).
 *  - No real private keys, mnemonics, or production secrets appear anywhere.
 *
 * Fixture classes (one exported namespace each):
 *
 *  | Class | File section | Incident description |
 *  |---|---|---|
 *  | STALE_DATA | StaleIndexerData | Indexer cursor freezes; data is >2 rounds behind |
 *  | DUPLICATE_EVENTS | DuplicateEvents | Same (tx_hash, event_index) ingested twice |
 *  | WALLET_REJECTION | WalletRejection | Freighter refuses: not installed, permission denied, unknown |
 *  | RPC_TIMEOUT | RpcTimeout | Soroban RPC simulate/send/poll timeouts |
 *  | SCHEMA_DRIFT | SchemaDrift | Migration file renamed after apply; ghost entry in schema_migrations |
 *
 * Usage in tests:
 *
 *   import { StaleIndexerData, DuplicateEvents } from "../fixtures/incident-fixtures";
 *
 * Each namespace exports:
 *  - `description`: human-readable incident class summary
 *  - `seed<X>()`: factory that returns a fresh copy of the fixture value
 *    (never mutate the returned object — call seed() again for each test)
 *  - `expectedBehaviour`: what the correct system response is (for assertions)
 *
 * Runbook links: docs/RUNBOOK.md
 *   - StaleIndexerData  → "Circle list is empty but circles exist on-chain"
 *   - DuplicateEvents   → "Circle list is empty but circles exist on-chain" (dedup invariant)
 *   - WalletRejection   → "Freighter not detected" / "Transaction fails with USDC transfer failed"
 *   - RpcTimeout        → "Transaction fails with USDC transfer failed" / "App shows indexer unreachable banner"
 *   - SchemaDrift       → "Indexer boot: SCHEMA WARNING"
 */

// ─── Deterministic synthetic addresses ───────────────────────────────────────
//
// These are generated from all-zero byte arrays encoded in Stellar's strkey
// format (C-contract addresses).  They are safe to embed in test fixtures
// because the corresponding private key is unknown / unspendable.

export const SYNTHETIC_ADDRESSES = {
  FACTORY:     "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  REPUTATION:  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  USDC:        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2K",
  CIRCLE_A:    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFXCU",
  CIRCLE_B:    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK7CE",
  MEMBER_ALICE: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  MEMBER_BOB:   "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPCIB",
  MEMBER_CAROL: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABMHIT",
  MEMBER_DAVE:  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQITI",
} as const;

/** Deterministic fake tx hashes (64 hex chars, all-zero prefix for clarity). */
export const SYNTHETIC_TX_HASHES = {
  ROUND0_PAYOUT:      "0000000000000000000000000000000000000000000000000000000000000001",
  ROUND1_PAYOUT:      "0000000000000000000000000000000000000000000000000000000000000002",
  ALICE_CONTRIBUTE_0: "0000000000000000000000000000000000000000000000000000000000000010",
  BOB_CONTRIBUTE_0:   "0000000000000000000000000000000000000000000000000000000000000011",
  CAROL_CONTRIBUTE_0: "0000000000000000000000000000000000000000000000000000000000000012",
  DAVE_CONTRIBUTE_0:  "0000000000000000000000000000000000000000000000000000000000000013",
  ALICE_DEFAULT_1:    "0000000000000000000000000000000000000000000000000000000000000020",
  DUPLICATE_HASH:     "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
} as const;

/** Synthetic ledger numbers with obvious relative ordering. */
export const LEDGER = {
  GENESIS:      1_000_000,
  DEPLOY:       1_100_000,
  CIRCLE_INIT:  1_100_100,
  ROUND_0_START:1_100_200,
  ROUND_0_END:  1_220_200, // ROUND_0_START + MIN_ROUND_DEADLINE_LEDGERS (100 in test env) + some
  ROUND_1_START:1_220_201,
  STALE:        1_220_000, // indexer froze here — behind round 1
  CURRENT:      1_280_000, // actual chain tip
} as const;

// ─── StaleIndexerData ─────────────────────────────────────────────────────────

/**
 * Incident: indexer cursor froze while the chain advanced.
 *
 * The indexer's `last_ledger` shows STALE (1_220_000) while the RPC tip is
 * CURRENT (1_280_000).  Round 1 has been paid out on-chain but the indexer
 * still reports `current_round = 0`.
 *
 * Runbook: "Circle list is empty but circles exist on-chain" and
 *          "Circle detail page shows 404"
 */
export namespace StaleIndexerData {
  export const description =
    "Indexer cursor frozen: last_ledger=1220000, chain tip=1280000. " +
    "Round 1 payout on-chain but indexer still shows current_round=0.";

  export const expectedBehaviour = {
    apiCircleStatus: "Active",         // stale — should be Completed
    apiCurrentRound: 0,                // stale — should be 1 or terminal
    apiLastLedger: LEDGER.STALE,
    rpcLastLedger: LEDGER.CURRENT,
    lagLedgers: LEDGER.CURRENT - LEDGER.STALE, // 60_000 ledgers ≈ 83h
    appBannerShown: true,              // UI should show "indexer may be stale"
  };

  export interface IndexerStateRow {
    id: number;
    last_ledger: number;
    updated_at: string;
  }

  export interface CircleRow {
    address: string;
    creator: string;
    round_amount: string;
    member_count: number;
    status: string;
    current_round: number;
    total_rounds: number;
    created_ledger: number;
    round_deadline_ledgers: number;
    updated_at: string;
  }

  export function seedIndexerState(): IndexerStateRow {
    return {
      id: 1,
      last_ledger: LEDGER.STALE,
      updated_at: "2026-08-01T00:00:00.000Z",
    };
  }

  export function seedCircle(): CircleRow {
    return {
      address: SYNTHETIC_ADDRESSES.CIRCLE_A,
      creator: SYNTHETIC_ADDRESSES.MEMBER_ALICE,
      round_amount: "100000000", // 10 USDC in stroops
      member_count: 4,
      status: "Active",          // stale — on-chain it is Completed
      current_round: 0,          // stale — on-chain round 1 was paid out
      total_rounds: 4,
      created_ledger: LEDGER.CIRCLE_INIT,
      round_deadline_ledgers: 120_960, // ~7 days
      updated_at: "2026-08-01T00:00:00.000Z",
    };
  }

  /** The actual on-chain state — used to verify the lag between DB and chain. */
  export function seedOnChainState() {
    return {
      status: "Completed",
      currentRound: 4, // all rounds done
      roundsCompleted: 4,
      latestLedger: LEDGER.CURRENT,
    };
  }
}

// ─── DuplicateEvents ──────────────────────────────────────────────────────────

/**
 * Incident: the same Soroban event is delivered twice by the RPC and the
 * indexer processes it both times, doubling contribution and payout rows.
 *
 * The `ingested_events` dedup table (keyed on event_key = tx_hash+event_index)
 * is the guard.  These fixtures produce the exact `event_key` values an
 * honest second poll would generate and verify that the upsert/dedup path
 * is exercised.
 *
 * Runbook: "Circle list is empty but circles exist on-chain" (dedup invariant)
 */
export namespace DuplicateEvents {
  export const description =
    "Same event (tx_hash=fff…, event_index=0) ingested twice. " +
    "Dedup table must prevent duplicate contribution/payout rows.";

  export const expectedBehaviour = {
    contributionRowsAfterDoubleIngest: 1,  // guard: exactly one row per (circle, member, round)
    payoutRowsAfterDoubleIngest: 1,
    ingestedEventsRows: 1,                  // event_key is PRIMARY KEY → second upsert is no-op
  };

  export interface IngestedEventRow {
    event_key: string;   // "${tx_hash}:${event_index}"
    contract_id: string;
    ledger: number;
    tx_hash: string;
    event_type: string;
    created_at: string;
  }

  export interface ContributionRow {
    circle_address: string;
    member_address: string;
    round_index: number;
    amount: string;
    tx_hash: string;
    ledger: number;
    created_at: string;
  }

  export interface PayoutRow {
    circle_address: string;
    recipient: string;
    round_index: number;
    amount: string;
    tx_hash: string;
    ledger: number;
    created_at: string;
  }

  /** The event_key format used by the ingested_events dedup table. */
  export function eventKey(txHash: string, eventIndex: number): string {
    return `${txHash}:${eventIndex}`;
  }

  export function seedIngestedEvent(): IngestedEventRow {
    return {
      event_key: eventKey(SYNTHETIC_TX_HASHES.DUPLICATE_HASH, 0),
      contract_id: SYNTHETIC_ADDRESSES.CIRCLE_A,
      ledger: LEDGER.ROUND_0_END,
      tx_hash: SYNTHETIC_TX_HASHES.DUPLICATE_HASH,
      event_type: "circle/payout",
      created_at: "2026-08-10T12:00:00.000Z",
    };
  }

  export function seedContribution(): ContributionRow {
    return {
      circle_address: SYNTHETIC_ADDRESSES.CIRCLE_A,
      member_address: SYNTHETIC_ADDRESSES.MEMBER_ALICE,
      round_index: 0,
      amount: "100000000",
      tx_hash: SYNTHETIC_TX_HASHES.ALICE_CONTRIBUTE_0,
      ledger: LEDGER.ROUND_0_END,
      created_at: "2026-08-10T12:00:00.000Z",
    };
  }

  export function seedPayout(): PayoutRow {
    return {
      circle_address: SYNTHETIC_ADDRESSES.CIRCLE_A,
      recipient: SYNTHETIC_ADDRESSES.MEMBER_ALICE,
      round_index: 0,
      amount: "400000000", // 4 × 10 USDC in stroops
      tx_hash: SYNTHETIC_TX_HASHES.ROUND0_PAYOUT,
      ledger: LEDGER.ROUND_0_END,
      created_at: "2026-08-10T12:01:00.000Z",
    };
  }

  /**
   * Simulate a second delivery of the same event with identical fields.
   * An idempotent indexer must treat this as a no-op.
   */
  export function seedDuplicateIngestedEvent(): IngestedEventRow {
    return { ...seedIngestedEvent() }; // same event_key → PRIMARY KEY conflict
  }
}

// ─── WalletRejection ──────────────────────────────────────────────────────────

/**
 * Incident: Freighter wallet produces an error instead of a signed XDR.
 *
 * Three sub-cases map to the three WalletErrorReason values in stellar.ts:
 *  1. `not_installed`    — window.freighter is undefined
 *  2. `permission_denied` — user dismisses the signing prompt
 *  3. `unknown`          — extension throws an unrecognised error
 *
 * Runbook: "Freighter not detected" / "Transaction fails with USDC transfer failed"
 */
export namespace WalletRejection {
  export const description =
    "Freighter wallet rejection across three sub-cases: " +
    "not_installed, permission_denied, unknown.";

  // ── Sub-case 1: extension not installed ───────────────────────────────────

  export const notInstalled = {
    reason: "not_installed" as const,
    /** invokeContract must return this shape, not throw. */
    expectedResult: {
      txHash: "",
      success: false,
      error: "Freighter wallet extension is not installed.",
    },
    /** What isFreighterInstalled() returns in this scenario. */
    freighterInstalled: false,
  };

  // ── Sub-case 2: user dismissed the prompt ─────────────────────────────────

  export const permissionDenied = {
    reason: "permission_denied" as const,
    /**
     * Raw error messages that signTransaction() may throw when the user
     * dismisses the prompt.  All of these must map to the same clean message.
     */
    rawErrorVariants: [
      "User denied",
      "User rejected",
      "Transaction was cancelled",
      "Request canceled by user",
    ],
    expectedResult: {
      txHash: "",
      success: false,
      error: "You cancelled the transaction in Freighter. No funds were moved.",
    },
  };

  // ── Sub-case 3: unknown extension error ───────────────────────────────────

  export const unknownError = {
    reason: "unknown" as const,
    rawError: "Extension context invalidated.",
    expectedResult: {
      txHash: "",
      success: false,
      // formatContractError preserves the raw message, capitalised
      error: "Extension context invalidated.",
    },
  };

  /**
   * A fully populated fake invocation context.
   * walletAddress is a valid-format G-address (not a real funded account).
   */
  export function seedInvokeContext() {
    return {
      contractId: SYNTHETIC_ADDRESSES.CIRCLE_A,
      method: "contribute",
      walletAddress: SYNTHETIC_ADDRESSES.MEMBER_ALICE,
    };
  }
}

// ─── RpcTimeout ───────────────────────────────────────────────────────────────

/**
 * Incident: Soroban RPC does not respond within the configured timeout.
 *
 * Three sub-cases cover the full round-trip in invokeContract():
 *  1. simulateTransaction times out (before broadcast)
 *  2. sendTransaction times out (after signing, before confirmation)
 *  3. getTransaction polling exhausts all attempts (after broadcast)
 *
 * For the health endpoint, a fourth sub-case covers the DB or RPC latency
 * check exceeding HEALTH_CHECK_TIMEOUT_MS (5 000 ms).
 *
 * Runbook: "Transaction fails with USDC transfer failed"
 *          "App shows indexer unreachable banner"
 */
export namespace RpcTimeout {
  export const description =
    "Soroban RPC timeout across three sub-cases: simulate, send, poll-exhaust.";

  export const TX_POLL_ATTEMPTS = 30;
  export const TX_POLL_INTERVAL_MS = 2_000;
  /** Total ms the polling loop waits before giving up. */
  export const TOTAL_POLL_BUDGET_MS = TX_POLL_ATTEMPTS * TX_POLL_INTERVAL_MS; // 60_000 ms

  /** HTTP status code returned by a timed-out RPC node. */
  export const HTTP_TIMEOUT_STATUS = 504;

  // ── Sub-case 1: simulate times out ────────────────────────────────────────

  export const simulateTimeout = {
    phase: "simulate" as const,
    mockError: new Error("Request timeout"),
    expectedResult: {
      txHash: "",
      success: false,
      error: "A network error occurred while communicating with the Stellar RPC.",
    },
  };

  // ── Sub-case 2: send times out ────────────────────────────────────────────

  export const sendTimeout = {
    phase: "send" as const,
    mockError: new Error("Failed to fetch"),
    expectedResult: {
      txHash: "",
      success: false,
      error: "A network error occurred while communicating with the Stellar RPC.",
    },
  };

  // ── Sub-case 3: polling exhausts all attempts ─────────────────────────────

  export const pollExhausted = {
    phase: "poll" as const,
    /** Hash returned by sendTransaction before polling starts. */
    txHash: SYNTHETIC_TX_HASHES.ROUND0_PAYOUT,
    /** Statuses returned on each poll — all NOT_FOUND (transaction pending). */
    pollStatuses: Array<string>(TX_POLL_ATTEMPTS).fill("NOT_FOUND"),
    expectedResult: {
      txHash: SYNTHETIC_TX_HASHES.ROUND0_PAYOUT,
      success: false,
      error:
        `The transaction was submitted but confirmation timed out after ` +
        `${Math.round(TOTAL_POLL_BUDGET_MS / 1000)}s. The network may be congested.`,
    },
  };

  // ── Sub-case 4: health endpoint — component timeout ───────────────────────

  export const healthCheckTimeout = {
    phase: "health" as const,
    HEALTH_CHECK_TIMEOUT_MS: 5_000,
    /** Both DB and RPC exceed the budget. */
    mockComponents: {
      db:  { latencyMs: 6_000, willTimeout: true },
      rpc: { latencyMs: 7_000, willTimeout: true },
    },
    expectedHttpStatus: 503,
    expectedBody: {
      status: "degraded",
    },
  };

  /**
   * Produce a mock RPC object that rejects every call after `delayMs`.
   * Use in unit tests that inject the rpc dependency.
   */
  export function seedMockRpcThatTimesOut(delayMs: number) {
    return {
      simulateTransaction: () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), delayMs),
        ),
      sendTransaction: () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Failed to fetch")), delayMs),
        ),
      getTransaction: () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), delayMs),
        ),
      getAccount: () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), delayMs),
        ),
    };
  }
}

// ─── SchemaDrift ──────────────────────────────────────────────────────────────

/**
 * Incident: a migration file was renamed (or deleted) after it was applied.
 * The schema_migrations table still records the old filename, but the file is
 * no longer on disk, producing a "drifted" health state.
 *
 * Runbook: "Indexer boot: SCHEMA WARNING"
 */
export namespace SchemaDrift {
  export const description =
    "Migration 001_add_round_deadline_ledgers.sql renamed after apply. " +
    "schema_migrations records old name; file on disk has new name. " +
    "Expected health state: drifted.";

  /** The original filename as recorded in schema_migrations. */
  export const APPLIED_FILENAME = "001_add_round_deadline_ledgers.sql";

  /** The renamed file present on disk (simulating a developer renaming it). */
  export const RENAMED_FILENAME = "001_add_round_deadline_ledgers_renamed.sql";

  export const expectedBehaviour = {
    healthState: "drifted" as const,
    canStartSafely: false,
    summaryContains: ["drifted", APPLIED_FILENAME, "renamed or deleted"],
  };

  export interface SchemaMigrationsRow {
    filename: string;
    applied_at: string;
  }

  export function seedAppliedRow(): SchemaMigrationsRow {
    return {
      filename: APPLIED_FILENAME,
      applied_at: "2026-07-01T00:00:00.000Z",
    };
  }

  /**
   * Files that would be found on disk in this scenario:
   * original name is gone; renamed version and one newer file present.
   */
  export function seedFilesOnDisk(): string[] {
    return [RENAMED_FILENAME, "002_ledger_checkpoints.sql"];
  }

  /**
   * Files recorded as applied in schema_migrations in this scenario:
   * only the original (now-missing) filename.
   */
  export function seedAppliedInDb(): string[] {
    return [APPLIED_FILENAME];
  }
}

// ─── Full incident manifest ───────────────────────────────────────────────────

/** All incident classes for enumeration in reporting/CI scripts. */
export const INCIDENT_CLASSES = [
  "StaleIndexerData",
  "DuplicateEvents",
  "WalletRejection",
  "RpcTimeout",
  "SchemaDrift",
] as const;

export type IncidentClass = (typeof INCIDENT_CLASSES)[number];
