/**
 * Canonical round-history reconciliation for the CircleUp indexer.
 *
 * ## Problem
 *
 * The indexer ingests contributions, defaults, and payouts from Stellar events
 * independently and in any order. Partial ingestion, out-of-order events, and
 * duplicate rows (e.g. after a ledger reorg or replay) all occur in practice.
 *
 * The previous grouping logic iterated payouts and O(n)-filtered contributions
 * and defaults per payout. This silently dropped:
 *   - contributions for rounds that have no payout yet (open rounds)
 *   - defaults for rounds that have no payout yet (pending defaults)
 *   - the current in-progress round when it had no contributions or defaults
 *
 * ## Solution
 *
 * A single canonical pass over all three collections builds a deduplicated
 * index by `round_index`. Status resolution is explicit and deterministic:
 * every round index that appears in any table is emitted exactly once.
 *
 * ### Status precedence (per round_index)
 *
 * | Condition                                            | Status      |
 * |------------------------------------------------------|-------------|
 * | A payout exists for this round_index                 | "completed" |
 * | round_index === circle.current_round AND Active      | "current"   |
 * | round_index === circle.current_round AND Cancelled   | "cancelled" |
 * | Any other round with contributions or defaults       | "open"      |
 *
 * A payout always wins over "current"/"cancelled" so the current round can
 * transition from "current" → "completed" without a conflicting status.
 *
 * ### Deduplication policy
 *
 * - **Payouts**: only the first payout row per `round_index` is used. Duplicate
 *   payout rows are logged (non-fatal) and discarded. The constraint should be
 *   enforced by the DB ON CONFLICT clause at ingest time; this guard prevents
 *   a transient ingest bug from producing split or missing payout data.
 * - **Contributions / defaults**: all rows for a given round are included;
 *   duplicates within those collections are preserved as-is so callers can
 *   deduplicate by their own keys (e.g. `(member_address, round_index)`).
 *   The groupByRoundIndex helper is intentionally non-deduplicating.
 *
 * ### Stability guarantees
 *
 * - `rounds` is sorted ascending by `roundIndex`.
 * - `currentRound` is the single round matching "current" or "cancelled"
 *   status; if somehow multiple rounds qualify (data anomaly) the one with
 *   the lowest `roundIndex` is chosen and a warning is logged.
 * - `openRounds` is sorted ascending by `roundIndex`.
 * - `pendingDefaults` contains every default row whose `round_index` has no
 *   associated payout.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type RoundStatus = "completed" | "current" | "cancelled" | "open";

export interface RoundPayoutFields {
  round_index: number;
  recipient: string;
  amount: string;
  tx_hash: string;
  ledger: string;
}

export interface RoundIndexed {
  round_index: number;
}

export interface CircleRoundContext {
  current_round: number;
  status: string;
}

export interface GroupedRound<C extends RoundIndexed, D extends RoundIndexed> {
  roundIndex: number;
  status: RoundStatus;
  recipient: string | null;
  amount: string | null;
  txHash: string | null;
  ledger: string | null;
  contributions: C[];
  defaults: D[];
}

export interface GroupedRoundsResult<
  C extends RoundIndexed,
  D extends RoundIndexed,
> {
  /** Completed rounds (have a payout), sorted ascending by roundIndex. */
  rounds: GroupedRound<C, D>[];
  /** The in-progress or cancelled-current round, if any. */
  currentRound: GroupedRound<C, D> | null;
  /**
   * Unpaid non-current rounds that still have contributions and/or defaults.
   * Previously dropped silently. Sorted ascending by roundIndex.
   */
  openRounds: GroupedRound<C, D>[];
  /**
   * Default rows whose round_index has no associated payout.
   * Matches across openRounds and the currentRound (if present).
   */
  pendingDefaults: D[];
}

// ─── groupByRoundIndex ────────────────────────────────────────────────────────

/**
 * Bucket rows by `round_index` in a single O(n) pass.
 *
 * Intentionally non-deduplicating: the caller decides which rows to retain
 * (e.g. deduplication by member_address within a round).
 */
export function groupByRoundIndex<T extends RoundIndexed>(
  rows: T[],
): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const list = map.get(row.round_index);
    if (list) {
      list.push(row);
    } else {
      map.set(row.round_index, [row]);
    }
  }
  return map;
}

// ─── resolveStatus ────────────────────────────────────────────────────────────

/**
 * Determine the canonical status for a single round_index.
 *
 * Payout presence always wins because a round can only be completed once
 * — a payout record is stronger evidence of terminal state than the
 * circle's current_round cursor.
 *
 * @param roundIndex  The round being classified.
 * @param hasPayout   Whether a payout row exists for this round.
 * @param circle      Circle-level context (current_round and status).
 */
export function resolveStatus(
  roundIndex: number,
  hasPayout: boolean,
  circle: CircleRoundContext,
): RoundStatus {
  if (hasPayout) return "completed";
  if (roundIndex === circle.current_round) {
    if (circle.status === "Cancelled") return "cancelled";
    if (circle.status === "Active") return "current";
  }
  // Any other round with activity but no payout and not the current round.
  // This includes rounds from Pending or Completed circles that have
  // contributions recorded — unusual, but possible with partial/noisy ingest.
  return "open";
}

// ─── buildPayoutIndex ────────────────────────────────────────────────────────

/**
 * Build a deduplicated payout index (round_index → first payout row).
 *
 * If more than one payout row exists for the same round_index (should not
 * happen after correct ON CONFLICT ingest, but can occur during replay or
 * after a reorg), the first row in the input array is kept and a warning is
 * written to stderr. The warning is non-fatal — the round is still included
 * in the reconciled output with the first payout's metadata.
 *
 * @param payouts  Raw payout rows, any order.
 * @returns        Deduplicated map from round_index to payout row.
 */
export function buildPayoutIndex<P extends RoundPayoutFields>(
  payouts: P[],
): Map<number, P> {
  const map = new Map<number, P>();
  for (const p of payouts) {
    if (!map.has(p.round_index)) {
      map.set(p.round_index, p);
    } else {
      // Non-fatal: log and keep the first occurrence.
      console.warn(
        `[groupRounds] Duplicate payout row for round_index=${p.round_index} ` +
          `(tx_hash=${p.tx_hash}). Keeping first occurrence. ` +
          "This indicates a replay or ingest inconsistency — review ingestion logs.",
      );
    }
  }
  return map;
}

// ─── groupCircleRounds ───────────────────────────────────────────────────────

/**
 * Build a complete, deduplicated per-round view from raw indexer rows.
 *
 * Every `round_index` that appears in any of the three input collections is
 * included exactly once in the output. The active or cancelled current round
 * is always included even when no contributions or defaults exist for it yet.
 *
 * ### Ordering guarantees
 *
 * - `rounds` — ascending `roundIndex`
 * - `openRounds` — ascending `roundIndex`
 * - Within each round, `contributions` and `defaults` preserve their original
 *   input order (which callers should pre-sort by `ledger` / `created_at`).
 *
 * ### Multiple-current-round anomaly
 *
 * If the data contains multiple rounds that would both resolve to "current"
 * or "cancelled" (an anomaly that should not occur in a well-formed DB but
 * can arise from partial ingest), only the lowest `roundIndex` is placed in
 * `currentRound` and the rest are demoted to `openRounds`. A warning is
 * written to stderr so the anomaly is visible in logs.
 *
 * @param circle        Circle context row (current_round, status).
 * @param payouts       All payout rows for this circle (any order).
 * @param contributions All contribution rows for this circle (any order).
 * @param defaults      All default rows for this circle (any order).
 */
export function groupCircleRounds<
  C extends RoundIndexed,
  D extends RoundIndexed,
  P extends RoundPayoutFields,
>(
  circle: CircleRoundContext,
  payouts: P[],
  contributions: C[],
  defaults: D[],
): GroupedRoundsResult<C, D> {
  // ── Step 1: build deduplicated payout index ──────────────────────────────
  const payoutByRound = buildPayoutIndex(payouts);

  // ── Step 2: bucket contributions and defaults by round_index ─────────────
  const contribByRound = groupByRoundIndex(contributions);
  const defaultsByRound = groupByRoundIndex(defaults);

  // ── Step 3: collect every known round_index ───────────────────────────────
  //
  // Union of all round indices seen in any collection, plus the circle's
  // current_round when the circle is Active or Cancelled (ensures the
  // in-progress round appears even when no rows exist for it yet).
  const roundIndices = new Set<number>([
    ...payoutByRound.keys(),
    ...contribByRound.keys(),
    ...defaultsByRound.keys(),
  ]);

  if (circle.status === "Active" || circle.status === "Cancelled") {
    roundIndices.add(circle.current_round);
  }

  // ── Step 4: resolve status for every round and build GroupedRound objects ─
  const all: GroupedRound<C, D>[] = [...roundIndices]
    .sort((a, b) => a - b)
    .map((roundIndex) => {
      const payout = payoutByRound.get(roundIndex);
      const status = resolveStatus(roundIndex, payout != null, circle);
      return {
        roundIndex,
        status,
        recipient: payout?.recipient ?? null,
        amount: payout?.amount ?? null,
        txHash: payout?.tx_hash ?? null,
        ledger: payout?.ledger ?? null,
        contributions: contribByRound.get(roundIndex) ?? [],
        defaults: defaultsByRound.get(roundIndex) ?? [],
      };
    });

  // ── Step 5: partition into output buckets ────────────────────────────────

  const rounds: GroupedRound<C, D>[] = [];
  const currentCandidates: GroupedRound<C, D>[] = [];
  const openRounds: GroupedRound<C, D>[] = [];

  for (const r of all) {
    if (r.status === "completed") {
      rounds.push(r);
    } else if (r.status === "current" || r.status === "cancelled") {
      currentCandidates.push(r);
    } else {
      openRounds.push(r);
    }
  }

  // Anomaly guard: if multiple rounds resolved to current/cancelled, keep
  // the one with the lowest roundIndex as currentRound and demote the rest
  // to openRounds (with status rewritten to "open") so no data is lost.
  let currentRound: GroupedRound<C, D> | null = null;
  if (currentCandidates.length > 1) {
    console.warn(
      `[groupRounds] Multiple rounds resolved to current/cancelled for ` +
        `circle.current_round=${circle.current_round}, status=${circle.status}. ` +
        `Indices: [${currentCandidates.map((r) => r.roundIndex).join(", ")}]. ` +
        "Keeping lowest; promoting others to openRounds. " +
        "This indicates a data anomaly — review ingestion logs.",
    );
    // currentCandidates is already sorted ascending by roundIndex (built from
    // the sorted `all` array), so index 0 is the lowest.
    currentRound = currentCandidates[0];
    for (let i = 1; i < currentCandidates.length; i++) {
      openRounds.push({ ...currentCandidates[i], status: "open" });
    }
    // Keep openRounds sorted after the potential appends above.
    openRounds.sort((a, b) => a.roundIndex - b.roundIndex);
  } else {
    currentRound = currentCandidates[0] ?? null;
  }

  // ── Step 6: collect pending defaults ────────────────────────────────────
  //
  // A default is "pending" when its round_index has no payout — i.e. the
  // penalty has been applied on-chain but the round hasn't been paid out yet.
  // This matches defaults in openRounds and in the currentRound.
  const pendingDefaults: D[] = defaults.filter(
    (d) => !payoutByRound.has(d.round_index),
  );

  return { rounds, currentRound, openRounds, pendingDefaults };
}
