/**
 * Groups contributions, defaults, and payouts by round_index for the
 * GET /circles/:address/rounds response.
 *
 * The previous implementation only iterated payouts and O(n) filtered
 * contributions/defaults per payout, which:
 *   1. Silently dropped contributions for unpaid non-current rounds
 *   2. Did repeated linear scans instead of a single pass per collection
 */

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
  /** Completed rounds (have a payout), sorted by roundIndex ascending. */
  rounds: GroupedRound<C, D>[];
  /** The in-progress / cancelled-current round, if any. */
  currentRound: GroupedRound<C, D> | null;
  /**
   * Unpaid rounds that still have contributions and/or defaults but are not
   * the circle's current round — previously dropped silently.
   */
  openRounds: GroupedRound<C, D>[];
  /** Defaults belonging to rounds that have not yet been paid out. */
  pendingDefaults: D[];
}

/** Bucket rows by `round_index` in a single pass. */
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

function resolveStatus(
  roundIndex: number,
  hasPayout: boolean,
  circle: CircleRoundContext,
): RoundStatus {
  if (hasPayout) return "completed";
  if (roundIndex === circle.current_round) {
    if (circle.status === "Cancelled") return "cancelled";
    if (circle.status === "Active") return "current";
  }
  return "open";
}

/**
 * Build a complete per-round view from payouts, contributions, and defaults.
 * Every round_index that appears in any of the three collections is included;
 * the active/cancelled current round is included even when it has no rows yet.
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
  const contribByRound = groupByRoundIndex(contributions);
  const defaultsByRound = groupByRoundIndex(defaults);
  const payoutByRound = new Map<number, P>();
  for (const p of payouts) {
    // First payout wins — ON CONFLICT on ingest should keep these unique,
    // but if duplicates land we keep the earliest and still group activity.
    if (!payoutByRound.has(p.round_index)) {
      payoutByRound.set(p.round_index, p);
    }
  }

  const roundIndices = new Set<number>([
    ...payoutByRound.keys(),
    ...contribByRound.keys(),
    ...defaultsByRound.keys(),
  ]);

  if (circle.status === "Active" || circle.status === "Cancelled") {
    roundIndices.add(circle.current_round);
  }

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

  const rounds = all.filter((r) => r.status === "completed");
  const currentRound =
    all.find((r) => r.status === "current" || r.status === "cancelled") ?? null;
  const openRounds = all.filter((r) => r.status === "open");
  const pendingDefaults = defaults.filter((d) => !payoutByRound.has(d.round_index));

  return { rounds, currentRound, openRounds, pendingDefaults };
}
