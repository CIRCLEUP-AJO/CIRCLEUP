/**
 * Per-member round participation summary.
 *
 * Produces a per-round status for a single member derived from the already-
 * paginated rounds data loaded by CircleDetailClient. No additional fetch is
 * needed — this is a pure client-side aggregation over existing data.
 *
 * Status precedence when a round has both a contribution record AND a default
 * record for the same member (malformed or replayed source data):
 *   → "inconsistent" is surfaced explicitly. The UI must show both records
 *     rather than silently choosing one. Users are directed to the contract
 *     as the authoritative source.
 *
 * Design constraints:
 *   - Pure: no I/O, no React, no DOM.
 *   - Read-only: no transaction execution. Contract state remains authoritative.
 *   - Bounded: processes only the rounds already in memory — never fetches more.
 *   - Explicitly nullable fields: "not yet recorded" is distinct from "no data".
 */

import type {
  CircleRound,
  CircleApiStatus,
  ContributionRecord,
  DefaultRecord,
} from "./circleTypes";

// ─── Round status ─────────────────────────────────────────────────────────────

/**
 * Status of a single round from a specific member's perspective.
 *
 * | Status          | Meaning                                                  |
 * |-----------------|----------------------------------------------------------|
 * | contributed     | Member's contribution record confirmed in this round     |
 * | received        | Member was the payout recipient for this round           |
 * | defaulted       | Member was marked as defaulted for this round            |
 * | inconsistent    | Both contribution AND default records present (conflict) |
 * | not_yet_recorded| Round is current/open — no settled evidence yet          |
 * | not_obligated   | Member had no obligation this round (payee exclusion)    |
 * | unavailable     | Round was cancelled before settling                      |
 * | unknown         | Round data missing or status unrecognised                |
 */
export type MemberRoundStatus =
  | "contributed"
  | "received"
  | "defaulted"
  | "inconsistent"
  | "not_yet_recorded"
  | "not_obligated"
  | "unavailable"
  | "unknown";

/** Human-readable labels for each member round status. */
export const MEMBER_ROUND_STATUS_LABELS: Record<MemberRoundStatus, string> = {
  contributed:       "Contributed",
  received:          "Received payout",
  defaulted:         "Defaulted",
  inconsistent:      "Inconsistent records",
  not_yet_recorded:  "Not yet recorded",
  not_obligated:     "Not obligated (payee)",
  unavailable:       "Cancelled",
  unknown:           "Unknown",
};

/** Accessible description for each status. */
export const MEMBER_ROUND_STATUS_DESCRIPTIONS: Record<MemberRoundStatus, string> = {
  contributed:
    "This member made their contribution for this round. Confirmed by indexed data.",
  received:
    "This member was the payout recipient for this round. They received the full pot.",
  defaulted:
    "This member was marked as defaulted for this round. A penalty was deducted from their collateral.",
  inconsistent:
    "Both a contribution record and a default record exist for this member in this round. " +
    "This may indicate replayed or malformed source data. Refer to the contract for the authoritative state.",
  not_yet_recorded:
    "This round has not settled yet. The member's participation will appear once the round is indexed.",
  not_obligated:
    "This member was the payout recipient for this round and was not expected to contribute.",
  unavailable:
    "This round was cancelled before it could settle. No contribution was required.",
  unknown:
    "Round data is unavailable or the status is not recognised.",
};

// ─── Per-round summary entry ──────────────────────────────────────────────────

export interface MemberRoundEntry {
  /** 0-based round index. */
  readonly roundIndex: number;
  /** Derived participation status for this member in this round. */
  readonly status: MemberRoundStatus;
  /**
   * Contribution record for this member in this round, if one exists.
   * Present for "contributed" and "inconsistent" statuses.
   */
  readonly contributionRecord: ContributionRecord | null;
  /**
   * Default record for this member in this round, if one exists.
   * Present for "defaulted" and "inconsistent" statuses.
   */
  readonly defaultRecord: DefaultRecord | null;
  /**
   * Payout amount in stroops when status === "received". Null otherwise.
   */
  readonly payoutAmountStroops: string | null;
  /**
   * Transaction hash for the payout, when status === "received". Null otherwise.
   */
  readonly payoutTxHash: string | null;
  /**
   * Whether this entry comes from a settled (completed) round. False for
   * current, open, or cancelled rounds.
   */
  readonly isSettled: boolean;
  /**
   * Freshness advisory — always present, since data comes from the indexer
   * and may lag the chain.
   */
  readonly freshnessNote: string;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface MemberRoundSummaryResult {
  /** Member address this summary is for. */
  readonly memberAddress: string;
  /** Per-round entries, sorted by roundIndex ascending. */
  readonly entries: MemberRoundEntry[];
  /** Number of rounds with "inconsistent" status. */
  readonly inconsistentCount: number;
  /** Circle lifecycle status at computation time. */
  readonly circleStatus: CircleApiStatus;
  /**
   * Indexer lag advisory — always non-null. Must be shown alongside any
   * display of this data.
   */
  readonly indexerLagNote: string;
}

// ─── Computation ─────────────────────────────────────────────────────────────

const FRESHNESS_NOTE =
  "Derived from indexed data. May lag the chain by one or more ledgers. " +
  "The contract is the authoritative source for round participation.";

/**
 * Compute a per-round participation summary for a single member.
 *
 * Pure function — takes pre-fetched rounds data, returns typed summary.
 */
export function computeMemberRoundSummary(
  memberAddress: string,
  rounds: readonly CircleRound[],
  circleStatus: CircleApiStatus,
): MemberRoundSummaryResult {
  let inconsistentCount = 0;

  const entries: MemberRoundEntry[] = rounds.map((round): MemberRoundEntry => {
    const isSettled = round.status === "completed";
    const isCancelled = round.status === "cancelled";
    const isCurrent = round.status === "current" || round.status === "open";

    // Recipient check
    const isRecipient = round.recipient === memberAddress;
    if (isRecipient && isSettled) {
      return {
        roundIndex: round.roundIndex,
        status: "received",
        contributionRecord: null,
        defaultRecord: null,
        payoutAmountStroops: round.amount ?? null,
        payoutTxHash: round.txHash ?? null,
        isSettled,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    // If payee but not yet settled, treat as not_obligated
    if (isRecipient) {
      return {
        roundIndex: round.roundIndex,
        status: "not_obligated",
        contributionRecord: null,
        defaultRecord: null,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    // Cancelled round
    if (isCancelled) {
      return {
        roundIndex: round.roundIndex,
        status: "unavailable",
        contributionRecord: null,
        defaultRecord: null,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled: false,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    // Current / open round — not yet settled
    if (isCurrent) {
      return {
        roundIndex: round.roundIndex,
        status: "not_yet_recorded",
        contributionRecord: null,
        defaultRecord: null,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled: false,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    // Settled round — check contribution and default records
    const contributed = round.contributions.find(
      (c) => c.member_address === memberAddress,
    ) ?? null;
    const defaulted = round.defaults.find(
      (d) => d.member_address === memberAddress,
    ) ?? null;

    // Both records present: inconsistency
    if (contributed !== null && defaulted !== null) {
      inconsistentCount++;
      return {
        roundIndex: round.roundIndex,
        status: "inconsistent",
        contributionRecord: contributed,
        defaultRecord: defaulted,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    if (defaulted !== null) {
      return {
        roundIndex: round.roundIndex,
        status: "defaulted",
        contributionRecord: null,
        defaultRecord: defaulted,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    if (contributed !== null) {
      return {
        roundIndex: round.roundIndex,
        status: "contributed",
        contributionRecord: contributed,
        defaultRecord: null,
        payoutAmountStroops: null,
        payoutTxHash: null,
        isSettled,
        freshnessNote: FRESHNESS_NOTE,
      };
    }

    // Settled round with no evidence for this member
    return {
      roundIndex: round.roundIndex,
      status: "unknown",
      contributionRecord: null,
      defaultRecord: null,
      payoutAmountStroops: null,
      payoutTxHash: null,
      isSettled,
      freshnessNote: FRESHNESS_NOTE,
    };
  });

  entries.sort((a, b) => a.roundIndex - b.roundIndex);

  return {
    memberAddress,
    entries,
    inconsistentCount,
    circleStatus,
    indexerLagNote: FRESHNESS_NOTE,
  };
}
