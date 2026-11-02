// app/src/lib/circleDetailState.ts
//
// State type declarations and pure helper functions for the circle detail page.
// Extracted from CircleDetailClient.tsx to reduce that file's LOC.

import type { CircleDetailData } from "@/lib/circleTypes";
// GöÇGöÇGöÇ Action key type GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

export type ActionKey = "join" | "contribute" | "payout" | "default" | "close";

// GöÇGöÇGöÇ Success state shape GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

export interface SuccessState {
  message: string;
  txHash?: string;
}

// GöÇGöÇGöÇ Data-refresh state GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ
//
// "idle"      GÇö no refresh in flight.
// "refreshing" GÇö post-action background refresh is running.
// "error"     GÇö refresh failed after a successful action; data may be stale.

export type RefreshState = "idle" | "refreshing" | "error";

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

export type WalletLoadState = "loading" | "connected" | "disconnected" | "not_installed";

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

export interface ContributionReceipt {
  amount: string;
  roundIndex: number;
  txHash: string;
  explorerUrl: string | null;
}

// GöÇGöÇGöÇ Default confirmation GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

export interface DefaultConfirmState {
  memberAddress: string;
  roundIndex: number;
}

// GöÇGöÇGöÇ Copy feedback GöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇGöÇ

export type CopyState = "idle" | "success" | "error";

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
export function isRetryableError(err: string): boolean {
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
