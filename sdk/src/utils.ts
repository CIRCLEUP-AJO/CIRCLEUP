// ─── Utility helpers ──────────────────────────────────────────────────────────

import { USDC_DECIMALS, STROOPS_PER_USDC } from "./constants";

export { USDC_DECIMALS };

/**
 * Stroops per whole USDC: `10 ** USDC_DECIMALS` (10_000_000).
 *
 * Units & precision — the single source of truth for money math in the SDK:
 *
 *   • On-chain, every amount is an integer number of **stroops** (Soroban i128).
 *     A stroop is the smallest indivisible unit; USDC has {@link USDC_DECIMALS}
 *     (7) decimal places, so 1 USDC = 10_000_000 stroops.
 *   • Off-chain, humans enter **decimal USDC** ("12.50"). Converting between the
 *     two is done *exactly*, on strings and bigint only — never through a
 *     JavaScript `number` / floating point, which cannot represent most decimal
 *     fractions (e.g. `0.1`) and would silently corrupt balances.
 *
 * {@link usdcToStroops} and {@link stroopsToUsdc} are exact inverses for any
 * value with ≤ 7 decimals. {@link formatUsdc} and {@link formatPot} are
 * display-only (fixed 2 dp) and are documented as lossy at their definitions.
 */
export const STROOP = BigInt(STROOPS_PER_USDC);

// ─── USDC / stroops conversion ────────────────────────────────────────────────

/**
 * Convert a human-readable USDC amount to stroops (bigint), **losslessly**.
 *
 * Parsing is done entirely on strings — the value is never routed through
 * floating point — so any amount with at most {@link USDC_DECIMALS} (7) decimal
 * places converts exactly:
 *
 *   usdcToStroops(10)          → 100_000_000n
 *   usdcToStroops("1.5")       → 15_000_000n
 *   usdcToStroops("0.01")      → 100_000n
 *   usdcToStroops("0.0000001") → 1n            // one stroop
 *   usdcToStroops("1.5000000") → 15_000_000n   // trailing zeros are fine
 *
 * `string` input is recommended for exact values. A `number` is accepted for
 * convenience and converted via its shortest round-tripping decimal
 * representation (`String(n)`); JavaScript renders very small or very large
 * magnitudes in exponent notation ("1e-7", "1e+21"), which is expanded to a
 * plain decimal string first (see {@link toPlainDecimalString}). A `number`
 * literal such as `0.1 + 0.2` is already an inexact double
 * (`0.30000000000000004`) before it ever reaches this function; that is
 * rejected below rather than silently truncated.
 *
 * @throws `TypeError` — with a specific message — for:
 *   - Negative amounts.
 *   - Empty, non-numeric, or malformed strings.
 *   - Non-finite numbers (`NaN`, `Infinity`).
 *   - Malformed exponent notation ("1e", "1e2e3").
 *   - More than {@link USDC_DECIMALS} significant decimal places (silent
 *     precision loss is never performed; the caller must round or truncate
 *     deliberately).
 */
export function usdcToStroops(usdc: number | string): bigint {
  const str = toPlainDecimalString(usdc);

  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new TypeError(
      `usdcToStroops: invalid USDC amount "${str}". ` +
        `Expected a non-negative decimal, e.g. "1.50" or "0.0000001".`,
    );
  }

  const [whole, fracRaw = ""] = str.split(".");
  // Trailing fractional zeros carry no value, so drop them before counting
  // precision: "1.5000000" and "10e-8" (→ "0.00000010") are the exact values
  // they represent, not 8-decimal-place inputs.
  const frac = fracRaw.replace(/0+$/, "");

  if (frac.length > USDC_DECIMALS) {
    throw new TypeError(
      `usdcToStroops: "${str}" has ${frac.length} significant decimal places but USDC ` +
        `supports at most ${USDC_DECIMALS}. Round or truncate before converting — this ` +
        `function refuses to drop digits silently.`,
    );
  }

  const fracPadded = frac.padEnd(USDC_DECIMALS, "0");
  return BigInt(whole) * STROOP + BigInt(fracPadded);
}

/**
 * Normalise a USDC amount to a plain (non-exponent) decimal string, without any
 * floating-point round-trip. Used by {@link usdcToStroops} so that both `string`
 * and `number` inputs — including JS exponent notation for extreme magnitudes —
 * flow through one exact code path.
 *
 * Does not enforce the 7-decimal limit; that is the caller's job.
 *
 * @throws `TypeError` for non-finite numbers, empty strings, negative amounts,
 *   or malformed exponent notation.
 */
function toPlainDecimalString(usdc: number | string): string {
  let str: string;

  if (typeof usdc === "number") {
    if (!Number.isFinite(usdc)) {
      throw new TypeError(
        `usdcToStroops: amount must be a finite number, got ${String(usdc)}.`,
      );
    }
    // String(number) is the shortest decimal that round-trips to the same
    // double; it uses exponent notation only for very small/large magnitudes.
    str = String(usdc);
  } else {
    str = usdc.trim();
  }

  if (str === "") {
    throw new TypeError(`usdcToStroops: amount is empty.`);
  }

  if (str.startsWith("-")) {
    throw new TypeError(`usdcToStroops: amount must be non-negative, got "${str}".`);
  }

  const exp = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(str);
  if (exp) {
    return expandScientificNotation(exp[1], exp[2] ?? "", parseInt(exp[3], 10));
  }
  if (/[eE]/.test(str)) {
    // Resembled exponent notation but did not parse (e.g. "1e", "1e2e3").
    throw new TypeError(
      `usdcToStroops: "${str}" is not a valid amount. Exponent notation must look ` +
        `like "1e-7": digits, a single e/E, then an integer exponent.`,
    );
  }

  return str;
}

/**
 * Expand `<intPart>[.<fracPart>]e<exp>` into a plain decimal string by shifting
 * the decimal point `exp` places — pure string manipulation, no rounding, no
 * floating point.
 *
 *   ("1", "",  -7) → "0.0000001"
 *   ("1", "5",  3) → "1500"
 *   ("5", "",  -1) → "0.5"
 */
function expandScientificNotation(intPart: string, fracPart: string, exp: number): string {
  const digits = intPart + fracPart;
  const pointFromLeft = intPart.length + exp;

  if (pointFromLeft <= 0) {
    return "0." + "0".repeat(-pointFromLeft) + digits;
  }
  if (pointFromLeft >= digits.length) {
    return digits + "0".repeat(pointFromLeft - digits.length);
  }
  return `${digits.slice(0, pointFromLeft)}.${digits.slice(pointFromLeft)}`;
}

/**
 * Convert stroops to a compact human-readable USDC string.
 *
 * This is the exact inverse of {@link usdcToStroops}: it prints every one of the
 * 7 fractional digits and strips only *trailing* zeros, so no precision is lost
 * and `usdcToStroops(stroopsToUsdc(n)) === n` for any non-negative `n`.
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
 * Display-only and deliberately lossy: it **truncates** to 2 dp rather than
 * rounding, so the shown value never *overstates* the true balance
 * (12_349_999n → "1.23", never "1.24"). Use this for consistent dollar-amount
 * display (UI labels, summaries, card stats) and reserve {@link stroopsToUsdc}
 * for the exact, lossless value.
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
  // Keep only the first 2 of the 7 fractional digits (truncate, do not round).
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
