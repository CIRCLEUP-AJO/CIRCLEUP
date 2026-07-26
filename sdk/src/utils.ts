// ─── Utility helpers ──────────────────────────────────────────────────────────

import { USDC_DECIMALS, STROOPS_PER_USDC } from "./constants";

export { USDC_DECIMALS };

export const STROOP = BigInt(STROOPS_PER_USDC);

// ─── USDC / stroops conversion ────────────────────────────────────────────────

/**
 * Convert a human-readable USDC amount to stroops (bigint).
 *
 * Accepts integers or decimals as `number` or `string`:
 *   usdcToStroops(10)       → 100_000_000n
 *   usdcToStroops("1.5")    → 15_000_000n
 *   usdcToStroops("0.01")   → 100_000n
 *
 * Throws `TypeError` for:
 *   - Negative values
 *   - Non-numeric strings
 *   - More than 7 decimal places (precision loss would be silent otherwise)
 */
export function usdcToStroops(usdc: number | string): bigint {
  const str = String(usdc).trim();

  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new TypeError(
      `usdcToStroops: invalid USDC amount "${str}". Expected a non-negative decimal string, e.g. "1.50".`,
    );
  }

  const [whole, frac = ""] = str.split(".");

  if (frac.length > USDC_DECIMALS) {
    throw new TypeError(
      `usdcToStroops: "${str}" has ${frac.length} decimal places but USDC supports at most ${USDC_DECIMALS}. ` +
        `Truncate the value before converting.`,
    );
  }

  const fracPadded = frac.padEnd(USDC_DECIMALS, "0");
  return BigInt(whole) * STROOP + BigInt(fracPadded);
}

/**
 * Convert stroops to a compact human-readable USDC string.
 *
 * Accepts `bigint | string | number` so callers don't need to cast database
 * values (which arrive as strings) or contract values (which arrive as bigint).
 *
 * Trailing fractional zeros are stripped:
 *   100_000_000n → "10"
 *   15_000_000n  → "1.5"
 *   100_000n     → "0.01"
 *
 * Returns `"0"` for invalid / falsy input rather than throwing, because this
 * function is frequently used in render paths where a fallback display value
 * is preferable to an uncaught exception.
 */
export function stroopsToUsdc(stroops: bigint | string | number): string {
  let n: bigint;
  try {
    n = BigInt(stroops.toString());
  } catch {
    return "0";
  }

  if (n < 0n) {
    // Negative stroops are not valid in CircleUp; surface as "0" rather than
    // a confusing negative display value.
    return "0";
  }

  const whole = n / STROOP;
  const frac = (n % STROOP).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`.replace(/\.?0+$/, "") || "0";
}

/**
 * Format a stroops value for currency display: always 2 decimal places.
 *
 *   100_000_000n → "10.00"
 *   15_000_000n  → "1.50"
 *   100_000n     → "0.01"
 *
 * Use this wherever a consistent dollar-amount display is needed (UI labels,
 * summaries, card stats). Reserve `stroopsToUsdc` for compact/technical output.
 */
export function formatUsdc(stroops: bigint | string | number): string {
  let n: bigint;
  try {
    n = BigInt(stroops.toString());
  } catch {
    return "0.00";
  }

  if (n < 0n) return "0.00";

  const whole = n / STROOP;
  // Keep only the first 2 of the 7 fractional digits
  const frac = (n % STROOP).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

/**
 * Calculate the total pot for a round given the per-member amount (in stroops)
 * and member count.  Returns a formatted USDC string with 2 decimal places.
 *
 *   potPerRound("10000000", 4) → "4.00"
 */
export function formatPot(
  roundAmountStroops: bigint | string | number,
  memberCount: number,
): string {
  if (!Number.isInteger(memberCount) || memberCount < 0) {
    return "0.00";
  }

  let n: bigint;
  try {
    n = BigInt(roundAmountStroops.toString());
  } catch {
    return "0.00";
  }
  return formatUsdc(n * BigInt(memberCount));
}

// ─── Ledger / time helpers ────────────────────────────────────────────────────

/** Approximate ledgers for a given number of days (Stellar: ~5 s/ledger) */
export function daysToLedgers(days: number): number {
  if (days < 0) throw new RangeError(`daysToLedgers: days must be >= 0, got ${days}`);
  return Math.round((days * 24 * 60 * 60) / 5);
}

/** Approximate days for a given number of ledgers */
export function ledgersToDays(ledgers: number): number {
  if (ledgers < 0) throw new RangeError(`ledgersToDays: ledgers must be >= 0, got ${ledgers}`);
  return Math.round((ledgers * 5) / (24 * 60 * 60));
}

// ─── Address helpers ──────────────────────────────────────────────────────────

/** Format a Stellar address for display: first 4 + … + last 4 */
export function shortAddress(address: string): string {
  if (!address || address.length < 8) return address ?? "";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

/** Sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
