"use client";
import { useState, useEffect, useRef } from "react";
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
//
// Constraining the loading key to the four real actions prevents accidental
// typos from leaving the spinner stuck forever.

type ActionKey = "join" | "contribute" | "payout" | "default" | "close";

// ─── Success state shape ──────────────────────────────────────────────────────

interface SuccessState {
  message: string;
  txHash?: string;
}

// ─── Data-refresh state ───────────────────────────────────────────────────────
//
// Tracks whether the post-action background refresh is in flight so we can
// show a subtle "updating…" indicator rather than stale data silently persisting.

type RefreshState = "idle" | "refreshing" | "error";

// ─── Contribution receipt ──────────────────────────────────────────────────────
//
// Captures key fields from a confirmed contribute transaction so the receipt
// persists through data refreshes and is not cleared when success state changes.

interface ContributionReceipt {
  amount: string;
  roundIndex: number;
  txHash: string;
  explorerUrl: string | null;
}

// ─── Default confirmation ──────────────────────────────────────────────────────
//
// Holds the identity of the member being defaulted while the user reviews the
// confirmation panel. Cleared on cancel (no transaction) or on execute.

interface DefaultConfirmState {
  memberAddress: string;
  roundIndex: number;
}

// ─── Copy feedback ────────────────────────────────────────────────────────────

type CopyState = "idle" | "success" | "error";

// ─── Round deadline countdown ─────────────────────────────────────────────────

const SECONDS_PER_LEDGER = 5;

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

// ─── Workflow explanation banner ──────────────────────────────────────────────
//
// Shown to members who are on a Pending or Active circle to explain what the
// next step is and what it means. Hides once the circle is Completed/Cancelled.

interface WorkflowBannerProps {
  status: string;
  isMember: boolean;
  walletAddress: string | null;
  alreadyContributed: boolean;
  currentRound: number;
  totalRounds: number;
}

function WorkflowBanner({
  status,
  isMember,
  walletAddress,
  alreadyContributed,
  currentRound,
  totalRounds,
}: WorkflowBannerProps) {
  if (status === "Completed" || status === "Cancelled") return null;

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
//
// Determines whether a member has contributed, is pending, or has defaulted
// for the current active round. Returns "not_applicable" for non-active
// circles or for the recipient slot itself.

function getMemberContributionStatus(
  member: CircleMember,
  currentRound: number,
  status: string,
): "contributed" | "pending" | "defaulted" | "not_applicable" {
  if (status !== "Active") return "not_applicable";
  // The recipient slot for this round is handled separately in the render
  if (member.payout_order === currentRound) return "not_applicable";
  // total_contributions is 0-indexed: if it's > currentRound the member has
  // already contributed this round.
  if (Number(member.total_contributions) > currentRound) return "contributed";
  if (member.defaults > 0) return "defaulted";
  return "pending";
}

// ─── Main client component ────────────────────────────────────────────────────

export function CircleDetailClient({ circleAddress, circleData }: Props) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  // null  → no action in flight; ActionKey → that specific action is running
  const [loading,      setLoading]      = useState<ActionKey | null>(null);
  const [error,        setError]        = useState<string>("");
  const [success,      setSuccess]      = useState<SuccessState | null>(null);
  const [retryAction,  setRetryAction]  = useState<(() => void) | null>(null);
  const [data,         setData]         = useState<CircleDetailData>(circleData);
  const [refreshState, setRefreshState] = useState<RefreshState>("idle");
  // Invite link URL — populated client-side to avoid SSR window access
  const [inviteUrl, setInviteUrl] = useState("");
  const [contributionReceipt, setContributionReceipt] = useState<ContributionReceipt | null>(null);
  const [defaultConfirm, setDefaultConfirm] = useState<DefaultConfirmState | null>(null);
  const [inviteCopyState, setInviteCopyState] = useState<CopyState>("idle");
  const [receiptCopyState, setReceiptCopyState] = useState<CopyState>("idle");

  // Refs for focus management: move focus to error/success regions after an
  // action completes so keyboard users are not left stranded on the button.
  const errorRegionRef  = useRef<HTMLDivElement>(null);
  const successRegionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getWalletAddress().then(setWalletAddress);
  }, []);

  useEffect(() => {
    // Safe: window is only accessed inside useEffect, which never runs on the
    // server. During SSR the input renders with an empty string and the
    // placeholder text is shown instead.
    if (typeof window !== "undefined") {
      setInviteUrl(`${window.location.origin}/circles/${circleAddress}`);
    }
  }, []);

  // Focus management: when an error appears, move keyboard focus to the error
  // region so screen-reader users are immediately positioned on the message.
  // tabIndex={-1} on the error div allows programmatic focus.
  useEffect(() => {
    if (error && errorRegionRef.current) {
      errorRegionRef.current.focus();
    }
  }, [error]);

  // Focus management: when a success message appears, move focus to the
  // confirmation region so the user knows the action completed.
  useEffect(() => {
    if (success && successRegionRef.current) {
      successRegionRef.current.focus();
    }
  }, [success]);

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

  // Determine whether the connected wallet has already contributed this round.
  //
  // Preferred: check the actual contribution list for the current round returned
  // by the indexer's /rounds endpoint (data.currentRound.contributions).
  // This is accurate regardless of how many rounds have elapsed.
  //
  // Fallback: total_contributions > currentRound (a lifetime count). This can
  // over-count if the indexer hasn't processed the latest round yet, so it is
  // only used when data.currentRound is not yet available.
  const myContributedThisRound = walletAddress
    ? data.currentRound != null
      ? data.currentRound.contributions.some(
          (c) => c.member_address === walletAddress,
        )
      : data.members.some(
          (m) =>
            m.member_address === walletAddress &&
            Number(m.total_contributions) > currentRound,
        )
    : false;

  // Pre-compute payout eligibility for disabled-state display. maxSnapshotAgeMs
  // is Infinity here — we only want the "round not complete" reason; the staleness
  // guard fires on submit inside doAction where it counts.
  const payoutGate = computeActionEligibility(
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
    ),
    { maxSnapshotAgeMs: Infinity },
  );

  // True when the indexed latest ledger is past the round deadline, enabling
  // the "Mark Default" button in the member list.
  const deadlinePassed =
    data.circle.deadline_ledger != null &&
    data.latestLedger != null &&
    data.latestLedger > data.circle.deadline_ledger;

  /** Returns true when the error looks like a timeout or network failure that is worth retrying. */
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
    // Guard: prevent a second call while one is already in flight
    if (loading !== null) return;

    // ── Route-param validation ─────────────────────────────────────────────
    // circleAddress comes from the Next.js URL segment and is never sanitised
    // by the router. Reject it early — before any RPC call — so a malformed or
    // injected address fails with a clear UI message rather than a cryptic SDK
    // error deep inside invokeContract.
    if (!isSorobanContractId(circleAddress)) {
      setError(
        `Invalid circle address "${shortAddress(circleAddress)}". ` +
          "Expected a C-prefixed 56-character Soroban contract ID.",
      );
      return;
    }

    setError("");
    setSuccess(null);
    setRetryAction(null);
    if (action === "contribute") setContributionReceipt(null);
    setLoading(action);

    try {
      // ── Stale-state protection ─────────────────────────────────────────────
      //
      // Build a snapshot from the component's current data object and run the
      // canonical gate check before submitting any transaction.  This ensures
      // that if the circle state changed on-chain since the last data refresh
      // (e.g. another member already contributed, payout already ran, or the
      // round deadline passed) the action is blocked immediately with a clear
      // message instead of producing an on-chain contract error.
      //
      // contributionsReceived is derived from the current round's contributions
      // list when available, otherwise falls back to the member count heuristic.
      const currentRoundContributions =
        data.currentRound?.contributions.length ?? 0;

      const snapshot = buildAppSnapshot(
        data.circle.status,
        data.circle.current_round,
        data.circle.deadline_ledger,
        data.latestLedger,
        data.members.map((m) => m.member_address),
        /* hasLockedCollateral */ myMember != null
          ? BigInt(myMember.collateral || "0") > BigInt(0)
          : false,
        /* hasContributedCurrentRound */ myContributedThisRound,
        /* contributionsReceived */ currentRoundContributions,
      );

      const gate = computeActionEligibility(action, snapshot);
      if (isGateBlocked(gate)) {
        setError(gate.message);
        // Stale snapshots are always retryable — the user just needs to refresh.
        // Other block reasons (wrong_status, already_contributed, etc.) are not
        // transient so we don't show a retry link for them.
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
        // Prefer the typed error message — it's the canonical user-facing copy
        // from contractErrors.ts; fall back to the raw error string if somehow
        // typedError is not set (e.g. legacy call path).
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
        // Refresh circle data after a successful action
        setRefreshState("refreshing");
        const refreshController = new AbortController();
        try {
          const [circleRes, roundsRes] = await Promise.all([
            fetch(`${INDEXER_URL}/circles/${circleAddress}`, { cache: "no-store", signal: refreshController.signal }),
            fetch(`${INDEXER_URL}/circles/${circleAddress}/rounds`, { cache: "no-store", signal: refreshController.signal }),
          ]);
          if (circleRes.ok) {
            const updatedCircle = (await circleRes.json()) as Partial<CircleDetailData>;
            const updatedRounds = roundsRes.ok
              ? ((await roundsRes.json()) as Partial<CircleDetailData>)
              : {};
            setData((prev) => ({ ...prev, ...updatedCircle, ...updatedRounds }));
          }
          setRefreshState("idle");
        } catch (refreshErr) {
          // Aborted refreshes (unmount during refresh) are silent — not an error.
          if (refreshErr instanceof DOMException && refreshErr.name === "AbortError") {
            setRefreshState("idle");
          } else {
            // Data refresh failure is non-fatal — the action already succeeded.
            // Show a subtle warning so the user knows to refresh manually.
            setRefreshState("error");
          }
        }
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

  // Each handler guards with the `loading` check inside doAction,
  // so even if the button is somehow clicked twice only one call fires.
  const handleJoin       = () => doAction("join",       [new Address(walletAddress!).toScVal()]);
  const handleContribute = () => doAction("contribute", [new Address(walletAddress!).toScVal()]);
  const handlePayout     = () => doAction("payout",     []);
  const handleClose      = () => doAction("close",      [new Address(walletAddress!).toScVal()]);

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

    // Build a snapshot with the TARGET member's contribution status, not the
    // caller's — gateDefault checks whether the member being defaulted has
    // already contributed, not whether the invoking wallet has.
    const targetContributed =
      data.currentRound != null
        ? data.currentRound.contributions.some(
            (c) => c.member_address === memberAddress,
          )
        : data.members.some(
            (m) =>
              m.member_address === memberAddress &&
              Number(m.total_contributions) > currentRound,
          );

    const snapshot = buildAppSnapshot(
      data.circle.status,
      currentRound,
      data.circle.deadline_ledger,
      data.latestLedger,
      data.members.map((m) => m.member_address),
      false,
      targetContributed,
      data.currentRound?.contributions.length ?? 0,
    );

    const gate = computeActionEligibility("default", snapshot);
    if (isGateBlocked(gate)) {
      setError(gate.message);
      if (gate.reason === "stale_snapshot") {
        setRetryAction(() => () => doDefault(memberAddress));
      }
      return;
    }

    setError("");
    setSuccess(null);
    setRetryAction(null);
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
        setRefreshState("refreshing");
        const ctrl = new AbortController();
        try {
          const [circleRes, roundsRes] = await Promise.all([
            fetch(`${INDEXER_URL}/circles/${circleAddress}`, {
              cache: "no-store",
              signal: ctrl.signal,
            }),
            fetch(`${INDEXER_URL}/circles/${circleAddress}/rounds`, {
              cache: "no-store",
              signal: ctrl.signal,
            }),
          ]);
          if (circleRes.ok) {
            const updatedCircle = (await circleRes.json()) as Partial<CircleDetailData>;
            const updatedRounds = roundsRes.ok
              ? ((await roundsRes.json()) as Partial<CircleDetailData>)
              : {};
            setData((prev) => ({ ...prev, ...updatedCircle, ...updatedRounds }));
          }
          setRefreshState("idle");
        } catch (refreshErr) {
          if (refreshErr instanceof DOMException && refreshErr.name === "AbortError") {
            setRefreshState("idle");
          } else {
            setRefreshState("error");
          }
        }
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

  // Spoken summary of circle status + round progress. Rendered in a polite
  // live region below so screen-reader users hear "Circle status: Active.
  // Round 3 of 10." whenever an action (contribute / payout / close) refreshes
  // the circle data. The round fragment is omitted when total_rounds is
  // missing or invalid rather than announcing "Round 0 of 0".
  const totalRounds = data.circle.total_rounds;
  const progressAnnouncement =
    `Circle status: ${data.circle.status}.` +
    (Number.isFinite(totalRounds) && totalRounds > 0
      ? ` Round ${Math.max(0, currentRound)} of ${totalRounds}.`
      : "");

  // Network-aware explorer link for the last successful action's transaction.
  // Null on unsupported/custom networks — the hash is then shown as plain text.
  const successTxUrl = success?.txHash
    ? getExplorerLink(ACTIVE_NETWORK, "tx", success.txHash)
    : null;

  return (
    <div className="space-y-8">

      {/* Live announcement of status / round changes. Must be present from
          the first render — live regions added later are not announced. */}
      <p className="sr-only" role="status" aria-live="polite">
        {progressAnnouncement}
      </p>

      {/* Workflow explanation */}
      <WorkflowBanner
        status={data.circle.status}
        isMember={isMember}
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
                ⚠️ Could not refresh data automatically — reload the page to see the latest state.
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
                disabled={loading !== null}
                className="px-3 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Confirm &amp; Sign
              </button>
            </div>
          </div>
        )}

        <div className="action-group">
          {data.circle.status === "Pending" && isMember && !hasLockedCollateral && (
            <button
              onClick={handleJoin}
              disabled={loading !== null}
              aria-busy={loading === "join" ? "true" : "false"}
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
                disabled={loading !== null}
                aria-busy={loading === "contribute" ? "true" : "false"}
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
                disabled={loading !== null || !payoutGate.allowed}
                aria-busy={loading === "payout" ? "true" : "false"}
                aria-describedby={!payoutGate.allowed ? "payout-gate-reason" : undefined}
                className="bg-blue-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[44px]"
              >
                {loading === "payout" ? "Paying out…" : "🎯 Trigger Payout"}
              </button>
              {!payoutGate.allowed && (
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
              disabled={loading !== null}
              aria-busy={loading === "close" ? "true" : "false"}
              className="bg-slate-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors min-h-[44px]"
            >
              {loading === "close" ? "Closing…" : "🔓 Release Collateral"}
            </button>
          )}

          {/* Global spinner label when any action is running */}
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

      {/* Contribution receipt — persists after confirmation; clears when a new
          contribute action starts. Shows amount, round, and a copyable hash. */}
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

            // Contribution status for the current active round
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

                {/* Right-hand status column — shrink-0 keeps it visible on narrow screens */}
                <div className="text-right text-sm shrink-0 max-w-[45%] sm:max-w-none">
                  {isPaid ? (
                    // Past round recipient
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
                    // Future slot — show per-member contribution status for active circles
                    <div className="flex flex-col items-end gap-1">
                      <ContributionStatusBadge status={contribStatus} />
                      {contribStatus === "pending" &&
                        data.circle.status === "Active" &&
                        deadlinePassed && (
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

      {/* Round history — completed rounds only (have a payout). */}
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

      {/* Open rounds — rounds with recorded activity (contributions / defaults)
          but no payout yet and not the circle's current round.
          These were previously silently dropped (issue #170). */}
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

      {/* Invite link — URL is built from circleAddress + origin so it is
          identical across server-rendered and client-rendered contexts. */}
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
//
// Renders a single round row in both the "Round History" (completed) and
// "Open Rounds" (unpaid-with-activity) sections.  All payout fields are
// nullable — this component guards every access so the page never crashes on
// an in-progress or open round.

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

  // Network-aware explorer link for this round's payout tx. Null on
  // unsupported/custom networks — the hash is then shown as plain text.
  const txUrl = round.txHash
    ? getExplorerLink(ACTIVE_NETWORK, "tx", round.txHash)
    : null;

  return (
    <div className="border border-slate-100 rounded-lg p-4">
      {/* Header row: round number + status badge (left) / tx link (right) */}
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

      {/* Payout summary — only shown when a payout exists */}
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

      {/* Contribution / default counts */}
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

// ─── Contribution status badge ────────────────────────────────────────────────

interface ContributionStatusBadgeProps {
  status: "contributed" | "pending" | "defaulted" | "not_applicable";
}

// The leading glyphs (✓ / ⏳ / ✗) are decorative — screen readers would
// otherwise announce them literally ("check mark contributed"), so they are
// hidden and an sr-only "Contribution status:" prefix gives the bare word
// context when the badge is read on its own.

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
