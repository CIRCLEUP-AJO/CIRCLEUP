/**
 * Member participation summary — precise semantics with lifecycle examples.
 *
 * # Metric definitions
 *
 * ## contributionCount
 * The number of rounds in which the member made a timely contribution.
 * Counts only rounds whose status is "completed" AND where the member's
 * address appears in the round's contributions list.
 *
 * The member who is the payee of a given round is NOT expected to contribute
 * that round — their payout_order equals the round index. That round is
 * excluded from the contribution obligation count.
 *
 * ## defaultCount
 * The number of rounds where the member's address appears in the round's
 * defaults list. Counted across all rounds with status "completed" where the
 * member was not the payee.
 *
 * ## receivedCount / receivedAmountStroops
 * The number of rounds where the member was the payout recipient
 * (round.recipient === member.member_address AND round.status === "completed").
 * Amount is the exact sum of round.amount for each such round, in stroops.
 *
 * ## contributedAmountStroops
 * The exact sum of contribution amounts for each round the member contributed
 * to, in stroops (bigint to prevent floating-point loss). Sourced from
 * round.contributions[].amount.
 *
 * ## settledRoundCount
 * Rounds where a payout occurred (status === "completed"). The in-progress
 * "current" round is excluded. Cancelled rounds that did not reach payout
 * are excluded.
 *
 * # Lifecycle semantics
 *
 * ## Active circle
 * The in-progress round (the round with status === "current") is excluded
 * from all settled metrics. Only completed rounds count. The indexer may lag
 * the chain — indexerLagNote is always non-null.
 *
 * ## Completed circle
 * All rounds count; status === "completed". indexerLagNote remains set
 * because the final round settlement event may not yet be indexed.
 *
 * ## Cancelled circle
 * Rounds that completed payout before the cancellation count. The cancelled
 * round (status === "cancelled") is excluded from defaults: a member who did
 * not contribute to a cancelled round is NOT a defaulter — the circle ended.
 *
 * ## Pending circle
 * No rounds exist yet. All counts are zero.
 *
 * # Double-counting prevention
 * Each round is processed at most once per member. The payee status check is
 * applied before counting contributions and defaults, so a payee round is
 * never also counted as a contribution obligation.
 */

import type { CircleRound, CircleMember, CircleApiStatus, ContributionRecord, DefaultRecord } from "./circleTypes";

// ─── Summary type ─────────────────────────────────────────────────────────────

/**
 * Aggregated participation summary for a single member in a single circle.
 *
 * All amounts are in stroops (1 USDC = 10_000_000 stroops), represented as
 * bigint to prevent floating-point accumulation errors across many rounds.
 */
export interface MemberParticipationSummary {
  /**
   * Number of completed rounds where the member made a timely contribution.
   * Rounds where the member was the payee are excluded (they receive, not pay).
   */
  readonly contributionCount: number;

  /**
   * Exact total of contributions made, in stroops.
   * Zero when contributionCount is zero.
   */
  readonly contributedAmountStroops: bigint;

  /**
   * Number of completed rounds where the member was marked as defaulted.
   * Cancelled rounds are excluded (failure to contribute to a cancelled round
   * is not a default).
   */
  readonly defaultCount: number;

  /**
   * Number of rounds where this member received the payout.
   */
  readonly receivedCount: number;

  /**
   * Exact total received as payout recipient, in stroops.
   * null when the member has not yet received any payout.
   */
  readonly receivedAmountStroops: bigint | null;

  /**
   * Number of rounds that reached a payout settlement (status === "completed").
   * Excludes the in-progress round and cancelled rounds that did not settle.
   */
  readonly settledRoundCount: number;

  /**
   * Current lifecycle phase of the circle.
   *
   *   "pending"   — circle has not started; all counts are zero.
   *   "active"    — circle is running; data may lag chain state.
   *   "completed" — all rounds settled; data is final (subject to indexer lag).
   *   "cancelled" — circle was cancelled; only pre-cancellation rounds counted.
   */
  readonly circleLifecycle: "pending" | "active" | "completed" | "cancelled";

  /**
   * Non-null when data comes from the indexer and may be behind the chain.
   * Always shown in any UI that displays this summary, as required by the
   * acceptance criteria for Issue #695.
   */
  readonly indexerLagNote: string;
}

// ─── Input type ───────────────────────────────────────────────────────────────

/**
 * All inputs required to compute a member participation summary.
 */
export interface MemberSummaryInput {
  /** The member record from the indexer. */
  readonly member: CircleMember;
  /**
   * All rounds for this circle from GET /circles/:address/rounds.
   * Must include both completed and any open/cancelled rounds.
   */
  readonly rounds: readonly CircleRound[];
  /** Current circle lifecycle status from the indexer. */
  readonly circleStatus: CircleApiStatus;
}

// ─── Computation ─────────────────────────────────────────────────────────────

/**
 * Compute a precise participation summary for a single member.
 *
 * This function is pure — it does not fetch data or access external state.
 * All inputs must be pre-fetched.
 *
 * Lifecycle rules applied:
 *   - Only rounds with status === "completed" contribute to settled metrics.
 *   - The "current" (in-progress) round is always excluded.
 *   - The "cancelled" round is excluded from defaults.
 *   - A round where member.member_address === round.recipient counts toward
 *     receivedCount/receivedAmountStroops but NOT toward contribution obligations.
 *
 * Amounts are accumulated as bigint to prevent floating-point precision loss
 * across many rounds.
 */
export function computeMemberSummary(input: MemberSummaryInput): MemberParticipationSummary {
  const { member, rounds, circleStatus } = input;
  const memberAddr = member.member_address;

  let contributionCount = 0;
  let contributedAmountStroops = BigInt(0);
  let defaultCount = 0;
  let receivedCount = 0;
  let receivedAmountStroops: bigint | null = null;
  let settledRoundCount = 0;

  for (const round of rounds) {
    if (round.status !== "completed") {
      continue;
    }

    settledRoundCount++;

    const isPayee = round.recipient === memberAddr;

    if (isPayee) {
      receivedCount++;
      if (round.amount != null) {
        const amt = safeBigInt(round.amount);
        receivedAmountStroops = (receivedAmountStroops ?? BigInt(0)) + amt;
      }
      continue;
    }

    const contributed = round.contributions.some(
      (c: ContributionRecord) => c.member_address === memberAddr,
    );
    if (contributed) {
      contributionCount++;
      const myContribution = round.contributions.find(
        (c: ContributionRecord) => c.member_address === memberAddr,
      );
      if (myContribution) {
        contributedAmountStroops += safeBigInt(myContribution.amount);
      }
    }

    const defaulted = round.defaults.some(
      (d: DefaultRecord) => d.member_address === memberAddr,
    );
    if (defaulted) {
      defaultCount++;
    }
  }

  return {
    contributionCount,
    contributedAmountStroops,
    defaultCount,
    receivedCount,
    receivedAmountStroops: receivedAmountStroops,
    settledRoundCount,
    circleLifecycle: mapLifecycle(circleStatus),
    indexerLagNote: buildLagNote(circleStatus),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapLifecycle(
  status: CircleApiStatus,
): MemberParticipationSummary["circleLifecycle"] {
  switch (status) {
    case "Pending": return "pending";
    case "Active":  return "active";
    case "Completed":
    case "Closed":  return "completed";
    case "Cancelled": return "cancelled";
    default: return "active";
  }
}

function buildLagNote(status: CircleApiStatus): string {
  switch (status) {
    case "Pending":
      return "Circle has not started. No participation data yet.";
    case "Active":
      return (
        "This summary is derived from indexed history and may lag the chain by " +
        "one or more ledgers. The in-progress round is not counted until it settles."
      );
    case "Completed":
    case "Closed":
      return (
        "This summary reflects indexed history. Final round settlement may not " +
        "yet be reflected if the indexer is still processing recent ledgers."
      );
    case "Cancelled":
      return (
        "This summary counts only rounds that completed payout before cancellation. " +
        "Failure to contribute to the cancelled round is not recorded as a default."
      );
    default:
      return "Data sourced from indexer history and may lag chain state.";
  }
}

function safeBigInt(value: string | null | undefined): bigint {
  if (value == null || value.trim() === "") return BigInt(0);
  try {
    return BigInt(value.trim());
  } catch {
    return BigInt(0);
  }
}
