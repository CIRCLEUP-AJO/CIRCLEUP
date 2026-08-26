/**
 * Log redaction helpers for the CircleUp indexer.
 *
 * # Principles
 *
 * - Full Stellar addresses (56-character G-/C- strkeys) are sensitive because
 *   they uniquely identify participants in savings circles and link financial
 *   activity to individuals.
 * - Transaction hashes (64 hex chars) allow full on-chain lookup of amounts
 *   and counterparties; they must not appear in plain log lines shipped to
 *   aggregators.
 * - Financial amounts (stroops bigints) are included only in aggregated or
 *   anonymised form (e.g. event counts), not paired with an individual address.
 *
 * # What appears in logs after redaction
 *
 * - Shortened address tokens: first 4 + last 4 characters, e.g.
 *   "GAZI…WN" — enough for correlation within a single debug session,
 *   not enough to reconstruct the full key.
 * - Tx correlation tokens: first 8 hex characters of the hash, prefixed with
 *   "tx:", e.g. "tx:3a4f8b2c" — allows log-line correlation without
 *   exposing the full hash.
 * - Event type tags (e.g. "circle/contributed"), ledger numbers, and round
 *   indices — none of these carry personal data.
 *
 * # What never appears in logs
 *
 * - Full addresses
 * - Full transaction hashes
 * - Signed or unsigned XDR
 * - Financial amounts paired with an individual address
 * - Raw error messages that may echo contract panic output (which can include
 *   argument values)
 *
 * Exported for unit tests and for use in the indexer and API modules.
 */

// ─── Address redaction ────────────────────────────────────────────────────────

/**
 * Returns true when `value` looks like a Stellar address (G- or C- strkey,
 * 56 characters).
 *
 * Consistent with the equivalent predicate in app/src/lib/telemetry.ts.
 */
export function looksLikeAddress(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[GC][A-Z2-7]{55}$/.test(value)
  );
}

/**
 * Shorten a Stellar address to a safe display token:
 *   "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
 *   →  "GAAZ…CCWN"
 *
 * If `addr` is not a recognisable address string the value is returned as-is
 * so callers do not need to guard before calling.
 */
export function redactAddress(addr: unknown): string {
  if (typeof addr !== "string") return String(addr);
  if (!looksLikeAddress(addr)) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// ─── Transaction hash redaction ───────────────────────────────────────────────

/**
 * Returns true when `value` looks like a 64-character hex transaction hash.
 */
export function looksLikeTxHash(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Shorten a transaction hash to a safe correlation token:
 *   "3a4f8b2c1d..." → "tx:3a4f8b2c"
 *
 * The 8-character prefix is long enough to uniquely identify a transaction
 * within a debugging session and to correlate log lines, but too short to
 * look up the full transaction on a public explorer without context.
 */
export function redactTxHash(hash: unknown): string {
  if (typeof hash !== "string") return String(hash);
  if (!looksLikeTxHash(hash)) return hash;
  return `tx:${hash.slice(0, 8)}`;
}

// ─── Amount redaction ─────────────────────────────────────────────────────────

/**
 * Format a financial amount for logging in a way that is safe to emit when
 * NOT paired with a specific address.  Returns a bracketed stroops value.
 *
 *   formatAmount(10_000_000n)  →  "[10000000 stroops]"
 *   formatAmount("500000")     →  "[500000 stroops]"
 *
 * Do NOT call this alongside a redactAddress(member) in the same log line
 * unless the pairing is explicitly justified — amount + short address is
 * still linkable in low-entropy address spaces.
 */
export function formatAmount(stroops: bigint | string | number): string {
  return `[${stroops.toString()} stroops]`;
}
