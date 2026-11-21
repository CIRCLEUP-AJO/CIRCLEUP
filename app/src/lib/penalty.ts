/**
 * Default-penalty preview, mirroring the circle contract (#874).
 *
 * Mirror of sdk/src/penalty.ts — kept in sync manually because the app does
 * not take a direct dependency on the SDK's runtime helpers (see gating.ts).
 *
 * Contract rule, in stroops: `penalty = floor(collateral × 2000 / 10000)`,
 * applied to the member's *remaining* collateral. Fractional stroops are
 * dropped (floor); nothing is rounded up or rejected. Collateral under
 * 5 stroops incurs no penalty, and positive collateral never reaches zero.
 * Each member is charged at most once per round.
 */

export const PENALTY_BPS = 2_000;
export const BPS_DENOM = 10_000;

export interface PenaltyPreview {
  penalty: bigint;
  remaining: bigint;
}

/**
 * Preview the penalty for one missed round. Returns `null` for input that is
 * not a non-negative integer stroop amount (e.g. a missing or malformed
 * indexer field) so callers never show a fabricated figure.
 */
export function previewDefaultPenalty(collateralStroops: string | bigint | null | undefined): PenaltyPreview | null {
  let c: bigint;
  try {
    if (collateralStroops === null || collateralStroops === undefined) return null;
    if (typeof collateralStroops === "string" && !/^\d+$/.test(collateralStroops.trim())) return null;
    c = typeof collateralStroops === "bigint" ? collateralStroops : BigInt(collateralStroops.trim());
  } catch {
    return null;
  }
  if (c < 0n) return null;
  const penalty = (c * BigInt(PENALTY_BPS)) / BigInt(BPS_DENOM);
  return { penalty, remaining: c - penalty };
}

export const PENALTY_RULE_TEXT =
  "20% of the member's remaining collateral, rounded down to the nearest stroop. " +
  "A member can be charged at most once per round.";
