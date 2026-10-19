/**
 * Centralized user-facing message catalog for CircleUp.
 *
 * # Purpose
 *
 * Scattered string literals across components make translation review,
 * terminology consistency, and copy updates error-prone. This catalog is the
 * single source of truth for every string that a user reads.
 *
 * # Structure
 *
 * Messages are grouped into namespaces matching the domain:
 *
 *   MSG.wallet      — wallet connection, rejection, and permission prompts
 *   MSG.tx          — transaction lifecycle labels (loading, success per action)
 *   MSG.dataState   — data-freshness banners (stale, partial, refresh failures)
 *   MSG.lifecycle   — circle lifecycle workflow explanations
 *
 *   DIAGNOSTICS     — technical detail strings intentionally kept separate.
 *                     Never display a DIAGNOSTICS value directly to end users;
 *                     log it or pass it to the DiagnosticsPanel only.
 *
 * # Placeholder rules
 *
 * Plain string fields carry no placeholders. When a message requires dynamic
 * values, the entry is a typed function — TypeScript enforces that all required
 * parameters are supplied at the call site. Omitting a required parameter is a
 * compile-time error.
 *
 * # Stability
 *
 * Keys are stable once shipped. Add new keys by extending; never rename or
 * remove a key used by a rendered component without updating every call site.
 */

// ─── Action key type (mirrors CircleDetailClient ActionKey) ───────────────────

export type ActionKey = "join" | "contribute" | "payout" | "default" | "close";

// ─── Wallet messages ──────────────────────────────────────────────────────────

export const WALLET_MSGS = {
  /** Shown before wallet state is known (before getWalletAddress resolves). */
  connectPrompt: "Connect your wallet to interact.",
  /** Inline error when an action is attempted with no wallet address. */
  notConnectedError: "Connect your wallet first.",
  /** Shown when the wallet extension is absent. */
  notInstalled: "Freighter wallet is not installed. Visit https://freighter.app to install it.",
  /** Shown when the user dismisses the Freighter signing prompt. */
  rejected: "You cancelled the transaction in Freighter. No funds were moved.",
  /** Shown when wallet access was denied in Freighter. */
  permissionDenied: "Wallet access was denied. Please approve the connection in Freighter and try again.",
} as const;

// ─── Transaction lifecycle messages ───────────────────────────────────────────

/**
 * Loading spinner labels shown while a transaction is in flight.
 * Used as aria-labels and visible spinner text.
 */
export const TX_LOADING: Record<ActionKey, string> = {
  join:       "Locking collateral…",
  contribute: "Submitting contribution…",
  payout:     "Triggering payout…",
  default:    "Marking default…",
  close:      "Releasing collateral…",
};

/**
 * Success banner messages shown after a transaction confirms on-chain.
 */
export const TX_SUCCESS: Record<ActionKey, string> = {
  join:       "Collateral locked — you have joined the circle!",
  contribute: "Contribution submitted successfully.",
  payout:     "Payout triggered successfully.",
  default:    "Member marked as defaulted.",
  close:      "Collateral released successfully.",
};

/**
 * Parameterized message shown after a default action succeeds.
 * Both parameters are required — TypeScript rejects calls that omit either.
 *
 * @param shortAddr  Short-formatted member address (e.g. "GABC…XYZ").
 * @param round      The round index that was defaulted.
 */
export function txDefaultSuccess(shortAddr: string, round: number): string {
  return `${shortAddr} marked as defaulted for round ${round}.`;
}

/**
 * Parameterized inline error for an invalid circle address.
 * Used as a defence-in-depth guard before any contract call.
 *
 * @param shortAddr  The short-formatted address that failed validation.
 */
export function invalidCircleAddress(shortAddr: string): string {
  return (
    `Invalid circle address “${shortAddr}”. ` +
    "Expected a C-prefixed 56-character Soroban contract ID."
  );
}

// ─── Data state messages ──────────────────────────────────────────────────────

/**
 * Messages used in stale/partial data banners and manual refresh error handling.
 * Callers should use these constants rather than inline strings.
 */
export const DATA_STATE_MSGS = {
  /** Inline guard error when an action is attempted on stale data. */
  staleGuard:
    "Circle data is out of date. Please refresh the page before submitting a transaction.",
  /** Inline guard error when an action is attempted on partial data. */
  partialGuard:
    "Circle data is still loading. Please wait a moment and try again.",
  /** Guard for the mark-default flow specifically. */
  staleDefaultGuard:
    "Circle data is out of date. Please refresh before marking a default.",
  /** Guard for the mark-default flow on partial data. */
  partialDefaultGuard:
    "Circle data is still loading. Wait a moment and try again.",

  /** Refresh failure messages keyed by RefreshError kind. */
  refreshErrors: {
    not_found:
      "This circle no longer exists on the indexer. The page may be out of date.",
    network:
      "Could not reach the indexer. Check your connection and try again.",
    server:
      "The indexer returned an error. This is likely temporary — try again.",
    misconfigured:
      "NEXT_PUBLIC_INDEXER_URL is not set or is not a valid URL, so the page cannot refresh. " +
      "Set a valid indexer URL in app/.env.local and restart the server.",
  } as Record<string, string>,
} as const;

// ─── Reputation page messages ─────────────────────────────────────────────────

export const REPUTATION_MSGS = {
  loading: "Loading reputation…",
  noRecord: "No reputation record found.",
  noRecordDetail: "This address has no on-chain activity in CircleUp yet.",
  refreshing: "Refreshing…",
  retryLabel: "Try again",
  refreshLabel: "Refresh",
  scoreDescription: "Total reputation score",
  scoreByEvents: "Signed sum of all reputation events.",
  scoreByContract: "On-chain reputation score recorded by contract.",
  eventsHeading: "Reputation events",
  noEvents: "No reputation events recorded.",

  /** Inline error messages keyed by FetchResult.reason. */
  fetchErrors: {
    network:
      "The reputation service is unreachable. Check your connection and try again.",
    unknown:
      "An unexpected error occurred loading reputation data.",
    indexer_outage:
      "The indexer is running but currently degraded. Reputation data may be temporarily unavailable. Try again in a few minutes.",
    misconfigured:
      "NEXT_PUBLIC_INDEXER_URL is not set or is not a valid URL. " +
      "Set a valid indexer URL in app/.env.local and restart the server.",
    malformed:
      "Malformed reputation data received from server. The response payload structure is invalid.",
  } as Record<string, string>,
} as const;

// ─── Diagnostics (technical — not for direct user display) ───────────────────

/**
 * Technical diagnostic strings.
 *
 * NEVER render these directly in user-visible banners or toasts.
 * Pass them to the DiagnosticsPanel or write them to the console only.
 */
export const DIAGNOSTICS = {
  /** Prefix for all console/debug log entries from the telemetry layer. */
  telemetryLogPrefix: "[circleup:telemetry]",
  /** Label used when an indexer checkpoint timestamp is absent. */
  missingCheckpoint: "no checkpoint data · source: absent",
  /** Label used when a checkpoint timestamp cannot be parsed. */
  unparseableCheckpoint: "unparseable timestamp · source: indexer_response",
} as const;
