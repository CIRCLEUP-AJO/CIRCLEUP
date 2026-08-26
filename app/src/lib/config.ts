// ─── Environment variable validation ─────────────────────────────────────────
//
// Called once at module load time (server-side). Throws with a clear message
// so the process crashes early rather than surfacing cryptic runtime errors.
//
// Rules:
//   • NEXT_PUBLIC_* vars are available on both server and client.
//   • On the client these checks are dead-code-eliminated by Next.js because
//     the `typeof window === "undefined"` guard is evaluated at build time.
//   • Contract addresses are required only in production; in development an
//     empty value is allowed so `npm run dev` still starts without a full
//     deployment.

const REQUIRED_ALWAYS = [
  "NEXT_PUBLIC_STELLAR_RPC_URL",
  "NEXT_PUBLIC_NETWORK_PASSPHRASE",
  "NEXT_PUBLIC_INDEXER_URL",
];

const REQUIRED_IN_PRODUCTION = [
  "NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS",
  "NEXT_PUBLIC_REPUTATION_ADDRESS",
  "NEXT_PUBLIC_USDC_ADDRESS",
];

/**
 * Validate environment variables and return a list of missing keys.
 * Exported for unit testing.
 */
export function getMissingEnvVars(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
  isProduction = process.env.NODE_ENV === "production",
): string[] {
  const missing: string[] = [];

  for (const key of REQUIRED_ALWAYS) {
    const value = env[key];
    if (!value || value.trim() === "") missing.push(key);
  }

  if (isProduction) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      const value = env[key];
      if (!value || value.trim() === "") missing.push(key);
    }
  }

  return missing;
}

/**
 * Throw an error listing every missing variable so the problem is immediately
 * obvious in logs / terminal output.
 * Only runs server-side (typeof window === "undefined").
 */
function assertEnvVars(): void {
  if (typeof window !== "undefined") return; // client bundle — skip

  const missing = getMissingEnvVars();
  if (missing.length === 0) return;

  throw new Error(
    `[CircleUp] Missing required environment variables:\n` +
      missing.map((k) => `  • ${k}`).join("\n") +
      `\n\nCopy app/.env.example to app/.env.local and fill in the missing values.`,
  );
}

// Run immediately on module load (server only)
assertEnvVars();

// ─── Typed exports ────────────────────────────────────────────────────────────

export const STELLAR_RPC_URL: string =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ||
  "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE: string =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
  "Test SDF Network ; September 2015";

export const CIRCLE_FACTORY_ADDRESS: string =
  process.env.NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS || "";

export const REPUTATION_ADDRESS: string =
  process.env.NEXT_PUBLIC_REPUTATION_ADDRESS || "";

export const USDC_ADDRESS: string =
  process.env.NEXT_PUBLIC_USDC_ADDRESS || "";

export const INDEXER_URL: string =
  process.env.NEXT_PUBLIC_INDEXER_URL || "http://localhost:3001";

// ─── USDC / stroops conversion ────────────────────────────────────────────────
//
// These helpers MIRROR sdk/src/utils.ts. The app intentionally does not depend
// on @circleup/sdk (see lib/gating.ts), so the money math is duplicated here and
// MUST stay behaviourally identical to the SDK: parse on strings only, never
// through floating point, and refuse — never silently truncate — values with
// more than 7 decimal places. Keep the two in sync.

/** 1 USDC = 10_000_000 stroops (7 decimal places) */
export const STROOP = BigInt(10_000_000);

/**
 * Convert a human-readable USDC amount to stroops (bigint), losslessly.
 *
 * Prefer `string` input for exact values. A `number` is stringified via its
 * shortest round-tripping form; JS exponent notation ("1e-7", "1e+21") is
 * expanded to a plain decimal first. Throws `TypeError` for negative, empty,
 * non-finite, malformed, or > 7-decimal-place amounts rather than dropping
 * digits silently.
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
  // Trailing fractional zeros carry no value; drop them before counting places.
  const frac = fracRaw.replace(/0+$/, "");
  if (frac.length > 7) {
    throw new TypeError(
      `usdcToStroops: "${str}" has ${frac.length} significant decimal places but USDC ` +
        `supports at most 7. Round or truncate before converting — this function ` +
        `refuses to drop digits silently.`,
    );
  }
  const fracPadded = frac.padEnd(7, "0");
  return BigInt(whole) * STROOP + BigInt(fracPadded);
}

/**
 * Normalise `number | string` (including JS exponent notation) to a plain
 * decimal string without any floating-point round-trip. Mirrors the SDK helper.
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
  if (str === "") throw new TypeError(`usdcToStroops: amount is empty.`);
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

/** Expand `<int>[.<frac>]e<exp>` to a plain decimal string by shifting the
 *  decimal point — pure string manipulation, no rounding. Mirrors the SDK. */
function expandScientificNotation(intPart: string, fracPart: string, exp: number): string {
  const digits = intPart + fracPart;
  const pointFromLeft = intPart.length + exp;
  if (pointFromLeft <= 0) return "0." + "0".repeat(-pointFromLeft) + digits;
  if (pointFromLeft >= digits.length) return digits + "0".repeat(pointFromLeft - digits.length);
  return `${digits.slice(0, pointFromLeft)}.${digits.slice(pointFromLeft)}`;
}

/**
 * Convert a stroops value to a human-readable USDC string.
 *
 * - Accepts `bigint | string | number` so callers don't need to cast.
 * - Returns `"0"` for falsy / invalid input rather than throwing.
 * - Strips trailing fractional zeros: 10.0000000 → "10", 1.5000000 → "1.5"
 */
/**
 * Convert a stroops value to a human-readable USDC string.
 *
 * - The exact inverse of {@link usdcToStroops}: prints all 7 fractional digits
 *   and strips only trailing zeros, so no precision is lost.
 * - Accepts `bigint | string | number` so callers don't need to cast.
 * - Returns `"0"` for falsy / invalid / negative input rather than throwing.
 * - Strips trailing fractional zeros: 10.0000000 → "10", 1.5000000 → "1.5"
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
  const frac = (n % STROOP).toString().padStart(7, "0");
  return `${whole}.${frac}`.replace(/\.?0+$/, "") || "0";
}

/**
 * Format a USDC amount (as a stroops value) for display, always showing
 * exactly 2 decimal places: "10.00", "1.50", "0.01".
 *
 * Display-only and deliberately lossy: it **truncates** to 2 dp rather than
 * rounding, so the shown value never overstates the true balance. Use this for
 * consistent currency-style display instead of the raw {@link stroopsToUsdc}.
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
  const frac = (n % STROOP).toString().padStart(7, "0").slice(0, 2); // 2 dp (truncate)
  return `${whole}.${frac}`;
}

/**
 * Calculate the total pot for a round and format it for display (2 dp).
 *
 *   formatPot("10000000", 4) → "4.00"  (4 members × $1.00)
 *
 * Returns `"0.00"` for a non-integer or negative member count rather than
 * throwing (`BigInt(1.5)` would otherwise raise a `RangeError`).
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

// ─── Address helpers ──────────────────────────────────────────────────────────

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 8) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
