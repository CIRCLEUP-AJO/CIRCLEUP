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

/** 1 USDC = 10_000_000 stroops (7 decimal places) */
export const STROOP = BigInt(10_000_000);

export function usdcToStroops(usdc: number): bigint {
  return BigInt(Math.round(usdc * 10_000_000));
}

/**
 * Convert a stroops value to a human-readable USDC string.
 *
 * - Accepts `bigint | string | number` so callers don't need to cast.
 * - Returns `"0"` for falsy / invalid input rather than throwing.
 * - Strips trailing fractional zeros: 10.0000000 → "10", 1.5000000 → "1.5"
 */
export function stroopsToUsdc(stroops: bigint | string | number): string {
  let n: bigint;
  try {
    n = BigInt(stroops.toString());
  } catch {
    return "0";
  }
  const whole = n / STROOP;
  const frac = (n % STROOP).toString().padStart(7, "0");
  return `${whole}.${frac}`.replace(/\.?0+$/, "") || "0";
}

/**
 * Format a USDC amount (as a stroops value) for display, always showing
 * exactly 2 decimal places: "10.00", "1.50", "0.01".
 *
 * Use this wherever a consistent, currency-style display is needed instead
 * of the raw `stroopsToUsdc` which strips trailing zeros.
 */
export function formatUsdc(stroops: bigint | string | number): string {
  let n: bigint;
  try {
    n = BigInt(stroops.toString());
  } catch {
    return "0.00";
  }
  const whole = n / STROOP;
  const frac = (n % STROOP).toString().padStart(7, "0").slice(0, 2); // 2 dp
  return `${whole}.${frac}`;
}

/**
 * Calculate the total pot for a round and format it for display (2 dp).
 *
 *   formatPot("10000000", 4) → "4.00"  (4 members × $1.00)
 */
export function formatPot(
  roundAmountStroops: bigint | string | number,
  memberCount: number,
): string {
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
