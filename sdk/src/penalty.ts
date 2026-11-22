/**
 * Default-penalty arithmetic, mirroring the circle contract exactly (#874).
 *
 * Contract rule (`mark_default` and `settle_round`, i128 base units):
 *
 * ```text
 * penalty        = collateral * PENALTY_BPS / BPS_DENOM   // integer division
 * new_collateral = collateral - penalty
 * ```
 *
 * `collateral` is never negative, so the integer division **floors**:
 * fractional base units (stroops) are dropped in the member's favour. Nothing
 * is rounded up and no amount is rejected for being indivisible. With
 * `PENALTY_BPS = 2_000` and `BPS_DENOM = 10_000` this is `floor(collateral / 5)`:
 *
 * - collateral 1–4 stroops → penalty 0 (the default is still recorded);
 * - positive collateral never reaches 0 through penalties;
 * - each penalty applies to the *remaining* balance, so repeated misses decay
 *   geometrically (100 → 80 → 64 → 52 → 42);
 * - a member is charged at most once per round, whichever of `mark_default`
 *   and `settle_round` runs first.
 *
 * Forfeited amounts stay in the circle contract; they are not paid to other
 * members (see docs/DEFAULT_PENALTY_ROUNDING.md).
 */

import { BPS_DENOM, PENALTY_BPS } from "./constants";

/** How fractional base units are resolved: always floored. */
export const PENALTY_ROUNDING = "floor" as const;

export interface DefaultPenalty {
  /** Stroops deducted from collateral (≥ 0n). */
  penalty: bigint;
  /** Collateral after the deduction (≥ 0n; ≥ 1n when input ≥ 1n). */
  remaining: bigint;
}

/**
 * Penalty for one missed round given the member's *current* collateral.
 *
 * @throws RangeError when `collateral` is negative (the contract never stores
 *   negative collateral) or `penaltyBps` is outside `[0, BPS_DENOM]`.
 */
export function computeDefaultPenalty(
  collateral: bigint,
  penaltyBps: number = PENALTY_BPS,
): DefaultPenalty {
  if (collateral < 0n) {
    throw new RangeError(`collateral must be >= 0 stroops, got ${collateral}`);
  }
  if (!Number.isInteger(penaltyBps) || penaltyBps < 0 || penaltyBps > BPS_DENOM) {
    throw new RangeError(`penaltyBps must be an integer in [0, ${BPS_DENOM}], got ${penaltyBps}`);
  }
  // BigInt division truncates toward zero, which is floor for non-negative values.
  const penalty = (collateral * BigInt(penaltyBps)) / BigInt(BPS_DENOM);
  return { penalty, remaining: collateral - penalty };
}

/**
 * Collateral after each of `rounds` consecutive missed rounds, starting from
 * `collateral`. Element `i` is the balance after the `(i + 1)`-th default.
 */
export function projectCollateralAfterDefaults(
  collateral: bigint,
  rounds: number,
  penaltyBps: number = PENALTY_BPS,
): bigint[] {
  if (!Number.isInteger(rounds) || rounds < 0) {
    throw new RangeError(`rounds must be a non-negative integer, got ${rounds}`);
  }
  const out: bigint[] = [];
  let c = collateral;
  for (let i = 0; i < rounds; i++) {
    c = computeDefaultPenalty(c, penaltyBps).remaining;
    out.push(c);
  }
  return out;
}

/** Human-readable statement of the rule for UIs and docs. */
export const PENALTY_RULE_DESCRIPTION =
  "A missed round forfeits 20% of the member's remaining collateral, rounded down " +
  "to the nearest stroop. Balances under 5 stroops incur no penalty. Each member " +
  "is charged at most once per round.";
