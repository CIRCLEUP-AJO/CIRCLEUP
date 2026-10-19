/**
 * Field provenance and freshness labels for data-source disclosure.
 *
 * Three data sources appear in the CircleUp UI:
 *
 *   rpc      — live Stellar RPC read; reflects chain state at the moment of the
 *              call. Latest ledger sequence is the primary RPC-sourced value.
 *
 *   indexer  — indexed event history (members, rounds, contributions, reputation
 *              events). May lag the chain by one or more ledgers depending on
 *              indexer processing speed.
 *
 *   local    — computed in the browser from other sourced values (countdown,
 *              pot totals, participation rates). As fresh as its inputs.
 *
 * Freshness states for indexer-sourced fields:
 *
 *   fresh    — checkpoint age is within the configured threshold.
 *   stale    — data age exceeds the max age threshold, or checkpoint age is high.
 *   unknown  — no checkpoint timestamp is available.
 *
 * INVARIANT: "unknown" is never mapped to "fresh" or "current". A caller that
 * wants to display data with unknown freshness must do so explicitly, not by
 * silently treating absence as healthy.
 */

// ─── Source types ─────────────────────────────────────────────────────────────

/** Where a displayed field's value originates. */
export type FieldSource = "rpc" | "indexer" | "local";

/**
 * Freshness of an indexer-sourced field.
 * "unknown" must never be shown as "current" or "healthy".
 */
export type FieldFreshness = "fresh" | "stale" | "unknown";

// ─── Human-readable labels ────────────────────────────────────────────────────

/** Short display label for each data source. */
export const SOURCE_LABELS: Record<FieldSource, string> = {
  rpc: "Live (RPC)",
  indexer: "Indexed",
  local: "Computed",
};

/**
 * Short display text for each freshness state.
 * "unknown freshness" is intentionally distinct from "current" to prevent
 * users from treating absent checkpoint data as a healthy signal.
 */
export const FRESHNESS_LABELS: Record<FieldFreshness, string> = {
  fresh: "current",
  stale: "may lag chain",
  unknown: "unknown freshness",
};

// ─── Freshness classification ─────────────────────────────────────────────────

/**
 * Classify indexer freshness from a checkpoint timestamp and an optional
 * wall-clock data age.
 *
 * Rules (in priority order):
 *   1. If checkpointTime is null/undefined/unparseable → "unknown"
 *   2. If dataAgeMs ≥ maxAgeMs → "stale"
 *   3. Otherwise → "fresh"
 *
 * "unknown" is the safe fallback — callers must never map it to "fresh".
 *
 * @param checkpointTime  ISO-8601 string from the indexer, or null when absent.
 * @param dataAgeMs       Optional: how old the fetched data is in milliseconds.
 * @param maxAgeMs        Optional: threshold above which data is considered stale.
 */
export function classifyFreshness(
  checkpointTime: string | null | undefined,
  dataAgeMs?: number,
  maxAgeMs?: number,
): FieldFreshness {
  if (checkpointTime == null) return "unknown";
  const parsed = Date.parse(checkpointTime);
  if (isNaN(parsed)) return "unknown";
  if (dataAgeMs !== undefined && maxAgeMs !== undefined && dataAgeMs >= maxAgeMs) {
    return "stale";
  }
  return "fresh";
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format a combined source + freshness label for tooltips and small badges.
 * Example: "Indexed · current", "Indexed · unknown freshness".
 */
export function formatSourceLabel(source: FieldSource, freshness: FieldFreshness): string {
  return `${SOURCE_LABELS[source]} · ${FRESHNESS_LABELS[freshness]}`;
}

/**
 * Build an accessible aria-label string for a data source badge.
 * Example: "Data source: Indexed. Freshness: may lag chain."
 */
export function ariaSourceLabel(source: FieldSource, freshness: FieldFreshness): string {
  return `Data source: ${SOURCE_LABELS[source]}. Freshness: ${FRESHNESS_LABELS[freshness]}.`;
}
