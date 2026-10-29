"use client";
import { indexerFetch } from "@/lib/indexerFetch";
import { useState, useEffect, useRef, useCallback } from "react";
import { Address, xdr } from "@stellar/stellar-sdk";
import { getWalletAddress, invokeContract, type LocalCancelResult } from "@/lib/stellar";
import { shortAddress, formatUsdc, indexerEndpoint, getExplorerLink, ACTIVE_NETWORK, NETWORK_PASSPHRASE } from "@/lib/config";
import { leaseKey, tryAcquireLease, releaseLease } from "@/lib/actionLease";
import { subscribeIndexerUpdates } from "@/lib/indexerUpdates";
import { parseMemberRows } from "@/lib/members";
import { isSorobanContractId } from "@/lib/address";
import { parseContractError, userMessageForError, type ContractAppError } from "@/lib/contractErrors";
import {
  buildAppSnapshot,
  computeActionEligibility,
  isGateBlocked,
  type NetworkCheckState,
} from "@/lib/gating";
import {
  checkNetworkMismatch,
  describeNetworkMismatch,
  type NetworkMismatchResult,
} from "@/lib/walletCapabilities";
import { ReputationBadge } from "@/components/ReputationBadge";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { observeWalletChanges } from '@/lib/walletIdentity';
import { useDeploymentVerified, deploymentVerified } from '@/lib/deploymentState';
import clsx from "clsx";
import { classifyFreshness, formatSourceLabel } from "@/lib/fieldSource";
import {
  TX_LOADING,
  TX_SUCCESS,
  txDefaultSuccess,
  invalidCircleAddress,
  DATA_STATE_MSGS,
} from "@/lib/messages";
// GöÇGöÇGöÇ Shared response contracts (Issue #513) GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// All circle API types and runtime parsers now live in lib/circleTypes.ts,
// which is the single source of truth for the app layer. They mirror the
// canonical Api* types in sdk/src/types.ts.
import {
  type CircleMember,
  type ContributionRecord,
  type DefaultRecord,
  type CircleRound,
  type CircleState,
  type CircleDetailData,
  parseCircleRow,
  parseCircleState,
  parseCircleRound,
  parsePendingDefault,
  parseRoundsResponse,
} from "@/lib/circleTypes";

// Re-export the types that page.tsx and test files import directly from this module.
export type { CircleMember, ContributionRecord, DefaultRecord, CircleRound, CircleState, CircleDetailData };
// CirclePendingDefault was a distinct interface in the old code; it is now
// identical to DefaultRecord (both are { member_address, penalty }) and unified
// under PendingDefault in circleTypes.ts. The alias keeps downstream imports
// building without changes.
export type { PendingDefault as CirclePendingDefault } from "@/lib/circleTypes";

// --- Feature panels (Issues: join intro, timeline, member round summary) ------
import { buildJoinIntroContent } from "@/lib/joinIntro";
import { JoinIntroBanner } from "@/components/JoinIntroBanner";
import { CircleTimeline } from "@/components/CircleTimeline";
import { computeMemberRoundSummary } from "@/lib/memberRoundSummary";
import { MemberRoundSummary } from "@/components/MemberRoundSummary";

// --- Extracted sub-components --------------------------------------------------
import { RoundDeadlineStatus } from "@/components/RoundDeadlineStatus";
import { PartialDataBanner } from "@/components/PartialDataBanner";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { MemberListFallback } from "@/components/MemberListFallback";
import { RoundCard } from "@/components/RoundCard";
import { ContributionStatusBadge } from "@/components/ContributionStatusBadge";

import { WorkflowBanner } from "@/components/WorkflowBanner";
interface Props {
  circleAddress: string;
  circleData: CircleDetailData;
}

// GöÇGöÇGöÇ Action key type GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

type ActionKey = "join" | "contribute" | "payout" | "default" | "close";

// GöÇGöÇGöÇ Success state shape GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

interface SuccessState {
  message: string;
  txHash?: string;
}

// GöÇGöÇGöÇ Data-refresh state GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// "idle"      GÇö no refresh in flight.
// "refreshing" GÇö post-action background refresh is running.
// "error"     GÇö refresh failed after a successful action; data may be stale.

type RefreshState = "idle" | "refreshing" | "error";

// GöÇGöÇGöÇ Wallet load state GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// Distinct from walletAddress === null, which conflates "still loading" with
// "genuinely not connected". Action buttons must not render until we know
// definitively which case we're in.
//
// "loading"     GÇö getWalletAddress() has not resolved yet.
// "connected"   GÇö wallet is installed and an address was returned.
// "disconnected" GÇö wallet is installed but no address (not connected).
// "not_installed" GÇö Freighter extension is absent.

type WalletLoadState = "loading" | "connected" | "disconnected" | "not_installed";

// GöÇGöÇGöÇ Data completeness state GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// Tracks whether the data passed in (or updated via refresh) has all fields
// required for safe action-gating. This is separate from network errors GÇö it
// describes the *content* of a successful response.
//
// "ready"     GÇö all required fields are present and non-empty.
// "partial"   GÇö data is present but some fields are missing (members[], latestLedger,
//               currentRound). Actions are blocked until a refresh fills the gaps.
// "stale"     GÇö the data was last fetched more than MAX_DATA_AGE_MS ago.
//               The user sees a banner and must explicitly refresh.
// "refreshing" GÇö a manual refresh is in flight (data from prop is kept visible).

export type DataReadiness = "ready" | "partial" | "stale" | "refreshing";

// GöÇGöÇGöÇ Contribution receipt GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

interface ContributionReceipt {
  amount: string;
  roundIndex: number;
  txHash: string;
  explorerUrl: string | null;
}

// GöÇGöÇGöÇ Default confirmation GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

interface DefaultConfirmState {
  memberAddress: string;
  roundIndex: number;
}

// GöÇGöÇGöÇ Copy feedback GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

type CopyState = "idle" | "success" | "error";

// GöÇGöÇGöÇ Constants GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// Re-exported from lib/deadline.ts so the page-level staleness threshold and
// the deadline display model share a single source of truth.
import {
  DEADLINE_MAX_DATA_AGE_MS as MAX_DATA_AGE_MS,
} from "@/lib/deadline";
export { DEADLINE_MAX_DATA_AGE_MS as MAX_DATA_AGE_MS } from "@/lib/deadline";

// GöÇGöÇGöÇ Helpers GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

/**
 * Compute the data readiness from the current data snapshot and the timestamp
 * at which data was last successfully fetched.
 *
 * "ready"   GÇö members loaded, latestLedger known, currentRound available (or
 *             circle is not Active so currentRound is not required).
 * "partial" GÇö members empty OR (circle is Active AND currentRound is null).
 *
 * Staleness is checked separately against fetchedAtMs in the render path.
 */
export function computeDataReadiness(
  data: CircleDetailData,
): "ready" | "partial" {
  // Members are required for all membership-gated actions
  if (data.members.length === 0) return "partial";

  // For an Active circle, currentRound must be present so we can accurately
  // determine who has contributed (avoid the heuristic fallback).
  if (data.circle.status === "Active" && data.currentRound == null) {
    return "partial";
  }

  return "ready";
}

/** Returns true when the error looks like a timeout or network failure worth retrying. */
function isRetryableError(err: string): boolean {
  const lower = err.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("connection") ||
    lower.includes("rpc") ||
    lower.includes("temporarily unavailable")
  );
}
// GöÇGöÇGöÇ WorkflowBanner GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// Issue #497: Inline workflow explanations for join and contribute actions.
//
// The banner contextualises the action buttons so users understand:
//   GÇó What the action does (semantics, not just the button label)
//   GÇó What will happen on-chain (collateral, pot pooling, rotation)
//   GÇó What the outcome will be for them personally
//   GÇó Any prerequisites they need to be aware of
//
// Each case is distinct and complete. The banners are intentionally verbose GÇö
// a savings-circle user may be new to on-chain protocols and needs more than
// a one-liner to make an informed decision about locking real funds.


// GöÇGöÇGöÇ getMemberContributionStatus GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// Issue #498: Improve member contribution state display in rotation order.
//
// The previous implementation relied solely on member.total_contributions,
// a cumulative counter that only updates after the indexer fully processes a
// round. This caused two display bugs:
//
//   1. A member who contributed in round N but whose counter hadn't been
//      incremented yet (indexer lag) showed as "pending" incorrectly.
//   2. A member whose counter overflowed or was reset could show as "pending"
//      for a round they genuinely hadn't contributed to yet.
//
// Fix: when the authoritative currentRound.contributions list is available,
// use it as the primary source of truth. Fall back to the total_contributions
// counter only when currentRound is absent (partial data).
//
// The payout_order === currentRound check is preserved: the current recipient
// is not expected to contribute (they receive the pot) so their row should
// show "waiting" rather than a misleading "pending" badge.

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

export async function fetchCircleData(
  circleAddress: string,
  signal?: AbortSignal,
): Promise<RefreshResult> {
  const circleUrl = indexerEndpoint(["circles", circleAddress]);
  const roundsUrl = indexerEndpoint(["circles", circleAddress, "rounds"]);
  if (circleUrl === null || roundsUrl === null) {
    return { ok: false, error: "misconfigured" };
  }

  let circleRes: Response;
  let roundsRes: Response;

  try {
    [circleRes, roundsRes] = await Promise.all([
      indexerFetch(circleUrl, { cache: "no-store", signal }),
      indexerFetch(roundsUrl, { cache: "no-store", signal }),
    ]);
  } catch (err) {
    // AbortError is not a real failure GÇö the component unmounted during refresh
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: "network" };
    }
    return { ok: false, error: "network" };
  }

  if (circleRes.status === 404) return { ok: false, error: "not_found" };
  if (!circleRes.ok) return { ok: false, error: "server" };

  let circleJson: Record<string, unknown>;
  let roundsJson: Record<string, unknown>;

  try {
    circleJson = (await circleRes.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "server" };
  }

  try {
    roundsJson = roundsRes.ok
      ? ((await roundsRes.json()) as Record<string, unknown>)
      : { rounds: [], openRounds: [], pendingDefaults: [], currentRound: null };
  } catch {
    roundsJson = { rounds: [], openRounds: [], pendingDefaults: [], currentRound: null };
  }

  if (typeof circleJson.circle !== "object" || circleJson.circle === null) {
    return { ok: false, error: "server" };
  }

  // Issue #496 / #513: Use type-safe parsers instead of unsafe `as` casts.
  const circleState = parseCircleState(circleJson.circle);
  if (!circleState) {
    return { ok: false, error: "server" };
  }

  // Members go through the shared all-or-nothing parser (lib/circleTypes.ts) that
  // the server page also uses. A per-row filter is wrong here twice over: the
  // indexer's /circles/:address rows carry no total_contributions and a null
  // reputation_score for members without a reputation row, so a strict per-row
  // check drops every real row; and dropping any single row would shift later
  // members into the wrong payout slot.
  const members = parseMemberRows(circleJson.members);

  // parseRoundsResponse handles all four fields (rounds, openRounds,
  // pendingDefaults, currentRound) with the same null-safe, drop-malformed-rows
  // strategy used by every other parser.
  const roundsPayload = parseRoundsResponse(roundsJson);

  return {
    ok: true,
    fetchedAtMs: Date.now(),
    data: {
      circle: circleState,
      members,
      rounds: roundsPayload.rounds,
      openRounds: roundsPayload.openRounds,
      pendingDefaults: roundsPayload.pendingDefaults,
      latestLedger:
        typeof circleJson.latestLedger === "number"
          ? circleJson.latestLedger
          : null,
      // checkpointTime: ISO-8601 timestamp the indexer embeds to indicate when
      // it last durably processed a ledger. Absent from older indexer versions —
      // callers must treat null as "unknown freshness", never as healthy.
      checkpointTime:
        typeof circleJson.checkpointTime === "string" && circleJson.checkpointTime.trim() !== ""
          ? circleJson.checkpointTime
          : null,
      currentRound: roundsPayload.currentRound,
    },
  };
}

// GöÇGöÇGöÇ Main client component GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

export function CircleDetailClient({ circleAddress, circleData }: Props) {
  // GöÇGöÇ Wallet load state GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // Distinguishes "still loading" from "not connected" so action buttons don't
  // flash on/off during the async wallet check.
  const [walletLoadState, setWalletLoadState] = useState<WalletLoadState>("loading");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState<NetworkMismatchResult | null>(null);

  // GöÇGöÇ Circle data GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  const [data, setData] = useState<CircleDetailData>(circleData);
  useEffect(() => {
    setData(circleData);
  }, [circleData]);

  // Wall-clock timestamp of the last *successful* data fetch.
  // Seeded to Date.now() on mount because circleData comes from a fresh SSR
  // fetch; updated on every successful manual or post-action refresh.
  const [dataFetchedAtMs, setDataFetchedAtMs] = useState<number>(() => Date.now());

  useEffect(() => {
    setData(circleData);
    setDataFetchedAtMs(Date.now());
  }, [circleData]);

  // GöÇGöÇ Action state GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  const [loading,      setLoading]      = useState<ActionKey | null>(null);
  const [errorOperation, setErrorOperation] = useState<string | undefined>(undefined);
  const [error,        setError]        = useState<string>("");
  // Hash of the transaction that produced the current error (set when the
  // failure happened on-chain after submission) so the banner can link to
  // the explorer for full diagnostics (Issue #479).
  const [errorTxHash,  setErrorTxHash]  = useState<string | null>(null);
  // Typed error from the last failed transaction GÇö passed to DiagnosticsPanel
  // so the bundle captures error kind/code without exposing raw internals.
  const [errorTypedError, setErrorTypedError] = useState<ContractAppError | null>(null);
  const [success,      setSuccess]      = useState<SuccessState | null>(null);
  const [retryAction,  setRetryAction]  = useState<(() => void) | null>(null);
  const [refreshState, setRefreshState] = useState<RefreshState>("idle");

  // Issue #499: Guard against concurrent / duplicate submissions.
  // A ref is used (not state) because we need to read it synchronously inside
  // the async action handler without triggering a re-render. When this is true
  // any call to doAction or doDefault is a no-op GÇö the button's `disabled`
  // attribute should have prevented it, but this is defence-in-depth against
  // rapid double-clicks, keyboard repeats, or automated test runners.
  const submittingRef = useRef(false);

  // Issue #654: AbortController for the in-flight invokeContract call.
  // Aborted on component unmount so the polling loop stops promptly and no
  // setState calls fire on an unmounted tree.  A new controller is created
  // for each doAction / doDefault invocation so signals are never reused
  // across separate transactions.
  const txAbortRef = useRef<AbortController | null>(null);

  // GöÇGöÇ UI state GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // inviteUrl is intentionally initialised to null (not "") so that components
  // can distinguish "not yet resolved" from "resolved to an empty string".
  // The value is only ever set inside a useEffect, which never runs during SSR,
  // so window.location is only accessed in the browser GÇö preventing hydration
  // mismatches and SSR crashes caused by the window object being absent on the
  // server.  The input placeholder handles the null state visually.
  const [inviteUrl,           setInviteUrl]           = useState<string | null>(null);
  const [contributionReceipt, setContributionReceipt] = useState<ContributionReceipt | null>(null);
  const [defaultConfirm,      setDefaultConfirm]      = useState<DefaultConfirmState | null>(null);
  const defaultConfirmRef = useRef<HTMLDivElement>(null);
  const defaultConfirmTriggerRef = useRef<HTMLElement | null>(null);
  const [inviteCopyState,     setInviteCopyState]     = useState<CopyState>("idle");
  const [receiptCopyState,    setReceiptCopyState]    = useState<CopyState>("idle");

  const dismissDefaultConfirm = useCallback(() => {
    setDefaultConfirm(null);
    if (defaultConfirmTriggerRef.current && typeof defaultConfirmTriggerRef.current.focus === "function") {
      defaultConfirmTriggerRef.current.focus();
    }
  }, []);

  // Whether a manual refresh (triggered by Stale or Partial banners) is running
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  // Refresh error message when a manual refresh fails
  const [manualRefreshError, setManualRefreshError] = useState<string>("");

  // Issue #797: tracks whether a confirmed tx is still waiting for the
  // indexer to ingest it. Informational only — never implies confirmation.
  // Cleared on the next successful refresh (manual, post-action, or push).
  const [awaitingIndex, setAwaitingIndex] = useState(false);

  // GöÇGöÇ Staleness tracking GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // Re-evaluated every second so the stale banner appears automatically once
  // data ages past MAX_DATA_AGE_MS, even if the user hasn't interacted.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (walletLoadState !== "connected") {
      setNetworkMismatch(null);
      return;
    }

    checkNetworkMismatch(NETWORK_PASSPHRASE)
      .then((result) => {
        if (!cancelled) setNetworkMismatch(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setNetworkMismatch({
            kind: "provider_error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [walletLoadState, walletAddress]);

  // Ref for aborting any in-flight manual or post-action refresh when the
  // component unmounts, preventing setState calls on an unmounted tree.
  const refreshAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      refreshAbortRef.current?.abort();
      // Issue #654: abort any in-flight invokeContract call so the polling
      // loop stops and timers are cleaned up when the component unmounts.
      txAbortRef.current?.abort();
    };
  }, []);

  // Focus management refs
  const errorRegionRef   = useRef<HTMLDivElement>(null);
  const successRegionRef = useRef<HTMLDivElement>(null);

  // GöÇGöÇ Wallet resolution GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  useEffect(() => {
    let generation = 0;
    let disposed = false;
    const resolve = async () => {
      const current = ++generation;
      txAbortRef.current?.abort();
      refreshAbortRef.current?.abort();
      setWalletAddress(null);
      setWalletLoadState('loading');
      setNetworkMismatch(null);
      setDefaultConfirm(null);
      setRetryAction(null);
      setContributionReceipt(null);
      setSuccess(null);
      setError(''); setErrorTypedError(null); setErrorTxHash(null); setErrorOperation(undefined);
      setIsManualRefreshing(false); setRefreshState('idle');
      try {
        const address = await getWalletAddress();
        if (disposed || current !== generation) return;
        setWalletAddress(address);
        setWalletLoadState(address ? 'connected' : 'disconnected');
      } catch {
        if (!disposed && current === generation) setWalletLoadState('not_installed');
      }
    };
    const stop = observeWalletChanges(() => { void resolve(); });
    void resolve();
    return () => { disposed = true; generation++; stop(); };
  }, []);
  // Build the invite URL client-side only.  useEffect never runs on the server,
  // so window.location is guaranteed to exist here GÇö no typeof guard needed.
  // Keeping this in an effect (rather than useMemo) also means the URL is only
  // computed after hydration, preventing any server/client HTML mismatch.
  //
  // Address guard: circleAddress is validated by isSorobanContractId in both
  // the server page (CircleDetailPage notFound() guard) and in doAction /
  // doDefault before any contract call. We repeat the check here so the invite
  // URL is never constructed from a malformed value GÇö the prop is typed as
  // `string` but a caller outside the normal page render path (tests, Storybook)
  // could pass an arbitrary string.
  useEffect(() => {
    if (!isSorobanContractId(circleAddress)) return;
    setInviteUrl(`${window.location.origin}/circles/${circleAddress}`);
  }, [circleAddress]);

  // Focus management
  useEffect(() => {
    if (error && errorRegionRef.current) {
      errorRegionRef.current.focus();
    }
  }, [error]);

  useEffect(() => {
    if (success && successRegionRef.current) {
      successRegionRef.current.focus();
    }
  }, [success]);

  // GöÇGöÇ Derived membership state GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

  const isMember = walletAddress
    ? data.members.some((m) => m.member_address === walletAddress)
    : false;

  const myMember = walletAddress
    ? data.members.find((m) => m.member_address === walletAddress) ?? null
    : null;

  const hasLockedCollateral = myMember
    ? BigInt(myMember.collateral || "0") > BigInt(0)
    : false;

  const currentRound = data.circle.current_round;

  // GöÇGöÇ Contribution check GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // Prefer the authoritative currentRound contributions list when available.
  // When it is absent (partial data), conservatively treat the contribution as
  // unknown (false) GÇö this means the Contribute button may appear for a member
  // who already contributed, but the gate will block the double-submit.
  // This is safer than the inverse: treating unknown as "already contributed"
  // would hide the button from a member who genuinely needs to contribute.
  //
  // Note: the heuristic fallback (total_contributions > currentRound) that was
  // present before this refactor has been removed. The fallback could allow a
  // second contribution prompt when the indexer hadn't yet incremented the
  // counter. The partial-data state now covers this case explicitly.
  const myContributedThisRound = walletAddress != null && data.currentRound != null
    ? data.currentRound.contributions.some(
        (c) => c.member_address === walletAddress,
      )
    : false;

  // GöÇGöÇ Data readiness GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // "stale" is evaluated from the ticker so it flips in real-time.
  const isDataStale = nowMs - dataFetchedAtMs >= MAX_DATA_AGE_MS;
  const contentReadiness = computeDataReadiness(data);
  const dataReadiness: DataReadiness = isManualRefreshing
    ? "refreshing"
    : isDataStale
    ? "stale"
    : contentReadiness;

  // Actions are only allowed when data is fully ready.
  // This is the single authoritative gate for data completeness.
  const deploymentReady = useDeploymentVerified();
  const actionsEnabled = deploymentReady && dataReadiness === "ready" && walletLoadState === "connected";
  const networkCheck: NetworkCheckState =
    networkMismatch?.kind === "mismatch"
      ? "mismatch"
      : networkMismatch?.kind === "match"
      ? "match"
      : networkMismatch == null
      ? null
      : "unknown";
  const networkWarning = networkMismatch ? describeNetworkMismatch(networkMismatch) : null;
  const myHasLockedCollateral = hasLockedCollateral;

  // GöÇGöÇ Payout gate (for disabled-state display) GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // Pre-computed with maxSnapshotAgeMs: Infinity so the "round not complete"
  // reason shows up in the button caption even when we're not about to submit.
  // The staleness check is intentionally skipped here GÇö it's handled by the
  // actionsEnabled gate above.
  //
  // Guard: when members[] is empty, 0 contributions >= 0 members is
  // mathematically true but semantically wrong. We force block in that case.
  const payoutGate = (() => {
    if (data.members.length === 0) {
      return {
        allowed: false as const,
        reason: "round_not_complete" as const,
        message: "Member data is not yet available. Payout cannot be triggered.",
      };
    }
    return computeActionEligibility(
      "payout",
      buildAppSnapshot(
        data.circle.status,
        currentRound,
        data.circle.deadline_ledger,
        data.latestLedger,
        data.members.map((m) => m.member_address),
        myHasLockedCollateral,
        myContributedThisRound,
        data.currentRound?.contributions.length ?? 0,
        networkCheck,
        dataFetchedAtMs, // use data fetch time, not snapshot build time
      ),
      { maxSnapshotAgeMs: Infinity },
    );
  })();

  // GöÇGöÇ Contribute gate (for disabled-state display) GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // Pre-computed with maxSnapshotAgeMs: Infinity so the "round already
  // contributed" / "deadline passed" reason shows up under the Contribute
  // button even when we're not about to submit. The staleness check is
  // intentionally skipped here GÇö it's handled by the actionsEnabled gate above.
  const contributeGate = computeActionEligibility(
    "contribute",
    buildAppSnapshot(
      data.circle.status,
      currentRound,
      data.circle.deadline_ledger,
      data.latestLedger,
      data.members.map((m) => m.member_address),
      myHasLockedCollateral,
      myContributedThisRound,
      data.currentRound?.contributions.length ?? 0,
      networkCheck,
      dataFetchedAtMs, // use data fetch time, not snapshot build time
    ),
    { maxSnapshotAgeMs: Infinity },
  );
  const joinGate = computeActionEligibility(
    "join",
    buildAppSnapshot(
      data.circle.status,
      currentRound,
      data.circle.deadline_ledger,
      data.latestLedger,
      data.members.map((m) => m.member_address),
      myHasLockedCollateral,
      myContributedThisRound,
      data.currentRound?.contributions.length ?? 0,
      networkCheck,
      dataFetchedAtMs,
    ),
    { maxSnapshotAgeMs: Infinity },
  );
  const closeGate = computeActionEligibility(
    "close",
    buildAppSnapshot(
      data.circle.status,
      currentRound,
      data.circle.deadline_ledger,
      data.latestLedger,
      data.members.map((m) => m.member_address),
      myHasLockedCollateral,
      myContributedThisRound,
      data.currentRound?.contributions.length ?? 0,
      networkCheck,
      dataFetchedAtMs,
    ),
    { maxSnapshotAgeMs: Infinity },
  );

  // True when the indexed latest ledger is past the round deadline
  const deadlinePassed =
    data.circle.deadline_ledger != null &&
    data.latestLedger != null &&
    data.latestLedger > data.circle.deadline_ledger;

  // GöÇGöÇ Manual refresh GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // Used by the Stale and Partial data banners. Updates data in place without
  // a full page reload. On success: updates data + resets fetchedAtMs.
  // On failure: shows a contextual message; existing (stale/partial) data kept
  // visible so the user can still read the page.

  const handleManualRefresh = useCallback(async () => {
    if (isManualRefreshing) return;
    setIsManualRefreshing(true);
    setManualRefreshError("");

    const ctrl = new AbortController();
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = ctrl;

    const result = await fetchCircleData(circleAddress, ctrl.signal);

    if (ctrl.signal.aborted) return; // unmounted during fetch

    if (result.ok) {
      setData(result.data);
      setDataFetchedAtMs(result.fetchedAtMs);
      setManualRefreshError("");
    } else {
      setManualRefreshError(
        DATA_STATE_MSGS.refreshErrors[result.error] ?? DATA_STATE_MSGS.refreshErrors.server,
      );
    }

    setIsManualRefreshing(false);
    setAwaitingIndex(false);
  }, [circleAddress, isManualRefreshing]);

  // Issue #797: bounded push-style discovery of indexed changes. Prefers SSE
  // when NEXT_PUBLIC_INDEXER_EVENTS_URL is set, else bounded polling; both
  // are cancelled on route change/unmount and fall back to manual refresh.
  useEffect(() => {
    if (!awaitingIndex) return;
    const ctrl = new AbortController();
    const streamUrl =
      typeof process.env.NEXT_PUBLIC_INDEXER_EVENTS_URL === "string" &&
      process.env.NEXT_PUBLIC_INDEXER_EVENTS_URL !== ""
        ? `${process.env.NEXT_PUBLIC_INDEXER_EVENTS_URL}?circle=${encodeURIComponent(circleAddress)}`
        : null;
    const sub = subscribeIndexerUpdates({
      circleAddress,
      streamUrl,
      fetchLedger: async () => {
        const r = await fetchCircleData(circleAddress, ctrl.signal);
        return r.ok ? r.data.latestLedger : null;
      },
      onUpdate: () => {
        setAwaitingIndex(false);
        void handleManualRefresh();
      },
      signal: ctrl.signal,
    });
    return () => {
      ctrl.abort();
      sub.stop();
    };
  }, [awaitingIndex, circleAddress, handleManualRefresh]);

  // GöÇGöÇ Post-action refresh GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // Called after every successful contract write. Uses the shared fetchCircleData
  // helper so merging is always safe GÇö we replace the whole data object rather
  // than patching fields, preventing stale sub-object leaks.

  async function postActionRefresh(ctrl: AbortController) {
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = ctrl;
    setRefreshState("refreshing");
    const result = await fetchCircleData(circleAddress, ctrl.signal);

    if (ctrl.signal.aborted) return; // unmounted during refresh

    if (result.ok) {
      setData(result.data);
      setDataFetchedAtMs(result.fetchedAtMs);
      setRefreshState("idle");
      // The immediate re-fetch may predate indexer ingestion; keep watching
      // (bounded) so the page discovers the indexed change without a manual refresh.
      setAwaitingIndex(true);
    } else if (result.error === "network") {
      // Genuine network failure after action GÇö show warning
      setRefreshState("error");
    } else {
      // Non-fatal: the action succeeded, refresh just failed
      setRefreshState("error");
    }
  }

  // GöÇGöÇ Action handler GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

  // Issue #698: Action messages now sourced from the centralized catalog so all
  // user-facing copy is maintained in one place.
  const ACTION_SUCCESS_MESSAGES = TX_SUCCESS;
  const ACTION_LOADING_LABELS   = TX_LOADING;

  async function doAction(action: ActionKey, args: xdr.ScVal[] = []) {
    setErrorOperation(action);
    if (!deploymentVerified() || walletLoadState !== 'connected') { setError('Verify deployment and reconnect your wallet before reviewing this action.'); return; }
    if (!walletAddress) {
      setError("Connect your wallet first.");
      return;
    }

    // Issue #499: Prevent duplicate / concurrent submissions.
    // The buttons are disabled while loading !== null, but this ref guard
    // is a defence-in-depth measure against rapid double-clicks or race
    // conditions where a second invocation begins before the first has
    // flushed the loading state.
    if (submittingRef.current) return;

    // Issue #800: cross-tab UX guard — same network/circle/member/action in
    // another tab shows a notice instead of a second wallet prompt. Contract
    // validation remains authoritative; this never blocks on-chain truth.
    const actionLease = walletAddress
      ? leaseKey({ network: NETWORK_PASSPHRASE, circle: circleAddress, member: walletAddress, action })
      : null;
    if (actionLease && !tryAcquireLease(actionLease)) {
      setError(
        "The same action appears to be in progress in another tab. " +
          "Finish or cancel it there first — this guard expires automatically.",
      );
      return;
    }

    if (!isSorobanContractId(circleAddress)) {
      setError(invalidCircleAddress(shortAddress(circleAddress)));
      return;
    }

    // --- Data completeness guard ----------------------------------------------
    //
    // Even though the buttons are disabled when dataReadiness !== "ready",
    // re-check here as a defence-in-depth measure in case the UI guard is
    // bypassed (e.g. by automated tests, accessibility tools, or race conditions).
    if (dataReadiness !== "ready") {
      setError(
        dataReadiness === "stale"
          ? DATA_STATE_MSGS.staleGuard
          : DATA_STATE_MSGS.partialGuard,
      );
      return;
    }

    setError("");
    setSuccess(null);
    setRetryAction(null);
    setErrorTypedError(null);
    if (action === "contribute") setContributionReceipt(null);

    submittingRef.current = true;
    setLoading(action);

    // Issue #654: create a fresh AbortController for this invocation and
    // store it so the unmount effect can abort it if the component is torn
    // down while signing or polling is in flight.
    const txCtrl = new AbortController();
    txAbortRef.current = txCtrl;

    try {
      // GöÇGöÇ Stale-state gate GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
      //
      // Build the snapshot using dataFetchedAtMs GÇö the timestamp when the
      // data was actually loaded, NOT Date.now(). This is the fix for the
      // critical bug where the old code passed nowMs=Date.now() into
      // buildAppSnapshot, making fetchedAtMs === nowMs and the stale check
      // always pass regardless of how old the data was.
      const currentRoundContributions =
        data.currentRound?.contributions.length ?? 0;

      const snapshot = buildAppSnapshot(
        data.circle.status,
        data.circle.current_round,
        data.circle.deadline_ledger,
        data.latestLedger,
        data.members.map((m) => m.member_address),
        myHasLockedCollateral,
        myContributedThisRound,
        currentRoundContributions,
        networkCheck,
        dataFetchedAtMs, // GåÉ correct: when the data was fetched, not now
      );

      const gate = computeActionEligibility(action, snapshot);
      if (isGateBlocked(gate)) {
        setError(gate.message);
        if (gate.reason === "stale_snapshot") {
          setRetryAction(() => () => doAction(action, args));
        }
        return;
      }

      // GöÇGöÇ Submit transaction GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
      // Pass txCtrl.signal so the polling loop can be stopped promptly when
      // the component unmounts or the user navigates away.
      const result = await invokeContract(
        circleAddress,
        action,
        args,
        walletAddress,
        txCtrl.signal,
      );

      if (txCtrl.signal.aborted) return;
      if (!result.success) {
        const errMsg = result.typedError ? userMessageForError(result.typedError) : userMessageForError(parseContractError(result.error));
        setError(errMsg);
        setErrorTypedError(result.typedError ?? null);
        setErrorTxHash(result.txHash || null);
        if (!result.txHash && isRetryableError(errMsg)) {
          setRetryAction(() => () => doAction(action, args));
        }
      } else {
        setSuccess({
          message: ACTION_SUCCESS_MESSAGES[action],
          txHash: result.txHash,
        });
        if (action === "contribute") {
          setContributionReceipt({
            amount: data.circle.round_amount,
            roundIndex: data.circle.current_round,
            txHash: result.txHash ?? "",
            explorerUrl: result.txHash
              ? getExplorerLink(ACTIVE_NETWORK, "tx", result.txHash)
              : null,
          });
        }

        const ctrl = new AbortController();
        await postActionRefresh(ctrl);
      }
    } catch (err: unknown) {
      if (txCtrl.signal.aborted) return;
      // Issue #654: handle LocalCancelResult throws from invokeContract.
      // These are not transaction failures GÇö they mean the caller stopped
      // waiting.  Silently swallow them when the component is unmounting
      // (txCtrl.signal.aborted); surface a non-blocking advisory when the
      // signal fired *after* the tx was already broadcast.
      if (
        err instanceof Error &&
        err.cause != null &&
        typeof err.cause === "object" &&
        (err.cause as LocalCancelResult).kind === "local_cancel"
      ) {
        const cancelInfo = err.cause as LocalCancelResult;
        if (cancelInfo.submittedBeforeAbort) {
          // Tx may still confirm GÇö show an advisory so the user knows to
          // check the explorer rather than re-submitting immediately.
          setError(
            "You stopped waiting, but the transaction may still confirm on-chain. " +
              "Check the explorer before retrying to avoid a duplicate submission.",
          );
        }
        // submittedBeforeAbort=false means we cancelled cleanly before
        // broadcast GÇö no message needed, just let the UI reset below.
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(userMessageForError(parseContractError(message)));
      setErrorTypedError(parseContractError(message));
      if (isRetryableError(message)) {
        setRetryAction(() => () => doAction(action, args));
      }
    } finally {
      setLoading(null);
      submittingRef.current = false;
      // Issue #800: always release the cross-tab lease so stale locks recover.
      if (actionLease) releaseLease(actionLease);
      // Clear the ref so a stale controller doesn't block future actions.
      if (txAbortRef.current === txCtrl) txAbortRef.current = null;
    }
  }

  // GöÇGöÇ Action shortcuts GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

  const handleJoin       = () => doAction("join",       [new Address(walletAddress!).toScVal()]);
  const handleContribute = () => doAction("contribute", [new Address(walletAddress!).toScVal()]);
  const handlePayout     = () => doAction("payout",     []);
  const handleClose      = () => doAction("close",      [new Address(walletAddress!).toScVal()]);

  // GöÇGöÇ Copy helpers GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

  async function handleCopyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopyState("success");
      setTimeout(() => setInviteCopyState("idle"), 2500);
    } catch {
      setInviteCopyState("error");
      setTimeout(() => setInviteCopyState("idle"), 3000);
    }
  }

  async function handleCopyReceiptHash() {
    if (!contributionReceipt?.txHash) return;
    try {
      await navigator.clipboard.writeText(contributionReceipt.txHash);
      setReceiptCopyState("success");
      setTimeout(() => setReceiptCopyState("idle"), 2500);
    } catch {
      setReceiptCopyState("error");
      setTimeout(() => setReceiptCopyState("idle"), 3000);
    }
  }

  // -- Default flow ----------------------------------------------------------

  function handleMarkDefault(memberAddress: string) {
    if (typeof document !== "undefined") {
      defaultConfirmTriggerRef.current = document.activeElement as HTMLElement | null;
    }
    setDefaultConfirm({ memberAddress, roundIndex: currentRound });
  }

  useEffect(() => {
    if (!defaultConfirm) return;

    const dialog = defaultConfirmRef.current;
    if (dialog) {
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length > 0) {
        focusable[0].focus();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissDefaultConfirm();
        return;
      }

      if (e.key === "Tab" && dialog) {
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [defaultConfirm, dismissDefaultConfirm]);

  async function doDefault(memberAddress: string) {
    setErrorOperation("mark_default");
    if (!deploymentVerified() || walletLoadState !== 'connected') { setError('Verify deployment and reconnect your wallet before reviewing this action.'); return; }
    if (!walletAddress) {
      setError("Connect your wallet first.");
      return;
    }

    // Issue #499: Same duplicate-submission guard as doAction.
    if (submittingRef.current) return;

    if (!isSorobanContractId(circleAddress)) {
      setError(invalidCircleAddress(shortAddress(circleAddress)));
      return;
    }

    // Data completeness guard — same defence-in-depth as doAction
    if (dataReadiness !== "ready") {
      setError(
        dataReadiness === "stale"
          ? DATA_STATE_MSGS.staleDefaultGuard
          : DATA_STATE_MSGS.partialDefaultGuard,
      );
      return;
    }

    // Clear stale action state before the gate check so the user always sees
    // fresh output for this attempt.
    setError("");
    setSuccess(null);
    setRetryAction(null);
    setErrorTypedError(null);

    // Build snapshot for the TARGET member's contribution status
    const targetContributed =
      data.currentRound != null
        ? data.currentRound.contributions.some(
            (c) => c.member_address === memberAddress,
          )
        : false; // when currentRound is null, fail safe: assume not contributed

    const snapshot = buildAppSnapshot(
      data.circle.status,
      currentRound,
      data.circle.deadline_ledger,
      data.latestLedger,
      data.members.map((m) => m.member_address),
      false,
      targetContributed,
      data.currentRound?.contributions.length ?? 0,
      networkCheck,
      dataFetchedAtMs, // GåÉ correct: use data fetch time
    );

    const gate = computeActionEligibility("default", snapshot);
    if (isGateBlocked(gate)) {
      setError(gate.message);
      if (gate.reason === "stale_snapshot") {
        setRetryAction(() => () => doDefault(memberAddress));
      }
      return;
    }

    submittingRef.current = true;
    setLoading("default");

    const txCtrl = new AbortController();
    txAbortRef.current = txCtrl;
    try {
      const result = await invokeContract(
        circleAddress,
        "mark_default",
        [new Address(memberAddress).toScVal()],
        walletAddress,
        txCtrl.signal,
      );
      if (txCtrl.signal.aborted) return;
      if (!result.success) {
        const errMsg = result.typedError ? userMessageForError(result.typedError) : userMessageForError(parseContractError(result.error));
        setError(errMsg);
        setErrorTypedError(result.typedError ?? null);
        setErrorTxHash(result.txHash || null);
        if (!result.txHash && isRetryableError(errMsg)) {
          setRetryAction(() => () => doDefault(memberAddress));
        }
      } else {
        setSuccess({
          message: txDefaultSuccess(shortAddress(memberAddress), currentRound),
          txHash: result.txHash,
        });
        const ctrl = new AbortController();
        await postActionRefresh(ctrl);
      }
    } catch (err: unknown) {
      if (txCtrl.signal.aborted) return;
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(userMessageForError(parseContractError(message)));
      setErrorTypedError(parseContractError(message));
      if (isRetryableError(message)) {
        setRetryAction(() => () => doDefault(memberAddress));
      }
    } finally {
      setLoading(null);
      submittingRef.current = false;
    }
  }

  // GöÇGöÇ Accessibility GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
  //
  // The progressAnnouncement feeds a sr-only live region. When status or round
  // changes after a post-action refresh the region content changes, but a
  // static node doesn't guarantee re-announcement in all screen readers.
  // Using the announcement string as the element's `key` remounts the node on
  // every change, which reliably triggers the live region in NVDA, JAWS, and
  // VoiceOver without an extra useEffect.

  const totalRounds = data.circle.total_rounds;
  const progressAnnouncement =
    `Circle status: ${data.circle.status}.` +
    (Number.isFinite(totalRounds) && totalRounds > 0
      ? ` Round ${Math.max(0, currentRound)} of ${totalRounds}.`
      : "");

  const successTxUrl = success?.txHash
    ? getExplorerLink(ACTIVE_NETWORK, "tx", success.txHash)
    : null;

  // GöÇGöÇ Render GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

  return (
    <div className="space-y-8">
      <a href="/transactions" className="text-sm underline">Reopen recent transaction status</a>

      {/*
        Live announcement of status / round changes.
        `key={progressAnnouncement}` remounts the element whenever the text
        changes (e.g. after a post-action refresh updates the status or round),
        ensuring screen readers re-announce the new state reliably across NVDA,
        JAWS, and VoiceOver GÇö all of which require the DOM node to be (re)inserted
        into a live region for the announcement to fire.
      */}
      <p
        key={progressAnnouncement}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {progressAnnouncement}
      </p>

      {/* Data state banners GÇö shown above the action panel so the user
          understands why actions are locked before they try to click */}
      {dataReadiness === "stale" && (
        <StaleDataBanner
          onRefresh={handleManualRefresh}
          isRefreshing={isManualRefreshing}
        />
      )}

      {dataReadiness === "partial" && (
        <PartialDataBanner
          data={data}
          onRefresh={handleManualRefresh}
          isRefreshing={isManualRefreshing}
        />
      )}

      {dataReadiness === "refreshing" && (
        <div
          role="status"
          aria-live="polite"
          className="bg-slate-50 border border-slate-200 rounded-xl px-5 py-4 flex items-center gap-3 text-sm text-slate-600"
        >
          <span
            className="inline-block w-4 h-4 border-2 border-slate-300 border-t-brand-600 rounded-full animate-spin"
            aria-hidden="true"
          />
          Refreshing circle dataGÇª
        </div>
      )}

      {networkWarning && (
        <div
          role={networkMismatch?.kind === "mismatch" ? "alert" : "status"}
          aria-live="polite"
          className={clsx(
            "border rounded-xl px-5 py-4 flex items-start gap-3 text-sm",
            networkMismatch?.kind === "mismatch"
              ? "bg-red-50 border-red-200 text-red-700"
              : "bg-amber-50 border-amber-200 text-amber-800",
          )}
        >
          <span className="text-xl mt-0.5" aria-hidden="true">!</span>
          <div>
            <p className="font-semibold">
              {networkMismatch?.kind === "mismatch"
                ? "Wrong wallet network"
                : "Wallet network not verified"}
            </p>
            <p className="mt-1">{networkWarning}</p>
          </div>
        </div>
      )}

      {manualRefreshError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 flex items-start gap-3 text-sm text-red-700"
        >
          <span className="text-xl mt-0.5" aria-hidden="true">GÜán+Å</span>
          <div>
            <p className="font-semibold">Refresh failed</p>
            <p className="mt-1">{manualRefreshError}</p>
            <button
              onClick={handleManualRefresh}
              disabled={isManualRefreshing}
              className="mt-2 text-xs font-medium underline hover:text-red-900 disabled:opacity-50"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {/* Workflow explanation */}
      <WorkflowBanner
        status={data.circle.status}
        isMember={isMember}
        walletLoadState={walletLoadState}
        walletAddress={walletAddress}
        alreadyContributed={myContributedThisRound}
        currentRound={currentRound}
        totalRounds={data.circle.total_rounds}
      />

      {/* Join introduction panel — advisory only, shown to non-members */}
      {!isMember && walletLoadState !== "loading" && (
        <JoinIntroBanner
          content={buildJoinIntroContent({
            status: data.circle.status,
            joinedCount: data.members.filter(
              (m) => BigInt(m.collateral || "0") > 0n,
            ).length,
            memberCount: data.circle.member_count,
            roundAmountStroops: data.circle.round_amount,
            isMember: false,
            walletState: walletLoadState as "not_installed" | "disconnected" | "connected",
            networkName: ACTIVE_NETWORK,
            networkMismatch: networkMismatch?.kind === "mismatch",
          })}
        />
      )}

      {/* Action panel */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-800 mb-4">Actions</h2>

        {error && (
          <div
            role="alert"
            ref={errorRegionRef}
            tabIndex={-1}
            className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-3 focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            {error}
            {retryAction && (
              <button
                onClick={retryAction}
                className="ml-3 underline font-medium hover:text-red-900"
              >
                Retry
              </button>
            )}
          </div>
        )}

        {/* Diagnostics panel GÇö shown when there is an active transaction error.
            Collapsed by default; user must explicitly expand and generate the
            bundle. Nothing is sent to a server automatically. */}
        {error && (
          <div className="mb-3">
            <DiagnosticsPanel
              operation={errorOperation}
              typedError={errorTypedError}
              txHash={errorTxHash}
            />
          </div>
        )}

        {success && (
          <div
            className="bg-brand-50 border border-brand-200 rounded-lg p-3 text-sm text-brand-700 mb-3 space-y-2 focus:outline-none"
            role="status"
            aria-live="polite"
            ref={successRegionRef}
            tabIndex={-1}
          >
            <p>
              <span aria-hidden="true">G£à </span>
              {success.message}
            </p>
            {success.txHash && (
              <p className="text-xs">
                Tx:{" "}
                {successTxUrl ? (
                  <a
                    href={successTxUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono underline hover:text-brand-900"
                    title={success.txHash}
                  >
                    {shortAddress(success.txHash)}
                  </a>
                ) : (
                  <span className="font-mono" title={success.txHash}>
                    {shortAddress(success.txHash)}
                  </span>
                )}
              </p>
            )}
            {refreshState === "refreshing" && (
              <p className="flex items-center gap-1.5 text-xs text-brand-600">
                <span
                  className="inline-block w-3 h-3 border-2 border-brand-300 border-t-brand-600 rounded-full animate-spin"
                  aria-hidden="true"
                />
                Refreshing circle dataGÇª
              </p>
            )}
            {awaitingIndex && refreshState !== "refreshing" && (
              <p className="text-xs text-slate-500" role="status">
                Transaction confirmed on-chain. Waiting for the indexer to
                show it — this page will update automatically, or{" "}
                <button
                  onClick={handleManualRefresh}
                  disabled={isManualRefreshing}
                  className="underline font-medium hover:text-slate-700 disabled:opacity-50"
                >
                  refresh manually
                </button>
                .
              </p>
            )}
            {refreshState === "error" && (
              <p className="text-xs text-amber-700">
                GÜán+Å Could not refresh data automatically GÇö{" "}
                <button
                  onClick={handleManualRefresh}
                  disabled={isManualRefreshing}
                  className="underline font-medium hover:text-amber-900 disabled:opacity-50"
                >
                  refresh manually
                </button>{" "}
                to see the latest state.
              </p>
            )}
          </div>
        )}

        {defaultConfirm && (
          <div
            ref={defaultConfirmRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="default-confirm-title"
            tabIndex={-1}
            className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-3 space-y-3 outline-none"
          >
            <h3
              id="default-confirm-title"
              className="font-semibold text-amber-900 text-sm"
            >
              ?? Confirm Default
            </h3>
            <dl className="text-sm space-y-1 text-amber-800">
              <div className="flex gap-2">
                <dt className="font-medium w-16 shrink-0">Member</dt>
                <dd className="font-mono text-xs break-all">
                  {defaultConfirm.memberAddress}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium w-16 shrink-0">Round</dt>
                <dd>{defaultConfirm.roundIndex}</dd>
              </div>
              {data.circle.deadline_ledger != null && (
                <div className="flex gap-2">
                  <dt className="font-medium w-16 shrink-0">Deadline</dt>
                  <dd>
                    Ledger {data.circle.deadline_ledger.toLocaleString()}
                    {deadlinePassed && (
                      <span className="ml-1 text-red-700 font-medium">
                        (overdue)
                      </span>
                    )}
                  </dd>
                </div>
              )}
            </dl>
            <p className="text-xs text-amber-700">
              A penalty will be deducted from this member&apos;s locked collateral.
              This action is irreversible once confirmed on-chain. Cancel if you
              are not certain the contribution window has closed.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={dismissDefaultConfirm}
                className="px-3 py-2 text-sm rounded-lg border border-amber-400 text-amber-800 hover:bg-amber-100 transition-colors focus:ring-2 focus:ring-amber-500 focus:outline-none"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const addr = defaultConfirm.memberAddress;
                  dismissDefaultConfirm();
                  doDefault(addr);
                }}
                disabled={loading !== null || !actionsEnabled}
                className="px-3 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:ring-2 focus:ring-red-500 focus:outline-none"
              >
                Confirm &amp; Sign
              </button>
            </div>
          </div>
        )}

        <div className="action-group">
          {/* Wallet loading placeholder GÇö prevents layout shift while wallet check is in flight */}
          {walletLoadState === "loading" && (
            <span
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-sm text-slate-400"
            >
              <span
                className="inline-block w-4 h-4 border-2 border-slate-200 border-t-slate-400 rounded-full animate-spin"
                aria-hidden="true"
              />
              Checking walletGÇª
            </span>
          )}

          {data.circle.status === "Pending" && isMember && !hasLockedCollateral && (
            <>
            <button
              onClick={handleJoin}
              disabled={loading !== null || !actionsEnabled || !joinGate.allowed}
              aria-busy={loading === "join" ? "true" : "false"}
              aria-disabled={!actionsEnabled || !joinGate.allowed}
              aria-describedby={!joinGate.allowed ? "join-gate-reason" : undefined}
              title={
                !actionsEnabled
                  ? "Actions unavailable until circle data is fully loaded"
                  : !joinGate.allowed
                  ? joinGate.message
                  : undefined
              }
              className="bg-brand-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[44px]"
            >
              {loading === "join" ? "JoiningGÇª" : "=ƒöÆ Lock Collateral & Join"}
            </button>
            {!joinGate.allowed && actionsEnabled && (
              <p id="join-gate-reason" className="text-xs text-slate-500" role="note">
                {joinGate.message}
              </p>
            )}
            </>
          )}

          {data.circle.status === "Active" &&
            isMember &&
            !myContributedThisRound && (
              <div className="flex flex-col gap-1">
                <button
                  onClick={handleContribute}
                  disabled={loading !== null || !contributeGate.allowed || !actionsEnabled}
                  aria-busy={loading === "contribute" ? "true" : "false"}
                  aria-describedby={!contributeGate.allowed ? "contribute-gate-reason" : undefined}
                  aria-disabled={!actionsEnabled || !contributeGate.allowed}
                  title={
                    !actionsEnabled
                      ? "Actions unavailable until circle data is fully loaded"
                      : !contributeGate.allowed
                      ? contributeGate.message
                      : undefined
                  }
                  className="bg-brand-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[44px]"
                >
                  {loading === "contribute"
                    ? "ContributingGÇª"
                    : `=ƒÆ¦ Contribute Round ${currentRound}`}
                </button>
                {!contributeGate.allowed && actionsEnabled && (
                  <p
                    id="contribute-gate-reason"
                    className="text-xs text-slate-500"
                    role="note"
                  >
                    {contributeGate.message}
                  </p>
                )}
              </div>
            )}

          {data.circle.status === "Active" && (
            <div className="flex flex-col gap-1">
              <button
                onClick={handlePayout}
                disabled={loading !== null || !payoutGate.allowed || !actionsEnabled}
                aria-busy={loading === "payout" ? "true" : "false"}
                aria-describedby={!payoutGate.allowed ? "payout-gate-reason" : undefined}
                aria-disabled={!actionsEnabled || !payoutGate.allowed}
                title={
                  !actionsEnabled
                    ? "Actions unavailable until circle data is fully loaded"
                    : !payoutGate.allowed
                    ? payoutGate.message
                    : undefined
                }
                className="bg-blue-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[44px]"
              >
                {loading === "payout" ? "Paying outGÇª" : "=ƒÄ» Trigger Payout"}
              </button>
              {!payoutGate.allowed && actionsEnabled && (
                <p
                  id="payout-gate-reason"
                  className="text-xs text-slate-500"
                  role="note"
                >
                  {payoutGate.message}
                </p>
              )}
            </div>
          )}

          {(data.circle.status === "Completed" ||
            data.circle.status === "Cancelled") && (
            <>
            <button
              onClick={handleClose}
              disabled={loading !== null || !actionsEnabled || !closeGate.allowed}
              aria-busy={loading === "close" ? "true" : "false"}
              aria-disabled={!actionsEnabled || !closeGate.allowed}
              aria-describedby={!closeGate.allowed ? "close-gate-reason" : undefined}
              title={
                !actionsEnabled
                  ? "Actions unavailable until circle data is fully loaded"
                  : !closeGate.allowed
                  ? closeGate.message
                  : undefined
              }
              className="bg-slate-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[44px]"
            >
              {loading === "close" ? "ClosingGÇª" : "=ƒöô Release Collateral"}
            </button>
            {!closeGate.allowed && actionsEnabled && (
              <p id="close-gate-reason" className="text-xs text-slate-500" role="note">
                {closeGate.message}
              </p>
            )}
            </>
          )}

          {loading !== null && (
            <span
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-sm text-slate-500 self-center"
            >
              <span
                className="inline-block w-4 h-4 border-2 border-slate-300 border-t-brand-600 rounded-full animate-spin"
                aria-hidden="true"
              />
              {/* Issue #499: show the specific action in progress, not a generic message */}
              {ACTION_LOADING_LABELS[loading]}
            </span>
          )}
        </div>
      </div>

      {/* Contribution receipt */}
      {contributionReceipt && (
        <div
          role="region"
          aria-label="Contribution receipt"
          className="bg-white rounded-xl border border-brand-200 p-5"
        >
          <h2 className="font-semibold text-slate-800 mb-3">
            <span aria-hidden="true">=ƒÆ¦ </span>Contribution Receipt
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Round</dt>
              <dd className="font-medium text-slate-800">
                {contributionReceipt.roundIndex}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Amount contributed</dt>
              <dd className="font-medium text-slate-800">
                ${formatUsdc(contributionReceipt.amount)}
              </dd>
            </div>
            {contributionReceipt.txHash && (
              <div className="flex justify-between items-center gap-2">
                <dt className="text-slate-500 shrink-0">Transaction</dt>
                <dd className="flex items-center gap-1.5 min-w-0">
                  {contributionReceipt.explorerUrl ? (
                    <a
                      href={contributionReceipt.explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-brand-600 hover:underline truncate"
                      title={contributionReceipt.txHash}
                    >
                      {shortAddress(contributionReceipt.txHash)}
                    </a>
                  ) : (
                    <span
                      className="font-mono text-xs text-slate-600 truncate"
                      title={contributionReceipt.txHash}
                    >
                      {shortAddress(contributionReceipt.txHash)}
                    </span>
                  )}
                  <button
                    onClick={handleCopyReceiptHash}
                    className="shrink-0 text-xs text-slate-400 hover:text-slate-700 px-1.5 py-0.5 rounded border border-slate-200 hover:border-slate-400 transition-colors"
                    title="Copy full transaction hash"
                    aria-label="Copy transaction hash"
                  >
                    {receiptCopyState === "success"
                      ? "Copied!"
                      : receiptCopyState === "error"
                      ? "Failed"
                      : "Copy"}
                  </button>
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {/* Round deadline countdown */}
      <RoundDeadlineStatus
        deadlineLedger={data.circle.deadline_ledger}
        latestLedger={data.latestLedger}
        status={data.circle.status}
        fetchedAtMs={dataFetchedAtMs}
        checkpointTime={data.checkpointTime ?? null}
      />

      {/* Rotation view */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        {/* Issue #697: Show data source and freshness on the member list section.
            The freshness state is derived from the indexer checkpoint timestamp.
            "unknown freshness" is shown explicitly when checkpointTime is absent
            — it is never silently mapped to "current". */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-slate-800">=ƒöä Rotation Order</h2>
          <span
            className="text-xs text-slate-400"
            title="Where this member data comes from and how current it is. Indexed data may lag the chain by one or more ledgers."
            aria-label={`Member list data source: Indexed. Freshness: ${classifyFreshness(data.checkpointTime)}.`}
          >
            {formatSourceLabel("indexer", classifyFreshness(data.checkpointTime))}
          </span>
        </div>
        {data.members.length === 0 ? (
          <MemberListFallback memberCount={data.circle.member_count} />
        ) : (
        <>
        <div className="space-y-2">
          {data.members.map((member, i) => {
            const isPaid = i < currentRound;
            const isNext =
              i === currentRound && data.circle.status === "Active";
            const roundForMember = data.rounds.find(
              (r) => r.roundIndex === i && r.status === "completed",
            );

            const contribStatus = getMemberContributionStatus(
              member,
              currentRound,
              data.circle.status,
              // Issue #498: pass the authoritative contribution list when available
              // so the badge reflects real-time on-chain state rather than the
              // potentially-lagged total_contributions counter.
              data.currentRound?.contributions ?? null,
            );

            return (
              <div
                key={member.member_address}
                className={clsx(
                  "flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-lg border transition-all",
                  isNext
                    ? "border-brand-400 bg-brand-50"
                    : isPaid
                    ? "border-slate-200 bg-slate-50 opacity-75"
                    : "border-slate-200 bg-white",
                )}
              >
                <span className="text-slate-400 text-sm w-5 shrink-0 text-right">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-xs text-slate-600 truncate">
                    {member.member_address}
                    {member.member_address === walletAddress && (
                      <span className="ml-1 text-brand-600 font-sans font-medium">
                        (you)
                      </span>
                    )}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <ReputationBadge
                      score={member.reputation_score}
                      size="sm"
                    />
                    {member.defaults > 0 && (
                      <span className="text-xs text-red-600 font-medium">
                        <span aria-hidden="true">GÜán+Å </span>
                        {member.defaults} default
                        {member.defaults > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-right text-sm shrink-0 max-w-[45%] sm:max-w-none">
                  {isPaid ? (
                    <span className="text-slate-500 text-xs sm:text-sm">
                      <span aria-hidden="true">G£à </span>
                      received ${formatUsdc(roundForMember?.amount ?? "0")}
                    </span>
                  ) : isNext ? (
                    <span className="text-brand-700 font-semibold text-xs sm:text-sm">
                      <span aria-hidden="true">GåÉ </span>
                      next payout
                    </span>
                  ) : (
                    <div className="flex flex-col items-end gap-1">
                      <ContributionStatusBadge status={contribStatus} />
                      {contribStatus === "pending" &&
                        data.circle.status === "Active" &&
                        deadlinePassed &&
                        actionsEnabled && (
                          <button
                            onClick={() => handleMarkDefault(member.member_address)}
                            disabled={loading !== null || !actionsEnabled}
                            className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Mark Default
                          </button>
                        )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {data.circle.status === "Active" && (
          <p className="text-xs text-slate-400 mt-3">
            Round {currentRound} -+ contributions shown for the current round only
          </p>
        )}
        </>
        )}
      </div>

      {/* Round history */}
      {data.rounds.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="font-semibold text-slate-800 mb-4">=ƒôï Round History</h2>
          <div className="space-y-4">
            {data.rounds.map((round) => (
              <RoundCard key={round.roundIndex} round={round} />
            ))}
          </div>
        </div>
      )}

      {/* Open rounds */}
      {data.openRounds.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <h2 className="font-semibold text-amber-800 mb-1">
            GÅ¦ Open Rounds
          </h2>
          <p className="text-xs text-amber-700 mb-3">
            These rounds have recorded contributions or defaults but have not
            been paid out yet and are not the current round. They may be the
            result of a partial ingest or a reorg; they will move to Round
            History once a payout is confirmed on-chain.
          </p>
          <div className="space-y-3">
            {data.openRounds.map((round) => (
              <RoundCard key={round.roundIndex} round={round} />
            ))}
          </div>
        </div>
      )}

      {/* Pending defaults */}
      {data.pendingDefaults.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5">
          <h2 className="font-semibold text-red-800 mb-3">
            GÜán+Å Defaults (current round)
          </h2>
          <div className="space-y-2">
            {data.pendingDefaults.map((d) => (
              <div
                key={d.member_address}
                className="flex flex-wrap items-center justify-between gap-2 text-sm text-red-700 bg-red-100 rounded-lg px-3 py-2"
              >
                <span className="font-mono text-xs">{shortAddress(d.member_address)}</span>
                <span>Penalty: ${formatUsdc(d.penalty)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Activity timeline — only shown when there are any rounds of data */}
      {(data.rounds.length > 0 || data.openRounds.length > 0) && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <CircleTimeline
            rawEvents={buildTimelineEvents(data)}
            fetchedAt={data.checkpointTime ?? null}
          />
        </div>
      )}

      {/* Per-member round summary — shown for the connected wallet member */}
      {isMember && myMember && (data.rounds.length > 0 || data.openRounds.length > 0) && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <MemberRoundSummary
            summary={computeMemberRoundSummary(
              myMember.member_address,
              [...data.rounds, ...data.openRounds, ...(data.currentRound ? [data.currentRound] : [])],
              data.circle.status as import("@/lib/circleTypes").CircleApiStatus,
            )}
          />
        </div>
      )}

      {/* Invite link */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">        <h2 className="font-semibold text-slate-700 mb-2">=ƒöù Invite link</h2>
        <p className="text-xs text-slate-500 mb-2">
          Share this link so members can find and join this circle:
        </p>
        <div className="flex gap-2">
          <input
            readOnly
            value={inviteUrl ?? ""}
            className="flex-1 min-w-0 font-mono text-xs bg-white border border-slate-300 rounded px-3 py-2 text-slate-600 placeholder:text-slate-400"
            onClick={(e) => (e.target as HTMLInputElement).select()}
            aria-label="Invite link for this circle"
            aria-busy={inviteUrl === null}
            placeholder="Loading invite linkGÇª"
          />
          <button
            onClick={handleCopyInvite}
            disabled={!inviteUrl}
            className="shrink-0 text-xs font-medium px-3 py-2 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label={
              inviteCopyState === "success"
                ? "Link copied!"
                : inviteCopyState === "error"
                ? "Copy failed GÇö try selecting and copying manually"
                : "Copy invite link"
            }
          >
            {inviteCopyState === "success"
              ? "Copied!"
              : inviteCopyState === "error"
              ? "Failed"
              : "Copy"}
          </button>
        </div>
        {inviteCopyState === "error" && (
          <p className="text-xs text-red-600 mt-1" role="alert">
            Copy failed. Please select the link and copy it manually.
          </p>
        )}
      </div>
    </div>
  );
}