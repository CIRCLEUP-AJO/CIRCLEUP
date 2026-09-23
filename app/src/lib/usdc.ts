/**
 * Canonical USDC / stroops conversion helpers — app layer (Issue #475).
 *
 * This module is the single source of truth for money math in the app.  It is
 * a **byte-for-byte behavioural mirror** of sdk/src/utils.ts (usdcToStroops,
 * stroopsToUsdc, formatUsdc, formatPot) and sdk/src/constants.ts (USDC_DECIMALS,
 * STROOPS_PER_USDC, STROOP).
 *
 * The app deliberately does not take a runtime dependency on @circleup/sdk (see
 * app/src/lib/config.ts comment), so money math is re-declared here.  The
 * cross-workspace parity test (src/__tests__/usdc-parity.test.ts) imports both
 * copies and asserts identical output for every representative input, ensuring
 * that any future drift is caught in CI before it reaches a user.
 *
 * Rules for maintaining parity:
 *   1. Never change an algorithm here without making the same change in
 *      sdk/src/utils.ts (or vice versa).
 *   2. The parity test is the automated enforcement mechanism — do not disable
 *      or skip it.
 *   3. All money arithmetic must use bigint; never route a stroop or USDC value
 *      through a JavaScript `number` / floating point.
 *
 * ─── Invariants (enforced by the parity test) ─────────────────────────────────
 *
 *   • usdcToStroops(stroopsToUsdc(n)) === n  for any bigint n >= 0
 *   • Both functions throw/return "0" identically for every invalid input.
 *   • formatUsdc truncates (never rounds) to 2 dp — "1.239…" → "1.23".
 *   • usdcToStroops rejects amounts with > 7 significant decimal places.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *   import { usdcToStroops, stroopsToUsdc, formatUsdc, formatPot, STROOP } from "@/lib/usdc";
 *
 *   const stroops = usdcToStroops("42.50");    // 425_000_000n
 *   const display = formatUsdc(425_000_000n);  // "42.50"
 *   const exact   = stroopsToUsdc(15_000_000n); // "1.5"
 */

// ─── Constants (mirrors sdk/src/constants.ts) ─────────────────────────────────

/** Number of decimal places USDC uses. Equal to sdk's USDC_DECIMALS. */
export const USDC_DECIMALS = 7;

/** Number of stroops in one whole USDC. Equal to sdk's STROOPS_PER_USDC. */
export const STROOPS_PER_USDC = 10_000_000;

/**
 * 1 USDC expressed as a bigint of stroops.
 * All arithmetic uses this rather than the numeric literal to avoid integer
 * overflow in future refactors.
 */
export const STROOP = BigInt(STROOPS_PER_USDC);

// ─── usdcToStroops ────────────────────────────────────────────────────────────

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
 *   usdcToStroops("1.5000000") → 15_000_000n   // trailing zeros fine
 *
 * `string` is preferred for exact values.  A `number` is accepted and
 * stringified via its shortest round-tripping form; JS exponent notation
 * ("1e-7", "1e+21") is expanded to a plain decimal first.
 *
 * @throws {TypeError} for negative, empty, non-finite, malformed, or
 *   > 7-significant-decimal-place amounts.
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
  // Trailing fractional zeros carry no value; drop before counting precision.
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

// ─── toPlainDecimalString (internal) ─────────────────────────────────────────

/**
 * Normalise `number | string` (including JS exponent notation) to a plain
 * decimal string without any floating-point round-trip.
 *
 * Mirrors the private helper in sdk/src/utils.ts.
 *
 * @throws {TypeError} for non-finite numbers, empty strings, negative amounts,
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
    throw new TypeError(
      `usdcToStroops: "${str}" is not a valid amount. Exponent notation must look ` +
        `like "1e-7": digits, a single e/E, then an integer exponent.`,
    );
  }

  return str;
}

// ─── expandScientificNotation (internal) ──────────────────────────────────────

/**
 * Expand `<intPart>[.<fracPart>]e<exp>` into a plain decimal string by shifting
 * the decimal point — pure string manipulation, no rounding, no floating point.
 * Mirrors the private helper in sdk/src/utils.ts.
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

// ─── stroopsToUsdc ────────────────────────────────────────────────────────────

/**
 * Convert stroops to a compact human-readable USDC string.
 *
 * This is the **exact inverse** of {@link usdcToStroops}: prints all 7
 * fractional digits and strips only trailing zeros, so no precision is lost
 * and `usdcToStroops(stroopsToUsdc(n)) === n` for any non-negative `n`.
 *
 * Accepts `bigint | string | number` so callers don't need to cast.
 *
 * Returns `"0"` for invalid / falsy / negative input rather than throwing,
 * because this function is used in render paths where a fallback display value
 * is preferable to an uncaught exception.
 *
 *   stroopsToUsdc(100_000_000n) → "10"
 *   stroopsToUsdc(15_000_000n)  → "1.5"
 *   stroopsToUsdc(1n)           → "0.0000001"
 */
export function stroopsToUsdc(stroops: bigint | string | number): string {
  let n: bigint;
  try {
    n = BigInt(stroops.toString());
  } catch {
    return "0";
  }

  if (n < 0n) return "0";

  const whole = n / STROOP;
  const frac = (n % STROOP).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`.replace(/\.?0+$/, "") || "0";
}

// ─── formatUsdc ───────────────────────────────────────────────────────────────

/**
 * Format a stroops value for currency display — always exactly 2 decimal places.
 *
 * Display-only and **deliberately lossy**: truncates (never rounds) to 2 dp so
 * the shown value never overstates the true balance:
 *   12_349_999n → "1.23"  (NOT "1.24")
 *
 * Use this for all UI amount labels, card stats, and summaries.
 * Use {@link stroopsToUsdc} when you need the exact, lossless value.
 *
 *   formatUsdc(100_000_000n) → "10.00"
 *   formatUsdc(15_000_000n)  → "1.50"
 *   formatUsdc(100_000n)     → "0.01"
 *   formatUsdc(0n)           → "0.00"
 *   formatUsdc(-1n)          → "0.00"  (negative → floor to zero)
 *   formatUsdc("bad")        → "0.00"  (invalid → safe fallback)
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
  // Truncate at 2 dp: take the first 2 of the 7 fractional digits.
  const frac = (n % STROOP).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

// ─── formatPot ────────────────────────────────────────────────────────────────

/**
 * Calculate the total round pot and format it for display (2 dp).
 *
 *   formatPot("10000000", 4) → "4.00"   (4 members × $1.00/round)
 *   formatPot(5_000_000n, 2) → "1.00"
 *
 * Returns `"0.00"` for a non-integer or negative member count, or an invalid
 * round amount, rather than throwing — consistent with {@link formatUsdc}.
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
