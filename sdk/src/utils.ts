// ─── Utility helpers ──────────────────────────────────────────────────────────

import { USDC_DECIMALS, STROOPS_PER_USDC } from "./constants";

export { USDC_DECIMALS };

export const STROOP = BigInt(STROOPS_PER_USDC);

/** Convert a human-readable USDC amount to stroops */
export function usdcToStroops(usdc: number | string): bigint {
  const [whole, frac = ""] = String(usdc).split(".");
  const fracPadded = frac.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  return BigInt(whole) * STROOP + BigInt(fracPadded);
}

/** Convert stroops to human-readable USDC string */
export function stroopsToUsdc(stroops: bigint): string {
  const whole = stroops / STROOP;
  const frac = (stroops % STROOP).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`;
}

/** Approximate ledgers for a given number of days (Stellar: ~5 s/ledger) */
export function daysToLedgers(days: number): number {
  return Math.round((days * 24 * 60 * 60) / 5);
}

/** Approximate days for a given number of ledgers */
export function ledgersToDays(ledgers: number): number {
  return Math.round((ledgers * 5) / (24 * 60 * 60));
}

/** Format a Stellar address for display: first 4 + … + last 4 */
export function shortAddress(address: string): string {
  if (!address || address.length < 8) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
