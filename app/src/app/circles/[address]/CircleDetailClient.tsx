"use client";
"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { Address, xdr } from "@stellar/stellar-sdk";
import { getWalletAddress, invokeContract } from "@/lib/stellar";
import { shortAddress, formatUsdc, INDEXER_URL, getExplorerLink, ACTIVE_NETWORK } from "@/lib/config";
import { isSorobanContractId } from "@/lib/address";
import {
  buildAppSnapshot,
  computeActionEligibility,
  isGateBlocked,
} from "@/lib/gating";
import { ReputationBadge } from "@/components/ReputationBadge";
import clsx from "clsx";

// ─── Types ────────────────────────────────────────────────────────────────────
//
// These shapes mirror the canonical API model types defined in
// sdk/src/types.ts (ApiMemberRow, ApiRoundRow, ApiDefaultRecord, etc.).
// They are re-declared here because the app package does not take a direct
// dependency on @circleup/sdk; keep them in sync when the indexer schema
// changes and update sdk/src/types.ts as the source of truth.

/** @see ApiMemberRow in sdk/src/types.ts */
export interface CircleMember {
  member_address: string;
  payout_order: number;
  collateral: string;
  defaults: number;
  joined_at: string | null;
  reputation_score: number;
  total_contributions: number;
}

/** @see ApiContributionRecord in sdk/src/types.ts */
export interface ContributionRecord {
  member_address: string;
  amount: string;
  tx_hash: string;
}

/** @see ApiDefaultRecord in sdk/src/types.ts */
export interface DefaultRecord {
  member_address: string;
  penalty: string;
}

/** @see ApiRoundRow in sdk/src/types.ts */
export interface CircleRound {
  roundIndex: number;
  /**
   * "completed" — payout row exists for this round.
   * "current"   — the active in-progress round (no payout yet).
   * "cancelled" — the current round of a Cancelled circle.
   * "open"      — unpaid round with activity that is not the current round
   *               (reorg / partial-ingest edge case; was previously invisible).
   */
  status: "completed" | "current" | "cancelled" | "open";
  /** null when the round has not been paid out yet. */
  recipient: string | null;
  /** null when the round has not been paid out yet. */
  amount: string | null;
  /** null when the round has not been paid out yet. */
  txHash: string | null;
  contributions: ContributionRecord[];
  defaults: DefaultRecord[];
}

/** Pending default — a DefaultRecord not yet associated with a payout round.
 *  @see ApiDefaultRecord in sdk/src/types.ts */
export interface CirclePendingDefault {
  member_address: string;
  penalty: string;
}

/** Subset of ApiCircleRow fields used by the detail view.
 *  @see ApiCircleRow in sdk/src/types.ts */
export interface CircleState {
  status: string;
  current_round: number;
  total_rounds: number;
  round_amount: string;
  member_count: number;
  /** Computed deadline ledger for the current active round (null if unknown) */
  deadline_ledger?: number | null;
}

/** Composite data object for the circle detail page.
 *  @see ApiCircleDetailResponse + ApiRoundsResponse in sdk/src/types.ts */
export interface CircleDetailData {
  circle: CircleState;
  members: CircleMember[];
  /**
   * Completed rounds only (status === "completed"), sorted by roundIndex.
   * Returned by the indexer's /rounds endpoint as the `rounds` field.
   */
  rounds: CircleRound[];
  /**
   * Unpaid rounds that have contributions and/or defaults recorded but are
   * not the circle's current round — previously dropped silently (issue #170).
   * Returned by the indexer's /rounds endpoint as the `openRounds` field.
   */
  openRounds: CircleRound[];
  pendingDefaults: CirclePendingDefault[];
  /** Latest ledger the indexer has processed (used for countdown math) */
  latestLedger?: number | null;
  /**
   * The in-progress round returned by the indexer's /rounds endpoint.
   * Contains the actual contributions list for the current round, used to
   * determine whether the connected wallet has already contributed this round.
   * Null when the circle is not Active or the indexer hasn't processed it yet.
   */
  currentRound?: CircleRound | null;
}

interface Props {
  circleAddress: string;
  circleData: CircleDetailData;
}

// ─── Action key type ──────────────────────────────────────────────────────────

type ActionKey = "join" | "contribute" | "payout" | "default" | "close";

// ─── Success state shape ──────────────────────────────────────────────────────

interface SuccessState {
  message: string;
  txHash?: string;
}

// ─── Data-refresh state ───────────────────────────────────────────────────────
//
// "idle"      — no refresh in flight.
// "refreshing" — post-action background refresh is running.
// "error"     — refresh failed after a successful action; data may be stale.

type RefreshState = "idle" | "refreshing" | "error";

// ─── Wallet load state ────────────────────────────────────────────────────────
//
// Distinct from walletAddress === null, which conflates "still loading" with
// "genuinely not connected". Action buttons must not render until we know
// definitively which case we're in.
//
// "loading"     — getWalletAddress() has not resolved yet.
// "connected"   — wallet is installed and an address was returned.
// "disconnected" — wallet is installed but no address (not connected).
// "not_installed" — Freighter extension is absent.

type WalletLoadState = "loading" | "connected" | "disconnected" | "not_installed";

// ─── Data completeness state ──────────────────────────────────────────────────
//
// Tracks whether the data passed in (or updated via refresh) has all fields
// required for safe action-gating. This is separate from network errors — it
// describes the *content* of a successful response.
//
// "ready"     — all required fields are present and non-empty.
// "partial"   — data is present but some fields are missing (members[], latestLedger,
//               currentRound). Actions are blocked until a refresh fills the gaps.
// "stale"     — the data was last fetched more than MAX_DATA_AGE_MS ago.
//               The user sees a banner and must explicitly refresh.
// "refreshing" — a manual refresh is in flight (data from prop is kept visible).

export type DataReadiness = "ready" | "partial" | "stale" | "refreshing";

// ─── Contribution receipt ──────────────────────────────────────────────────────

interface ContributionReceipt {
  amount: string;
  roundIndex: number;
  txHash: string;
  explorerUrl: string | null;
}

// ─── Default confirmation ──────────────────────────────────────────────────────

interface DefaultConfirmState {
  memberAddress: string;
  roundIndex: number;
}

// ─── Copy feedback ────────────────────────────────────────────────────────────

type CopyState = "idle" | "success" | "error";

// ─── Constants ────────────────────────────────────────────────────────────────

const SECONDS_PER_LEDGER = 5;

/**
 * Maximum age (ms) before the component considers its data stale and shows a
 * banner prompting the user to refresh. Conservative at 2 min — long enough
 * to read the page but short enough to catch a missed payout event.
 *
 * Distinct from DEFAULT_MAX_SNAPSHOT_AGE_MS (30 s) in gating.ts, which is the
 * per-action pre-flight check. Both guards are required: the page-level check
 * prevents the user from sitting on stale data without noticing; the gate
 * check fires just before the on-chain write.
 */
export const MAX_DATA_AGE_MS = 2 * 60 * 1000; // 2 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ledgersToHuman(ledgers: number): string {
  if (ledgers <= 0) return "overdue";
  const totalSeconds = ledgers * SECONDS_PER_LEDGER;
  const days    = Math.floor(totalSeconds / 86400);
  const hours   = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0)    return `${days}d ${hours}h`;
  if (hours > 0)   return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Compute the data readiness from the current data snapshot and the timestamp
 * at which data was last successfully fetched.
 *
 * "ready"   — members loaded, latestLedger known, currentRound available (or
 *             circle is not Active so currentRound is not required).
 * "partial" — members empty OR (circle is Active AND currentRound is null).
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

// ─── Sub-components ───────────────────────────────────────────────────────────

interface DeadlineProps {
  deadlineLedger: number | null | undefined;
  latestLedger:   number | null | undefined;
  status: string;
}

function RoundDeadlineStatus({ deadlineLedger, latestLedger, status }: DeadlineProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (status !== "Active" || deadlineLedger == null) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status, deadlineLedger]);

  if (status !== "Active") {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center gap-3">
        <span className="text-xl" aria-hidden="true">⏱️</span>
        <div>
          <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">
            Round deadline
          </p>
          <p className="text-sm text-slate-400 mt-0.5">
            {status === "Completed"
              ? "Circle completed"
              : status === "Cancelled"
              ? "Circle cancelled"
              : "Circle not yet active"}
          </p>
        </div>
      </div>
    );
  }

  if (deadlineLedger == null || latestLedger == null) {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center gap-3">
        <span className="text-xl" aria-hidden="true">⏱️</span>
        <div>
          <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">
            Round deadline
          </p>
          <p className="text-sm text-slate-400 mt-0.5">
            Deadline data not available for this circle
          </p>
        </div>
      </div>
    );
  }

  const ledgersRemaining = deadlineLedger - latestLedger;
  const isOverdue = ledgersRemaining <= 0;
  const human = ledgersToHuman(ledgersRemaining);

  const totalSecondsRemaining = ledgersRemaining * SECONDS_PER_LEDGER;
  const urgency =
    isOverdue || totalSecondsRemaining < 86_400
      ? "red"
      : totalSecondsRemaining < 2 * 86_400
      ? "yellow"
      : "green";

  const colorMap = {
    green:  "bg-brand-50 border-brand-200 text-brand-800",
    yellow: "bg-amber-50 border-amber-300 text-amber-800",
    red:    "bg-red-50 border-red-300 text-red-800",
  } as const;

  const labelMap = {
    green:  "Time remaining",
    yellow: "Deadline approaching",
    red:    isOverdue ? "Payout overdue" : "Deadline imminent",
  } as const;

  return (
    <div
      className={`border rounded-xl p-4 flex items-center gap-3 ${colorMap[urgency]}`}
      role="status"
      aria-live="polite"
      aria-label={`Round deadline: ${human}`}
    >
      <span className="text-xl" aria-hidden="true">
        {isOverdue ? "🔔" : "⏱️"}
      </span>
      <div className="flex-1">
        <p className="text-xs font-medium uppercase tracking-wide opacity-70">
          {labelMap[urgency]}
        </p>
        <p className="text-lg font-bold mt-0.5 tabular-nums">{human}</p>
        <p className="text-xs opacity-60 mt-0.5">
          Deadline at ledger {deadlineLedger.toLocaleString()} ·{" "}
          {Math.abs(ledgersRemaining).toLocaleString()} ledger
          {Math.abs(ledgersRemaining) !== 1 ? "s" : ""}{" "}
          {isOverdue ? "past deadline" : "remaining"}{" "}
          · ~{SECONDS_PER_LEDGER}s per ledger
        </p>
      </div>
    </div>
  );
}

// ─── Partial data banner ──────────────────────────────────────────────────────
//
// Shown when data is structurally present but incomplete. Explains why actions
// are locked and provides a Retry button. Distinct from a network/fetch error —
// this is "we got a response, but it doesn't have everything we need yet."

interface PartialDataBannerProps {
  data: CircleDetailData;
  onRefresh: () => void;
  isRefreshing: boolean;
}

function PartialDataBanner({ data, onRefresh, isRefreshing }: PartialDataBannerProps) {
  const missing: string[] = [];
  if (data.members.length === 0) missing.push("member list");
  if (data.circle.status === "Active" && data.currentRound == null)
    missing.push("current-round contribution data");

  if (missing.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-4 flex items-start gap-3 text-sm"
    >
      <span className="text-xl mt-0.5" aria-hidden="true">⏳</span>
      <div className="flex-1">
        <p className="font-semibold text-amber-800">
          Some data is still loading
        </p>
        <p className="text-amber-700 mt-1">
          The indexer hasn't finished processing this circle yet. Missing:{" "}
          <span className="font-medium">{missing.join(", ")}</span>. Actions are
          disabled until all data is available to prevent unsafe transactions.
        </p>
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="mt-2 text-xs font-medium underline text-amber-800 hover:text-amber-900 disabled:opacity-50"
        >
          {isRefreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </div>
    </div>
  );
}

// ─── Stale data banner ────────────────────────────────────────────────────────
//
// Shown when the data is older than MAX_DATA_AGE_MS. Distinct from partial data:
// the data was complete when it arrived, but it's now too old to trust for
// financial operations.

interface StaleDataBannerProps {
  onRefresh: () => void;
  isRefreshing: boolean;
}

function StaleDataBanner({ onRefresh, isRefreshing }: StaleDataBannerProps) {
  return (
    <div
      role="alert"
      className="bg-orange-50 border border-orange-300 rounded-xl px-5 py-4 flex items-start gap-3 text-sm"
    >
      <span className="text-xl mt-0.5" aria-hidden="true">🕐</span>
      <div className="flex-1">
        <p className="font-semibold text-orange-800">Circle data is out of date</p>
        <p className="text-orange-700 mt-1">
          The data on this page is more than 2 minutes old. Actions are disabled
          until you refresh to ensure you're not submitting a transaction based on
          stale state.
        </p>
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="mt-2 text-xs font-medium underline text-orange-800 hover:text-orange-900 disabled:opacity-50"
        >
          {isRefreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </div>
    </div>
  );
}

// ─── Workflow explanation banner ──────────────────────────────────────────────

interface WorkflowBannerProps {
  status: string;
  isMember: boolean;
  walletLoadState: WalletLoadState;
  walletAddress: string | null;
  alreadyContributed: boolean;
  currentRound: number;
  totalRounds: number;
}

function WorkflowBanner({
  status,
  isMember,
  walletLoadState,
  walletAddress,
  alreadyContributed,
  currentRound,
  totalRounds,
}: WorkflowBannerProps) {
  if (status === "Completed" || status === "Cancelled") return null;

  // Don't show a "connect your wallet" banner while still loading — it would
  // flash and disappear once the wallet check resolves.
  if (walletLoadState === "loading") return null;

  if (!walletAddress) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">ℹ️</span>
        <p>
          <strong>Connect your wallet</strong> using the button in the top-right
          to join or interact with this circle.
        </p>
      </div>
    );
  }

  if (status === "Pending" && !isMember) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">🔒</span>
        <div>
          <p className="font-semibold mb-1">How to join this circle</p>
          <p>
            Click <strong>"Lock Collateral &amp; Join"</strong> below. This
            locks your collateral on-chain, securing your spot in the rotation.
            You will receive the pot when it is your turn — your payout order
            is assigned at join time.
          </p>
        </div>
      </div>
    );
  }

  if (status === "Pending" && isMember) {
    return (
      <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 text-sm text-brand-800 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">✅</span>
        <p>
          You have joined. The circle starts automatically once all members have
          locked their collateral.
        </p>
      </div>
    );
  }

  if (status === "Active" && isMember && !alreadyContributed) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">💰</span>
        <div>
          <p className="font-semibold mb-1">
            Round {currentRound} of {totalRounds} — your contribution is due
          </p>
          <p>
            Click <strong>"Contribute Round {currentRound}"</strong> to send
            your share of the pot. All contributions are pooled and paid out to
            the next member in the rotation. Missing a round incurs a penalty
            deducted from your collateral.
          </p>
        </div>
      </div>
    );
  }

  if (status === "Active" && isMember && alreadyContributed) {
    return (
      <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 text-sm text-brand-800 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">✅</span>
        <p>
          You have contributed to round {currentRound}. Waiting for all other
          members to contribute before the payout triggers.
        </p>
      </div>
    );
  }

  if (status === "Active" && !isMember) {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-600 flex gap-3 items-start">
        <span className="text-lg" aria-hidden="true">👀</span>
        <p>
          This circle is active. You are not a member, but you can watch the
          rotation progress below. Trigger Payout is available to anyone once
          all contributions are in.
        </p>
      </div>
    );
  }

  return null;
}

// ─── getMemberContributionStatus ─────────────────────────────────────────────

function getMemberContributionStatus(
  member: CircleMember,
  currentRound: number,
  status: string,
): "contributed" | "pending" | "defaulted" | "not_applicable" {
  if (status !== "Active") return "not_applicable";
  if (member.payout_order === currentRound) return "not_applicable";
  if (Number(member.total_contributions) > currentRound) return "contributed";
  if (member.defaults > 0) return "defaulted";
  return "pending";
}

// ─── fetchCircleData ──────────────────────────────────────────────────────────
//
// Shared fetch logic used both by the initial SSR prop and the client-side
// manual refresh. Returns the merged data or an error discriminant.
//
// Error kinds:
//   "not_found" — indexer returned 404 (circle does not exist).
//   "network"   — fetch threw (offline, DNS failure, CORS).
//   "server"    — indexer returned 5xx or non-ok non-404.

export type RefreshError = "not_found" | "network" | "server";

export type RefreshResult =
  | { ok: true; data: CircleDetailData; fetchedAtMs: number }
  | { ok: false; error: RefreshError };

export async function fetchCircleData(
  circleAddress: string,
  signal?: AbortSignal,
): Promise<RefreshResult> {
  let circleRes: Response;
  let roundsRes: Response;

  try {
    [circleRes, roundsRes] = await Promise.all([
      fetch(`${INDEXER_URL}/circles/${circleAddress}`, {
        cache: "no-store",
        signal,
      }),
      fetch(`${INDEXER_URL}/circles/${circleAddress}/rounds`, {
        cache: "no-store",
        signal,
      }),
    ]);
  } catch (err) {
    // AbortError is not a real failure — the component unmounted during refresh
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

  const members = Array.isArray(circleJson.members)
    ? (circleJson.members as CircleMember[])
    : [];

  return {
    ok: true,
    fetchedAtMs: Date.now(),
    data: {
      circle: circleJson.circle as CircleDetailData["circle"],
      members,
      rounds: Array.isArray(roundsJson.rounds)
        ? (roundsJson.rounds as CircleRound[])
        : [],
      openRounds: Array.isArray(roundsJson.openRounds)
        ? (roundsJson.openRounds as CircleRound[])
        : [],
      pendingDefaults: Array.isArray(roundsJson.pendingDefaults)
        ? (roundsJson.pendingDefaults as CirclePendingDefault[])
        : [],
      latestLedger:
        typeof circleJson.latestLedger === "number"
          ? circleJson.latestLedger
          : null,
      currentRound:
        roundsJson.currentRound != null &&
        typeof roundsJson.currentRound === "object"
          ? (roundsJson.currentRound as CircleRound)
          : null,
    },
  };
}

// ─── Main client component ────────────────────────────────────────────────────

export function CircleDetailClient({ circleAddress, circleData }: Props) {
  // ── Wallet load state ──────────────────────────────────────────────────────
  //
  // Distinguishes "still loading" from "not connected" so action buttons don't
  // flash on/off during the async wallet check.
  const [walletLoadState, setWalletLoadState] = useState<WalletLoadState>("loading");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  // ── Circle data ────────────────────────────────────────────────────────────
  const [data, setData] = useState<CircleDetailData>(circleData);

  // Wall-clock timestamp of the last *successful* data fetch.
  // Seeded to Date.now() on mount because circleData comes from a fresh SSR
  // fetch; updated on every successful manual or post-action refresh.
  const [dataFetchedAtMs, setDataFetchedAtMs] = useState<number>(() => Date.now());

  // ── Action state ───────────────────────────────────────────────────────────
  const [loading,      setLoading]      = useState<ActionKey | null>(null);
  const [error,        setError]        = useState<string>("");
  const [success,      setSuccess]      = useState<SuccessState | null>(null);
  const [retryAction,  setRetryAction]  = useState<(() => void) | null>(null);
  const [refreshState, setRefreshState] = useState<RefreshState>("idle");

  // ── UI state ───────────────────────────────────────────────────────────────
  const [inviteUrl,           setInviteUrl]           = useState("");
  const [contributionReceipt, setContributionReceipt] = useState<ContributionReceipt | null>(null);
  const [defaultConfirm,      setDefaultConfirm]      = useState<DefaultConfirmState | null>(null);
  const [inviteCopyState,     setInviteCopyState]     = useState<CopyState>("idle");
  const [receiptCopyState,    setReceiptCopyState]    = useState<CopyState>("idle");

  // Whether a manual refresh (triggered by Stale or Partial banners) is running
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  // Refresh error message when a manual refresh fails
  const [manualRefreshError, setManualRefreshError] = useState<string>("");

  // ── Staleness tracking ─────────────────────────────────────────────────────
  //
  // Re-evaluated every second so the stale banner appears automatically once
  // data ages past MAX_DATA_AGE_MS, even if the user hasn't interacted.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Ref for aborting any in-flight manual or post-action refresh when the
  // component unmounts, preventing setState calls on an unmounted tree.
  const refreshAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      refreshAbortRef.current?.abort();
    };
  }, []);

  // Focus management refs
  const errorRegionRef   = useRef<HTMLDivElement>(null);
  const successRegionRef = useRef<HTMLDivElement>(null);

  // ── Wallet resolution ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    getWalletAddress()
      .then((address) => {
        if (cancelled) return;
        if (address) {
          setWalletAddress(address);
          setWalletLoadState("connected");
        } else {
          setWalletLoadState("disconnected");
        }
      })
      .catch(() => {
        if (cancelled) return;
        // WalletError with reason "not_installed" lands here
        setWalletLoadState("not_installed");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setInviteUrl(`${window.location.origin}/circles/${circleAddress}`);
    }
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

  // ── Derived membership state ───────────────────────────────────────────────

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

  // ── Contribution check ─────────────────────────────────────────────────────
  //
  // Prefer the authoritative currentRound contributions list when available.
  // When it is absent (partial data), conservatively treat the contribution as
  // unknown (false) — this means the Contribute button may appear for a member
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

  // ── Data readiness ─────────────────────────────────────────────────────────
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
  const actionsEnabled = dataReadiness === "ready" && walletLoadState !== "loading";

  // ── Payout gate (for disabled-state display) ───────────────────────────────
  //
  // Pre-computed with maxSnapshotAgeMs: Infinity so the "round not complete"
  // reason shows up in the button caption even when we're not about to submit.
  // The staleness check is intentionally skipped here — it's handled by the
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
        myMember != null ? BigInt(myMember.collateral || "0") > BigInt(0) : false,
        myContributedThisRound,
        data.currentRound?.contributions.length ?? 0,
        dataFetchedAtMs, // use data fetch time, not snapshot build time
      ),
      { maxSnapshotAgeMs: Infinity },
    );
  })();

  // True when the indexed latest ledger is past the round deadline
  const deadlinePassed =
    data.circle.deadline_ledger != null &&
    data.latestLedger != null &&
    data.latestLedger > data.circle.deadline_ledger;

  // ── Manual refresh ─────────────────────────────────────────────────────────
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
      const messages: Record<typeof result.error, string> = {
        not_found:
          "This circle no longer exists on the indexer. The page may be out of date.",
        network:
          "Could not reach the indexer. Check your connection and try again.",
        server:
          "The indexer returned an error. This is likely temporary — try again.",
      };
      setManualRefreshError(messages[result.error]);
    }

    setIsManualRefreshing(false);
  }, [circleAddress, isManualRefreshing]);

  // ── Post-action refresh ────────────────────────────────────────────────────
  //
  // Called after every successful contract write. Uses the shared fetchCircleData
  // helper so merging is always safe — we replace the whole data object rather
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
    } else if (result.error === "network") {
      // Genuine network failure after action — show warning
      setRefreshState("error");
    } else {
      // Non-fatal: the action succeeded, refresh just failed
      setRefreshState("error");
    }
  }

  // ── Action handler ─────────────────────────────────────────────────────────

  const ACTION_SUCCESS_MESSAGES: Record<ActionKey, string> = {
    join:       "Collateral locked — you have joined the circle!",
    contribute: "Contribution submitted successfully.",
    payout:     "Payout triggered successfully.",
    default:    "Member marked as defaulted.",
    close:      "Collateral released successfully.",
  };

  async function doAction(action: ActionKey, args: xdr.ScVal[] = []) {
    if (!walletAddress) {
      setError("Connect your wallet first.");
      return;
    }
    if (loading !== null) return;

    if (!isSorobanContractId(circleAddress)) {
      setError(
        `Invalid circle address "${shortAddress(circleAddress)}". ` +
          "Expected a C-prefixed 56-character Soroban contract ID.",
      );
      return;
    }

    // ── Data completeness guard ────────────────────────────────────────────
    //
    // Even though the buttons are disabled when dataReadiness !== "ready",
    // re-check here as a defence-in-depth measure in case the UI guard is
    // bypassed (e.g. by automated tests, accessibility tools, or race conditions).
    if (dataReadiness !== "ready") {
      setError(
        dataReadiness === "stale"
          ? "Circle data is out of date. Please refresh the page before submitting a transaction."
          : "Circle data is still loading. Please wait a moment and try again.",
      );
      return;
    }

    setError("");
    setSuccess(null);
    setRetryAction(null);
    if (action === "contribute") setContributionReceipt(null);
    setLoading(action);

    try {
      // ── Stale-state gate ───────────────────────────────────────────────────
      //
      // Build the snapshot using dataFetchedAtMs — the timestamp when the
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
        myMember != null ? BigInt(myMember.collateral || "0") > BigInt(0) : false,
        myContributedThisRound,
        currentRoundContributions,
        dataFetchedAtMs, // ← correct: when the data was fetched, not now
      );

      const gate = computeActionEligibility(action, snapshot);
      if (isGateBlocked(gate)) {
        setError(gate.message);
        if (gate.reason === "stale_snapshot") {
          setRetryAction(() => () => doAction(action, args));
        }
        setLoading(null);
        return;
      }

      // ── Submit transaction ─────────────────────────────────────────────────
      const result = await invokeContract(
        circleAddress,
        action,
        args,
        walletAddress,
      );

      if (!result.success) {
        const errMsg = result.typedError?.message || result.error || "Transaction failed";
        setError(errMsg);
        if (isRetryableError(errMsg)) {
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
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      if (isRetryableError(message)) {
        setRetryAction(() => () => doAction(action, args));
      }
    } finally {
      setLoading(null);
    }
  }

  // ── Action shortcuts ───────────────────────────────────────────────────────

  const handleJoin       = () => doAction("join",       [new Address(walletAddress!).toScVal()]);
  const handleContribute = () => doAction("contribute", [new Address(walletAddress!).toScVal()]);
  const handlePayout     = () => doAction("payout",     []);
  const handleClose      = () => doAction("close",      [new Address(walletAddress!).toScVal()]);

  // ── Copy helpers ───────────────────────────────────────────────────────────

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

  // ── Default flow ───────────────────────────────────────────────────────────

  function handleMarkDefault(memberAddress: string) {
    setDefaultConfirm({ memberAddress, roundIndex: currentRound });
  }

  async function doDefault(memberAddress: string) {
    if (!walletAddress) {
      setError("Connect your wallet first.");
      return;
    }
    if (loading !== null) return;
    if (!isSorobanContractId(circleAddress)) {
      setError(
        `Invalid circle address "${shortAddress(circleAddress)}". ` +
          "Expected a C-prefixed 56-character Soroban contract ID.",
      );
      return;
    }

    // Data completeness guard — same defence-in-depth as doAction
    if (dataReadiness !== "ready") {
      setError(
        dataReadiness === "stale"
          ? "Circle data is out of date. Please refresh before marking a default."
          : "Circle data is still loading. Wait a moment and try again.",
      );
      return;
    }

    // Clear stale action state before the gate check so the user always sees
    // fresh output for this attempt.
    setError("");
    setSuccess(null);
    setRetryAction(null);

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
      dataFetchedAtMs, // ← correct: use data fetch time
    );

    const gate = computeActionEligibility("default", snapshot);
    if (isGateBlocked(gate)) {
      setError(gate.message);
      if (gate.reason === "stale_snapshot") {
        setRetryAction(() => () => doDefault(memberAddress));
      }
      return;
    }

    setLoading("default");

    try {
      const result = await invokeContract(
        circleAddress,
        "mark_default",
        [new Address(memberAddress).toScVal()],
        walletAddress,
      );
      if (!result.success) {
        const errMsg = result.typedError?.message || result.error || "Transaction failed";
        setError(errMsg);
        if (isRetryableError(errMsg)) {
          setRetryAction(() => () => doDefault(memberAddress));
        }
      } else {
        setSuccess({
          message: `${shortAddress(memberAddress)} marked as defaulted for round ${currentRound}.`,
          txHash: result.txHash,
        });
        const ctrl = new AbortController();
        await postActionRefresh(ctrl);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      if (isRetryableError(message)) {
        setRetryAction(() => () => doDefault(memberAddress));
      }
    } finally {
      setLoading(null);
    }
  }

  // ── Accessibility ──────────────────────────────────────────────────────────

  const totalRounds = data.circle.total_rounds;
  const progressAnnouncement =
    `Circle status: ${data.circle.status}.` +
    (Number.isFinite(totalRounds) && totalRounds > 0
      ? ` Round ${Math.max(0, currentRound)} of ${totalRounds}.`
      : "");

  const successTxUrl = success?.txHash
    ? getExplorerLink(ACTIVE_NETWORK, "tx", success.txHash)
    : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">

      {/* Live announcement of status / round changes */}
      <p className="sr-only" role="status" aria-live="polite">
        {progressAnnouncement}
      </p>

      {/* Data state banners — shown above the action panel so the user
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
          Refreshing circle data…
        </div>
      )}

      {manualRefreshError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 flex items-start gap-3 text-sm text-red-700"
        >
          <span className="text-xl mt-0.5" aria-hidden="true">⚠️</span>
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

        {success && (
          <div
            className="bg-brand-50 border border-brand-200 rounded-lg p-3 text-sm text-brand-700 mb-3 space-y-2 focus:outline-none"
            role="status"
            aria-live="polite"
            ref={successRegionRef}
            tabIndex={-1}
          >
            <p>
              <span aria-hidden="true">✅ </span>
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
                Refreshing circle data…
              </p>
            )}
            {refreshState === "error" && (
              <p className="text-xs text-amber-700">
                ⚠️ Could not refresh data automatically —{" "}
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
            role="alertdialog"
            aria-modal="false"
            aria-labelledby="default-confirm-title"
            className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-3 space-y-3"
          >
            <h3
              id="default-confirm-title"
              className="font-semibold text-amber-900 text-sm"
            >
              ⚠️ Confirm Default
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
                onClick={() => setDefaultConfirm(null)}
                className="px-3 py-2 text-sm rounded-lg border border-amber-400 text-amber-800 hover:bg-amber-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const addr = defaultConfirm.memberAddress;
                  setDefaultConfirm(null);
                  doDefault(addr);
                }}
                disabled={loading !== null || !actionsEnabled}
                className="px-3 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Confirm &amp; Sign
              </button>
            </div>
          </div>
        )}

        <div className="action-group">
          {/* Wallet loading placeholder — prevents layout shift while wallet check is in flight */}
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
              Checking wallet…
            </span>
          )}

          {data.circle.status === "Pending" && isMember && !hasLockedCollateral && (
            <button
              onClick={handleJoin}
              disabled={loading !== null || !actionsEnabled}
              aria-busy={loading === "join" ? "true" : "false"}
              aria-disabled={!actionsEnabled}
              title={!actionsEnabled ? "Actions unavailable until circle data is fully loaded" : undefined}
              className="bg-brand-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[44px]"
            >
              {loading === "join" ? "Joining…" : "🔒 Lock Collateral & Join"}
            </button>
          )}

          {data.circle.status === "Active" &&
            isMember &&
            !myContributedThisRound && (
              <button
                onClick={handleContribute}
                disabled={loading !== null || !actionsEnabled}
                aria-busy={loading === "contribute" ? "true" : "false"}
                aria-disabled={!actionsEnabled}
                title={!actionsEnabled ? "Actions unavailable until circle data is fully loaded" : undefined}
                className="bg-brand-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[44px]"
              >
                {loading === "contribute"
                  ? "Contributing…"
                  : `💰 Contribute Round ${currentRound}`}
              </button>
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
                {loading === "payout" ? "Paying out…" : "🎯 Trigger Payout"}
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
            <button
              onClick={handleClose}
              disabled={loading !== null || !actionsEnabled}
              aria-busy={loading === "close" ? "true" : "false"}
              aria-disabled={!actionsEnabled}
              title={!actionsEnabled ? "Actions unavailable until circle data is fully loaded" : undefined}
              className="bg-slate-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[44px]"
            >
              {loading === "close" ? "Closing…" : "🔓 Release Collateral"}
            </button>
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
              Waiting for wallet…
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
            <span aria-hidden="true">💳 </span>Contribution Receipt
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
      />

      {/* Rotation view */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-800 mb-4">🔄 Rotation Order</h2>
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
                        <span aria-hidden="true">⚠️ </span>
                        {member.defaults} default
                        {member.defaults > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-right text-sm shrink-0 max-w-[45%] sm:max-w-none">
                  {isPaid ? (
                    <span className="text-slate-500 text-xs sm:text-sm">
                      <span aria-hidden="true">✅ </span>
                      received ${formatUsdc(roundForMember?.amount ?? "0")}
                    </span>
                  ) : isNext ? (
                    <span className="text-brand-700 font-semibold text-xs sm:text-sm">
                      <span aria-hidden="true">← </span>
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
                            disabled={loading !== null}
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
            Round {currentRound} · contributions shown for the current round only
          </p>
        )}
      </div>

      {/* Round history */}
      {data.rounds.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="font-semibold text-slate-800 mb-4">📋 Round History</h2>
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
            ⏳ Open Rounds
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
            ⚠️ Defaults (current round)
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

      {/* Invite link */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-700 mb-2">🔗 Invite link</h2>
        <p className="text-xs text-slate-500 mb-2">
          Share this link so members can find and join this circle:
        </p>
        <div className="flex gap-2">
          <input
            readOnly
            value={inviteUrl}
            className="flex-1 min-w-0 font-mono text-xs bg-white border border-slate-300 rounded px-3 py-2 text-slate-600 placeholder:text-slate-400"
            onClick={(e) => (e.target as HTMLInputElement).select()}
            aria-label="Invite link for this circle"
            placeholder="Loading invite link…"
          />
          <button
            onClick={handleCopyInvite}
            disabled={!inviteUrl}
            className="shrink-0 text-xs font-medium px-3 py-2 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label={
              inviteCopyState === "success"
                ? "Link copied!"
                : inviteCopyState === "error"
                ? "Copy failed — try selecting and copying manually"
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

// ─── RoundCard ────────────────────────────────────────────────────────────────

interface RoundCardProps {
  round: CircleRound;
}

function RoundCard({ round }: RoundCardProps) {
  const statusLabel: Record<CircleRound["status"], string> = {
    completed: "",
    current:   "in progress",
    cancelled: "cancelled",
    open:      "open",
  };

  const statusColor: Record<CircleRound["status"], string> = {
    completed: "",
    current:   "text-amber-700 bg-amber-50 border-amber-200",
    cancelled: "text-slate-600 bg-slate-100 border-slate-300",
    open:      "text-amber-700 bg-amber-50 border-amber-200",
  };

  const txUrl = round.txHash
    ? getExplorerLink(ACTIVE_NETWORK, "tx", round.txHash)
    : null;

  return (
    <div className="border border-slate-100 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-slate-800">
            Round {round.roundIndex}
          </h3>
          {round.status !== "completed" && (
            <span
              className={`text-xs font-medium border rounded-full px-2 py-0.5 ${statusColor[round.status]}`}
            >
              {statusLabel[round.status]}
            </span>
          )}
        </div>

        {round.txHash ? (
          txUrl ? (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-brand-600 hover:underline font-mono"
              title={round.txHash}
            >
              {shortAddress(round.txHash)}
            </a>
          ) : (
            <span className="text-xs text-slate-500 font-mono" title={round.txHash}>
              {shortAddress(round.txHash)}
            </span>
          )
        ) : (
          <span className="text-xs text-slate-400 italic">awaiting payout</span>
        )}
      </div>

      {round.status === "completed" &&
        round.amount != null &&
        round.recipient != null ? (
        <p className="text-sm text-slate-600">
          <span aria-hidden="true">🎯 </span>
          ${formatUsdc(round.amount)} paid to{" "}
          <span className="font-mono">{shortAddress(round.recipient)}</span>
        </p>
      ) : (
        <p className="text-sm text-slate-500 italic">Payout not yet triggered</p>
      )}

      <p className="text-xs text-slate-400 mt-1">
        {round.contributions.length} contribution
        {round.contributions.length !== 1 ? "s" : ""}
        {round.defaults.length > 0 && (
          <span className="text-red-500 ml-2">
            · {round.defaults.length} default
            {round.defaults.length > 1 ? "s" : ""}
          </span>
        )}
      </p>
    </div>
  );
}

// ─── ContributionStatusBadge ──────────────────────────────────────────────────

interface ContributionStatusBadgeProps {
  status: "contributed" | "pending" | "defaulted" | "not_applicable";
}

function ContributionStatusBadge({ status }: ContributionStatusBadgeProps) {
  switch (status) {
    case "contributed":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
          <span aria-hidden="true">✓</span>
          <span className="sr-only">Contribution status: </span>
          contributed
        </span>
      );
    case "pending":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
          <span aria-hidden="true">⏳</span>
          <span className="sr-only">Contribution status: </span>
          pending
        </span>
      );
    case "defaulted":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
          <span aria-hidden="true">✗</span>
          <span className="sr-only">Contribution status: </span>
          defaulted
        </span>
      );
    case "not_applicable":
    default:
      return (
        <span className="text-slate-400 text-xs">
          <span className="sr-only">Contribution status: </span>
          waiting
        </span>
      );
  }
}
