// app/src/lib/circleDetailHelpers.ts
//
// Pure helper functions extracted from CircleDetailClient.tsx to reduce its LOC.
// No React hooks or state — these are safe to unit test in isolation.

import type { CircleMember, ContributionRecord, CircleDetailData, CircleRound } from "@/lib/circleTypes";
function getMemberContributionStatus(
  member: CircleMember,
  currentRound: number,
  status: string,
  /** Authoritative contribution list for the current round (from indexer /rounds endpoint). */
  currentRoundContributions: ContributionRecord[] | null,
): "contributed" | "pending" | "defaulted" | "not_applicable" {
  if (status !== "Active") return "not_applicable";

  // The current recipient receives the pot GÇö they are not a contributor this round.
  if (member.payout_order === currentRound) return "not_applicable";

  // Issue #498: prefer the authoritative contributions list when available.
  if (currentRoundContributions !== null) {
    const hasContributed = currentRoundContributions.some(
      (c) => c.member_address === member.member_address,
    );
    if (hasContributed) return "contributed";
    // If they haven't contributed and have at least one default recorded, show
    // "defaulted" so the organiser sees who to mark default against.
    if (member.defaults > 0) return "defaulted";
    return "pending";
  }

  // Fallback when currentRound data is not yet available (partial data state).
  // total_contributions is a cumulative count; a value strictly greater than
  // currentRound means they've contributed at least once in this round.
  if (Number(member.total_contributions) > currentRound) return "contributed";
  if (member.defaults > 0) return "defaulted";
  return "pending";
}

// GöÇGöÇGöÇ Type-safe parsers for indexer API responses (Issue #496, #513) GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// All parsers (parseContributionRecord, parseDefaultRecord, parseCircleRound,
// parsePendingDefault, parseCircleState) have been moved to lib/circleTypes.ts
// and are imported above. This ensures a single implementation is shared by
// both the server page and this client component.

// GöÇGöÇGöÇ fetchCircleData GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// Shared fetch logic used both by the initial SSR prop and the client-side
// manual refresh. Returns the merged data or an error discriminant.
//
// Error kinds:
//   "not_found" GÇö indexer returned 404 (circle does not exist).
//   "network"   GÇö fetch threw (offline, DNS failure, CORS).
//   "server"    GÇö indexer returned 5xx or non-ok non-404.
//   "misconfigured" GÇö NEXT_PUBLIC_INDEXER_URL is unusable; nothing was fetched.
//                 Kept apart from "not_found": a relative URL would otherwise
//                 hit this Next app, 404, and claim the circle was deleted.

export type RefreshError = "not_found" | "network" | "server" | "misconfigured";

export type RefreshResult =
  | { ok: true; data: CircleDetailData; fetchedAtMs: number }
  | { ok: false; error: RefreshError };

// --- Timeline event builder ---------------------------------------------------
//
// Synthesises raw-event-shaped objects from the already-loaded rounds data so
// CircleTimeline can render a chronological view without an additional fetch.
// Each round produces events for join actions, contributions, defaults, and
// payout — all derived from what the indexer already returned.

function buildTimelineEvents(data: CircleDetailData): unknown[] {
  const events: unknown[] = [];

  const allRounds = [
    ...data.rounds,
    ...data.openRounds,
    ...(data.currentRound ? [data.currentRound] : []),
  ];

  for (const round of allRounds) {
    // Contributions
    for (const contrib of round.contributions) {
      events.push({
        type: "circle_contribute",
        actor: contrib.member_address,
        round: round.roundIndex,
        amount: contrib.amount,
        tx_hash: contrib.tx_hash,
        ledger: null,
        event_position: null,
        timestamp: null,
      });
    }
    // Defaults
    for (const def of round.defaults) {
      events.push({
        type: "circle_default",
        actor: def.member_address,
        round: round.roundIndex,
        penalty: def.penalty,
        tx_hash: null,
        ledger: null,
        event_position: null,
        timestamp: null,
      });
    }
    // Payout
    if (round.status === "completed" && round.recipient) {
      events.push({
        type: "circle_payout",
        actor: round.recipient,
        round: round.roundIndex,
        amount: round.amount,
        tx_hash: round.txHash,
        ledger: null,
        event_position: null,
        timestamp: null,
      });
    }
  }

  return events;
}

