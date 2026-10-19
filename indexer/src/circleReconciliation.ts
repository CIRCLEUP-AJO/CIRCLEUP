/**
 * Per-circle reconciliation diagnostic (Issue #688).
 *
 * The indexer is a derived read model: it can lag the chain, or drift from it
 * when an event was skipped or mis-projected.  This module compares a fixed,
 * bounded set of indexed fields for ONE circle with the circle contract's own
 * views and reports every difference with its source and ledger context.  It
 * never writes to Postgres — repairs remain an explicit operator decision
 * (see src/db/reconcile.ts --repair or a replay).
 *
 * Field mapping (indexed → contract view):
 *
 *   circle_members (ORDER BY payout_order)  → get_config().members (rotation order)
 *   circles.round_amount                    → get_config().round_amount
 *   circles.member_count                    → get_config().members.length
 *   circles.status                          → get_status(), plus is_closed() for the
 *                                             indexer-only 'Closed' status (derivation
 *                                             rule: Closed ⇔ is_closed() and
 *                                             get_status() ∈ {Completed, Cancelled})
 *   circles.paused                          → is_paused()
 *   circles.current_round                   → get_current_round().round_index
 *                                             (Pending/Active only — the view errors by
 *                                             design for Completed/Cancelled circles)
 *   payouts (count)                         → rounds paid so far, derived from status +
 *                                             current round (no per-round payout view)
 *   payouts.recipient (per round)           → get_config().members[round_index]
 *   payouts.amount (non-exceptional rounds) → round_amount × member_count
 *
 * Outcomes are kept distinct so operators can tell why a check did not pass:
 *
 *   match                 every compared field agrees
 *   mismatch              chain was read and at least one field differs; each
 *                         mismatch is classified `possibly_stale` (the indexer
 *                         cursor is behind the chain ledger the read was taken
 *                         at) or `drift` (the indexer is caught up, so the
 *                         difference will not resolve by waiting)
 *   rpc_unavailable       the RPC could not be reached / timed out — NOT drift
 *   incompatible_contract the address answered but is not a CircleUp circle
 *                         (missing views, unexpected return shapes)
 *   not_indexed           the circle has no row in the indexer
 *
 * Bounds: one circle per run, at most 5 contract simulations (no per-member
 * reads), and member/payout rows capped at MAX_RECONCILE_ROWS (the contract's
 * own member limit is 256).
 */

import {
  Account,
  Contract,
  SorobanRpc,
  StrKey,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Upper bound on member and payout rows read for one circle. */
export const MAX_RECONCILE_ROWS = 512;

const DEFAULT_READ_TIMEOUT_MS = 5_000;

/**
 * Well-known all-zero account used as the source of read-only simulations —
 * simulation never checks the source's sequence or signature, so no real
 * account (or key) is needed.
 */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChainReadFailure = "rpc_unavailable" | "contract_error";

export type ChainReadResult =
  | { ok: true; value: unknown }
  | { ok: false; failure: ChainReadFailure; error: string };

/** Read-only access to the chain.  Injected so tests need no RPC. */
export interface ChainReader {
  /** Latest ledger the RPC has closed. Throws when the RPC is unreachable. */
  latestLedger(): Promise<number>;
  /** Simulate a read-only contract call. Never submits a transaction. */
  call(contractId: string, method: string): Promise<ChainReadResult>;
}

export interface IndexedCircle {
  address: string;
  status: string;
  current_round: number;
  member_count: number;
  round_amount: string;
  paused: boolean | null;
}

export interface IndexedMember {
  member_address: string;
  payout_order: number;
}

export interface IndexedPayout {
  round_index: number;
  recipient: string;
  amount: string;
  is_exceptional: boolean | null;
  ledger: string;
  tx_hash: string;
}

/** Read-only access to the indexed projection.  Injected so tests need no DB. */
export interface IndexedCircleSource {
  indexedLedger(): Promise<number>;
  circle(address: string): Promise<IndexedCircle | null>;
  members(address: string, limit: number): Promise<IndexedMember[]>;
  payouts(address: string, limit: number): Promise<IndexedPayout[]>;
}

export type ReconcileField =
  | "member_order"
  | "member_count"
  | "round_amount"
  | "status"
  | "paused"
  | "current_round"
  | "payout_count"
  | "payout_recipient"
  | "payout_amount";

export interface CircleMismatch {
  field: ReconcileField;
  /** Row qualifier, e.g. "payout_order=2" or "round=1". */
  key?: string;
  indexed: string | null;
  chain: string | null;
  /** Contract view(s) the chain value came from. */
  source: string;
  /** Indexed row's ledger, when the row carries one (payouts). */
  indexedRowLedger?: number;
  classification: "possibly_stale" | "drift";
}

export interface UnavailableRead {
  source: string;
  failure: ChainReadFailure;
  error: string;
}

export type CircleReconcileOutcome =
  | "match"
  | "mismatch"
  | "rpc_unavailable"
  | "incompatible_contract"
  | "not_indexed";

export interface CircleReconciliationReport {
  circleAddress: string;
  generatedAt: string;
  outcome: CircleReconcileOutcome;
  ledgerContext: {
    /** indexer_state.last_ledger when the report ran. */
    indexedLedger: number | null;
    /** RPC latest ledger the chain reads were taken against. */
    chainLedger: number | null;
    /** chainLedger − indexedLedger (null when either is unknown). */
    lagLedgers: number | null;
  };
  /** Fields that were actually compared. */
  checked: ReconcileField[];
  mismatches: CircleMismatch[];
  unavailable: UnavailableRead[];
  /** Set when a bound truncated the indexed rows read. */
  truncated?: boolean;
}

// ─── Address validation ──────────────────────────────────────────────────────

/** True for a checksummed Soroban contract address (C…). */
export function isValidCircleAddress(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidContract(address);
}

// ─── Decoding helpers ────────────────────────────────────────────────────────

/** A unit-variant contracttype enum decodes as ["Variant"]; accept both forms. */
function decodeEnumVariant(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

const CHAIN_STATUSES = new Set(["Pending", "Active", "Completed", "Cancelled"]);

// ─── Core comparison ─────────────────────────────────────────────────────────

/**
 * Reconcile one circle.  Read-only: issues only SELECTs (through `source`)
 * and simulations (through `reader`).
 */
export async function reconcileCircle(
  circleAddress: string,
  deps: { reader: ChainReader; source: IndexedCircleSource; now?: () => Date },
): Promise<CircleReconciliationReport> {
  const { reader, source } = deps;
  const now = deps.now ?? (() => new Date());

  if (!isValidCircleAddress(circleAddress)) {
    throw new Error("circle address must be a valid Soroban contract address (C…)");
  }

  const report: CircleReconciliationReport = {
    circleAddress,
    generatedAt: now().toISOString(),
    outcome: "match",
    ledgerContext: { indexedLedger: null, chainLedger: null, lagLedgers: null },
    checked: [],
    mismatches: [],
    unavailable: [],
  };

  const circle = await source.circle(circleAddress);
  report.ledgerContext.indexedLedger = await source.indexedLedger();
  if (!circle) {
    report.outcome = "not_indexed";
    return report;
  }

  // Chain ledger first: an unreachable RPC is reported as such, never as drift.
  try {
    report.ledgerContext.chainLedger = await reader.latestLedger();
  } catch (err) {
    report.unavailable.push({
      source: "getLatestLedger",
      failure: "rpc_unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    report.outcome = "rpc_unavailable";
    return report;
  }
  const { indexedLedger, chainLedger } = report.ledgerContext;
  report.ledgerContext.lagLedgers =
    indexedLedger !== null && chainLedger !== null ? chainLedger - indexedLedger : null;
  const classification: CircleMismatch["classification"] =
    (report.ledgerContext.lagLedgers ?? 0) > 0 ? "possibly_stale" : "drift";

  const mismatch = (m: Omit<CircleMismatch, "classification">) =>
    report.mismatches.push({ ...m, classification });

  const [configRead, statusRead, pausedRead, closedRead] = await Promise.all([
    reader.call(circleAddress, "get_config"),
    reader.call(circleAddress, "get_status"),
    reader.call(circleAddress, "is_paused"),
    reader.call(circleAddress, "is_closed"),
  ]);
  const reads: Array<[string, ChainReadResult]> = [
    ["get_config", configRead],
    ["get_status", statusRead],
    ["is_paused", pausedRead],
    ["is_closed", closedRead],
  ];
  for (const [name, r] of reads) {
    if (!r.ok) report.unavailable.push({ source: name, failure: r.failure, error: r.error });
  }
  if (reads.some(([, r]) => !r.ok && r.failure === "rpc_unavailable")) {
    report.outcome = "rpc_unavailable";
    return report;
  }

  // ── Contract shape: is this actually a CircleUp circle? ──────────────────
  const config =
    configRead.ok && configRead.value && typeof configRead.value === "object"
      ? (configRead.value as { members?: unknown; round_amount?: unknown })
      : null;
  const rotation =
    config && Array.isArray(config.members) && config.members.every((m) => typeof m === "string")
      ? (config.members as string[])
      : null;
  const chainRoundAmount = config ? toBigInt(config.round_amount) : null;
  const chainStatus = statusRead.ok ? decodeEnumVariant(statusRead.value) : null;
  const chainPaused = pausedRead.ok && typeof pausedRead.value === "boolean" ? pausedRead.value : null;
  const chainClosed = closedRead.ok && typeof closedRead.value === "boolean" ? closedRead.value : null;

  if (
    !rotation ||
    chainRoundAmount === null ||
    !chainStatus ||
    !CHAIN_STATUSES.has(chainStatus) ||
    chainPaused === null ||
    chainClosed === null
  ) {
    if (report.unavailable.length === 0) {
      report.unavailable.push({
        source: "get_config/get_status/is_paused/is_closed",
        failure: "contract_error",
        error: "contract returned values that do not match the CircleUp circle interface",
      });
    }
    report.outcome = "incompatible_contract";
    return report;
  }

  // ── Member order ─────────────────────────────────────────────────────────
  const members = await source.members(circleAddress, MAX_RECONCILE_ROWS);
  const payouts = await source.payouts(circleAddress, MAX_RECONCILE_ROWS);
  if (members.length >= MAX_RECONCILE_ROWS || payouts.length >= MAX_RECONCILE_ROWS) {
    report.truncated = true;
  }

  report.checked.push("member_order", "member_count", "round_amount");
  const slots = Math.max(rotation.length, members.length);
  const byOrder = new Map(members.map((m) => [m.payout_order, m.member_address]));
  for (let i = 0; i < slots; i++) {
    const indexed = byOrder.get(i) ?? null;
    const chain = rotation[i] ?? null;
    if (indexed !== chain) {
      mismatch({ field: "member_order", key: `payout_order=${i}`, indexed, chain, source: "get_config.members" });
    }
  }
  if (circle.member_count !== rotation.length) {
    mismatch({
      field: "member_count",
      indexed: String(circle.member_count),
      chain: String(rotation.length),
      source: "get_config.members",
    });
  }
  if (toBigInt(circle.round_amount) !== chainRoundAmount) {
    mismatch({
      field: "round_amount",
      indexed: circle.round_amount,
      chain: chainRoundAmount.toString(),
      source: "get_config.round_amount",
    });
  }

  // ── Status (with the indexer-only Closed derivation) ─────────────────────
  report.checked.push("status", "paused");
  const statusMatches =
    circle.status === "Closed"
      ? chainClosed && (chainStatus === "Completed" || chainStatus === "Cancelled")
      : !chainClosed && circle.status === chainStatus;
  if (!statusMatches) {
    mismatch({
      field: "status",
      indexed: circle.status,
      chain: chainClosed ? `${chainStatus} (closed)` : chainStatus,
      source: "get_status+is_closed",
    });
  }
  if (circle.paused !== null && circle.paused !== chainPaused) {
    mismatch({
      field: "paused",
      indexed: String(circle.paused),
      chain: String(chainPaused),
      source: "is_paused",
    });
  }

  // ── Current round ────────────────────────────────────────────────────────
  let chainRoundIndex: number | null = null;
  if (chainStatus === "Pending" || chainStatus === "Active") {
    const roundRead = await reader.call(circleAddress, "get_current_round");
    if (!roundRead.ok) {
      report.unavailable.push({ source: "get_current_round", failure: roundRead.failure, error: roundRead.error });
      if (roundRead.failure === "rpc_unavailable") {
        report.outcome = "rpc_unavailable";
        return report;
      }
    } else {
      const round = roundRead.value as { round_index?: unknown } | null;
      if (round && typeof round.round_index === "number") {
        chainRoundIndex = round.round_index;
        report.checked.push("current_round");
        if (circle.current_round !== chainRoundIndex) {
          mismatch({
            field: "current_round",
            indexed: String(circle.current_round),
            chain: String(chainRoundIndex),
            source: "get_current_round.round_index",
          });
        }
      } else {
        report.unavailable.push({
          source: "get_current_round",
          failure: "contract_error",
          error: "get_current_round returned an unexpected shape",
        });
      }
    }
  }

  // ── Payout records ───────────────────────────────────────────────────────
  // Rounds paid so far: every round before the current one (Pending/Active),
  // all rounds (Completed), or none (Cancelled — only reachable from Pending).
  const expectedPayouts =
    chainStatus === "Completed"
      ? rotation.length
      : chainStatus === "Cancelled"
        ? 0
        : chainRoundIndex;
  if (expectedPayouts !== null) {
    report.checked.push("payout_count");
    if (payouts.length !== expectedPayouts) {
      mismatch({
        field: "payout_count",
        indexed: String(payouts.length),
        chain: String(expectedPayouts),
        source: chainStatus === "Active" || chainStatus === "Pending" ? "get_current_round.round_index" : "get_status",
      });
    }
  }

  report.checked.push("payout_recipient", "payout_amount");
  const fullPot = chainRoundAmount * BigInt(rotation.length);
  for (const p of payouts) {
    const ledger = Number(p.ledger);
    const expectedRecipient = rotation[p.round_index] ?? null;
    if (p.recipient !== expectedRecipient) {
      mismatch({
        field: "payout_recipient",
        key: `round=${p.round_index}`,
        indexed: p.recipient,
        chain: expectedRecipient,
        source: "get_config.members[round_index]",
        indexedRowLedger: ledger,
      });
    }
    if (!p.is_exceptional && toBigInt(p.amount) !== fullPot) {
      mismatch({
        field: "payout_amount",
        key: `round=${p.round_index}`,
        indexed: p.amount,
        chain: fullPot.toString(),
        source: "get_config.round_amount × members.length",
        indexedRowLedger: ledger,
      });
    }
  }

  report.outcome = report.mismatches.length > 0 ? "mismatch" : "match";
  return report;
}

// ─── Default (live) dependencies ─────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * ChainReader backed by a Soroban RPC server.  Transport failures (thrown
 * errors, timeouts) become `rpc_unavailable`; a simulation that ran but
 * failed (missing function, contract trap, no such contract) becomes
 * `contract_error`.
 */
export function createRpcChainReader(
  server: Pick<SorobanRpc.Server, "getLatestLedger" | "getNetwork" | "simulateTransaction">,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
): ChainReader {
  // Cached after the first successful lookup; a failed lookup is retried.
  let passphrase: Promise<string> | null = null;
  const networkPassphrase = (): Promise<string> => {
    if (!passphrase) {
      const pending = withTimeout(server.getNetwork(), timeoutMs).then((n) => n.passphrase);
      pending.catch(() => {
        if (passphrase === pending) passphrase = null;
      });
      passphrase = pending;
    }
    return passphrase;
  };

  return {
    async latestLedger() {
      const latest = await withTimeout(server.getLatestLedger(), timeoutMs);
      return latest.sequence;
    },
    async call(contractId, method) {
      let sim: SorobanRpc.Api.SimulateTransactionResponse;
      try {
        const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
          fee: "100",
          networkPassphrase: await networkPassphrase(),
        })
          .addOperation(new Contract(contractId).call(method))
          .setTimeout(30)
          .build();
        sim = await withTimeout(server.simulateTransaction(tx), timeoutMs);
      } catch (err) {
        return { ok: false, failure: "rpc_unavailable", error: err instanceof Error ? err.message : String(err) };
      }

      if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
        const error = SorobanRpc.Api.isSimulationError(sim) ? sim.error : `${method} returned no result`;
        return { ok: false, failure: "contract_error", error };
      }
      try {
        return { ok: true, value: scValToNative(sim.result.retval as xdr.ScVal) };
      } catch {
        return { ok: false, failure: "contract_error", error: `could not decode ${method} result` };
      }
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryFn = <T extends Record<string, any>>(text: string, params?: unknown[]) => Promise<T[]>;

/** IndexedCircleSource backed by Postgres — SELECT-only. */
export function createDbCircleSource(query: QueryFn): IndexedCircleSource {
  return {
    async indexedLedger() {
      const [row] = await query<{ last_ledger: string }>(
        "SELECT last_ledger FROM indexer_state WHERE id = 1",
      );
      return row ? Number(row.last_ledger) : 0;
    },
    async circle(address) {
      const [row] = await query<IndexedCircle>(
        `SELECT address, status, current_round, member_count, round_amount::text AS round_amount,
                paused
           FROM circles WHERE address = $1`,
        [address],
      );
      return row ?? null;
    },
    members(address, limit) {
      return query<IndexedMember>(
        `SELECT member_address, payout_order
           FROM circle_members WHERE circle_address = $1
          ORDER BY payout_order ASC, member_address ASC
          LIMIT $2`,
        [address, limit],
      );
    },
    payouts(address, limit) {
      return query<IndexedPayout>(
        `SELECT round_index, recipient, amount::text AS amount, is_exceptional,
                ledger::text AS ledger, tx_hash
           FROM payouts WHERE circle_address = $1
          ORDER BY round_index ASC
          LIMIT $2`,
        [address, limit],
      );
    },
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
//
//   npm run reconcile:circle --workspace=indexer -- <circle-address> [--json]
//
// Exit codes: 0 match, 1 mismatch, 2 rpc_unavailable / incompatible_contract /
// not_indexed, 64 usage error.

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const address = args.find((a) => !a.startsWith("--"));
    const json = args.includes("--json");
    if (!isValidCircleAddress(address)) {
      console.error("[reconcile:circle] Usage: reconcile:circle <circle-address C…> [--json]");
      process.exit(64);
    }

    const { query, pool } = await import("./db/pool");
    const { rpc } = await import("./indexer");
    try {
      const report = await reconcileCircle(address, {
        reader: createRpcChainReader(rpc),
        source: createDbCircleSource(query),
      });
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const ctx = report.ledgerContext;
        console.log(`[reconcile:circle] ${report.circleAddress}: ${report.outcome}`);
        console.log(`  indexed ledger: ${ctx.indexedLedger}  chain ledger: ${ctx.chainLedger}  lag: ${ctx.lagLedgers}`);
        console.log(`  checked: ${report.checked.join(", ") || "(none)"}`);
        for (const m of report.mismatches) {
          console.log(
            `  • [${m.classification}] ${m.field}${m.key ? ` ${m.key}` : ""}: ` +
              `indexed=${m.indexed} chain=${m.chain} (source: ${m.source})`,
          );
        }
        for (const u of report.unavailable) {
          console.log(`  • [${u.failure}] ${u.source}: ${u.error}`);
        }
      }
      await pool.end();
      process.exit(report.outcome === "match" ? 0 : report.outcome === "mismatch" ? 1 : 2);
    } catch (err) {
      console.error("[reconcile:circle] Error:", err);
      await pool.end();
      process.exit(2);
    }
  })();
}
