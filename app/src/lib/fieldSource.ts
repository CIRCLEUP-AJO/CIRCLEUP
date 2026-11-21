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

// ─── Reputation provenance ────────────────────────────────────────────────────

/**
 * Provenance for the reputation page.
 *
 * The reputation score is an on-chain RPC read (the contract is the
 * authorization source of truth for the score). The contribution / default
 * history is indexed event data and may lag the chain. The indexer is NOT the
 * contract's authorization source — it only projects history from events.
 */

/** Where the reputation score value originates: always a live RPC read. */
export const REPUTATION_SCORE_SOURCE: FieldSource = "rpc";

/** Where the reputation history originates: always indexed event data. */
export const REPUTATION_HISTORY_SOURCE: FieldSource = "indexer";

/** Display label for the reputation score source. */
export const REPUTATION_SCORE_SOURCE_LABEL = SOURCE_LABELS[REPUTATION_SCORE_SOURCE]; // "Live (RPC)"

/** Display label for the reputation history source. */
export const REPUTATION_HISTORY_SOURCE_LABEL = SOURCE_LABELS[REPUTATION_HISTORY_SOURCE]; // "Indexed"

/**
 * Freshness metadata for indexed reputation history, derived from the indexer
 * response without any extra requests.
 */
export interface ReputationHistoryFreshness {
  /** ISO-8601 timestamp of the last indexer update, or null when absent. */
  updatedAt: string | null;
  /** Latest ledger the indexer has processed, or null when absent. */
  lastProcessedLedger: number | null;
  /** Classified freshness; "unknown" is never treated as "fresh". */
  freshness: FieldFreshness;
  /** Combined source + freshness label, e.g. "Indexed · current". */
  label: string;
}

/**
 * Build freshness metadata for indexed reputation history from the indexer
 * response. Uses only fields already present in the response (updatedAt,
 * lastProcessedLedger) — no additional requests are issued.
 *
 * @param updatedAt           ISO-8601 timestamp from the indexer, or null.
 * @param lastProcessedLedger Latest processed ledger from the indexer, or null.
 * @param dataAgeMs           Optional: age of the fetched data in milliseconds.
 * @param maxAgeMs            Optional: threshold above which data is stale.
 */
export function buildReputationHistoryFreshness(
  updatedAt: string | null | undefined,
  lastProcessedLedger: number | null | undefined,
  dataAgeMs?: number,
  maxAgeMs?: number,
): ReputationHistoryFreshness {
  const freshness = classifyFreshness(updatedAt, dataAgeMs, maxAgeMs);
  return {
    updatedAt: updatedAt ?? null,
    lastProcessedLedger: lastProcessedLedger ?? null,
    freshness,
    label: formatSourceLabel(REPUTATION_HISTORY_SOURCE, freshness),
  };
}

// ─── Reputation score states ──────────────────────────────────────────────────

/**
 * Discriminated union for the on-chain reputation score read.
 *
 *   verified-zero — RPC read succeeded and returned exactly 0.
 *   value         — RPC read succeeded and returned a non-zero score.
 *   read-failed   — RPC read failed; the score is unavailable (NOT zero).
 */
export type ReputationScoreState =
  | {
      kind: "verified-zero";
      source: typeof REPUTATION_SCORE_SOURCE;
      sourceLabel: string;
      score: 0;
    }
  | {
      kind: "value";
      source: typeof REPUTATION_SCORE_SOURCE;
      sourceLabel: string;
      score: number;
    }
  | {
      kind: "read-failed";
      source: typeof REPUTATION_SCORE_SOURCE;
      sourceLabel: string;
      error: string;
    };

/**
 * Classify a reputation score read result.
 *
 * @param score  The score returned by the contract getter, or null/undefined
 *               when the read failed.
 * @param error  Optional error message when the read failed.
 */
export function classifyReputationScore(
  score: number | null | undefined,
  error?: string,
): ReputationScoreState {
  if (score == null) {
    return {
      kind: "read-failed",
      source: REPUTATION_SCORE_SOURCE,
      sourceLabel: REPUTATION_SCORE_SOURCE_LABEL,
      error: error ?? "Reputation score unavailable",
    };
  }
  if (score === 0) {
    return {
      kind: "verified-zero",
      source: REPUTATION_SCORE_SOURCE,
      sourceLabel: REPUTATION_SCORE_SOURCE_LABEL,
      score: 0,
    };
  }
  return {
    kind: "value",
    source: REPUTATION_SCORE_SOURCE,
    sourceLabel: REPUTATION_SCORE_SOURCE_LABEL,
    score,
  };
}

// ─── Reputation history states ────────────────────────────────────────────────

/**
 * Discriminated union for indexed reputation history.
 *
 *   empty       — indexer responded and confirmed there are no records.
 *   records     — indexer responded with one or more history records.
 *   unavailable — indexer data could not be fetched; history is unknown,
 *                 NOT empty.
 */
export type ReputationHistoryState =
  | {
      kind: "empty";
      source: typeof REPUTATION_HISTORY_SOURCE;
      sourceLabel: string;
      freshness: ReputationHistoryFreshness;
    }
  | {
      kind: "records";
      source: typeof REPUTATION_HISTORY_SOURCE;
      sourceLabel: string;
      freshness: ReputationHistoryFreshness;
      records: readonly unknown[];
    }
  | {
      kind: "unavailable";
      source: typeof REPUTATION_HISTORY_SOURCE;
      sourceLabel: string;
      error: string;
    };

/**
 * Classify indexed reputation history.
 *
 * @param records     History records from the indexer, or null/undefined when
 *                    the indexer data could not be fetched.
 * @param updatedAt   Indexer updatedAt timestamp (for freshness), or null.
 * @param lastProcessedLedger Indexer last processed ledger, or null.
 * @param error       Optional error message when the fetch failed.
 * @param dataAgeMs   Optional: age of the fetched data in milliseconds.
 * @param maxAgeMs    Optional: threshold above which data is stale.
 */
export function classifyReputationHistory(
  records: readonly unknown[] | null | undefined,
  updatedAt: string | null | undefined,
  lastProcessedLedger: number | null | undefined,
  error?: string,
  dataAgeMs?: number,
  maxAgeMs?: number,
): ReputationHistoryState {
  if (records == null) {
    return {
      kind: "unavailable",
      source: REPUTATION_HISTORY_SOURCE,
      sourceLabel: REPUTATION_HISTORY_SOURCE_LABEL,
      error: error ?? "Indexed history unavailable",
    };
  }
  const freshness = buildReputationHistoryFreshness(
    updatedAt,
    lastProcessedLedger,
    dataAgeMs,
    maxAgeMs,
  );
  if (records.length === 0) {
    return {
      kind: "empty",
      source: REPUTATION_HISTORY_SOURCE,
      sourceLabel: REPUTATION_HISTORY_SOURCE_LABEL,
      freshness,
    };
  }
  return {
    kind: "records",
    source: REPUTATION_HISTORY_SOURCE,
    sourceLabel: REPUTATION_HISTORY_SOURCE_LABEL,
    freshness,
    records,
  };
}
