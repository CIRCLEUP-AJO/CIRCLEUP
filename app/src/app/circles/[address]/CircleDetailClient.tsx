"use client";
import { useState, useEffect } from "react";
import { Address, xdr } from "@stellar/stellar-sdk";
import { getWalletAddress, invokeContract } from "@/lib/stellar";
import { shortAddress, formatUsdc, INDEXER_URL } from "@/lib/config";
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
  recipient: string;
  amount: string;
  txHash: string;
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
  rounds: CircleRound[];
  pendingDefaults: CirclePendingDefault[];
  /** Latest ledger the indexer has processed (used for countdown math) */
  latestLedger?: number | null;
}

interface Props {
  circleAddress: string;
  circleData: CircleDetailData;
}

// ─── Action key type ──────────────────────────────────────────────────────────
//
// Constraining the loading key to the four real actions prevents accidental
// typos from leaving the spinner stuck forever.

type ActionKey = "join" | "contribute" | "payout" | "close";

// ─── Success state shape ──────────────────────────────────────────────────────

interface SuccessState {
  message: string;
  txHash?: string;
}

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

// ─── Success state type ───────────────────────────────────────────────────────

interface SuccessState {
  message: string;
  txHash: string;
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
  const [loading, setLoading] = useState<ActionKey | null>(null);
  const [error,   setError]   = useState<string>("");
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [data,    setData]    = useState<CircleDetailData>(circleData);
  // Invite link URL — populated client-side to avoid SSR window access
  const [inviteUrl, setInviteUrl] = useState("");

  useEffect(() => {
    getWalletAddress().then(setWalletAddress);
  }, []);

  useEffect(() => {
    // Safe: this effect only runs in the browser
    setInviteUrl(window.location.href);
  }, []);

  const isMember = walletAddress
    ? data.members.some((m) => m.member_address === walletAddress)
    : false;

  const currentRound = data.circle.current_round;

  // A member has contributed to the current round when their
  // total_contributions count exceeds the (0-indexed) current round index.
  const myContributedThisRound = walletAddress
    ? data.members.some(
        (m) =>
          m.member_address === walletAddress &&
          Number(m.total_contributions) > currentRound,
      )
    : false;

  /** Returns true when the error looks like a timeout or network failure. */
  function isRetryableError(err: string): boolean {
    const lower = err.toLowerCase();
    return (
      lower.includes("timeout") ||
      lower.includes("timed out") ||
      lower.includes("network") ||
      lower.includes("fetch") ||
      lower.includes("connection")
    );
  }

  async function doAction(action: ActionKey, args: xdr.ScVal[] = []) {
    if (!walletAddress) {
      setError("Connect your wallet first.");
      return;
    }
    // Guard: prevent a second call while one is already in flight
    if (loading !== null) return;

    setError("");
    setSuccess(null);
    setLoading(action);
    try {
      const result = await invokeContract(
        circleAddress,
        action,
        args,
        walletAddress,
      );
      if (!result.success) {
        setError(result.error || "Transaction failed");
      } else {
        setSuccess({
          message: `${action} successful!`,
          txHash: result.txHash,
        });
        // Refresh circle data after a successful action
        try {
          const res = await fetch(`${INDEXER_URL}/circles/${circleAddress}`, {
            cache: "no-store",
          });
          if (res.ok) {
            const updated = (await res.json()) as Partial<CircleDetailData>;
            setData((prev) => ({ ...prev, ...updated }));
          }
        } catch {
          // Data refresh failure is non-fatal — the action already succeeded
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(null);
    }
  }

  // Each handler guards with the `loading` check inside doAction,
  // so even if the button is somehow clicked twice only one call fires.
  const handleJoin       = () => doAction("join",       [new Address(walletAddress!).toScVal()]);
  const handleContribute = () => doAction("contribute", [new Address(walletAddress!).toScVal()]);
  const handlePayout     = () => doAction("payout",     []);
  const handleClose      = () => doAction("close",      []);

  return (
    <div className="space-y-8">

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
            className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-3"
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
            className="bg-brand-50 border border-brand-200 rounded-lg p-3 text-sm text-brand-700 mb-3 space-y-2"
            role="status"
            aria-live="polite"
          >
            <p>✅ {success.message}</p>
            {success.txHash && (
              <p className="text-xs">
                Tx:{" "}
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${success.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono underline hover:text-brand-900"
                  title={success.txHash}
                >
                  {shortAddress(success.txHash)}
                </a>
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          {data.circle.status === "Pending" && isMember && (
            <button
              onClick={handleJoin}
              disabled={loading !== null}
              aria-busy={loading === "join" ? "true" : "false"}
              className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
                className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading === "contribute"
                  ? "Contributing…"
                  : `💰 Contribute Round ${currentRound}`}
              </button>
            )}

          {data.circle.status === "Active" && (
            <button
              onClick={handlePayout}
              disabled={loading !== null}
              aria-busy={loading === "payout" ? "true" : "false"}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading === "payout" ? "Paying out…" : "🎯 Trigger Payout"}
            </button>
          )}

          {(data.circle.status === "Completed" ||
            data.circle.status === "Cancelled") && (
            <button
              onClick={handleClose}
              disabled={loading !== null}
              aria-busy={loading === "close" ? "true" : "false"}
              className="bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
            const roundForMember = data.rounds.find((r) => r.roundIndex === i);

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
                  "flex items-center gap-3 p-3 rounded-lg border transition-all",
                  isNext
                    ? "border-brand-400 bg-brand-50"
                    : isPaid
                    ? "border-slate-200 bg-slate-50 opacity-75"
                    : "border-slate-200 bg-white",
                )}
              >
                <span className="text-slate-400 text-sm w-5 text-right">
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
                        ⚠️ {member.defaults} default
                        {member.defaults > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>

                {/* Right-hand status column */}
                <div className="text-right text-sm shrink-0">
                  {isPaid ? (
                    // Past round recipient
                    <span className="text-slate-500">
                      ✅ received ${formatUsdc(roundForMember?.amount ?? "0")}
                    </span>
                  ) : isNext ? (
                    <span className="text-brand-700 font-semibold">
                      ← next payout
                    </span>
                  ) : (
                    // Future slot — show per-member contribution status for active circles
                    <ContributionStatusBadge status={contribStatus} />
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
              <div
                key={round.roundIndex}
                className="border border-slate-100 rounded-lg p-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium text-slate-800">
                    Round {round.roundIndex}
                  </h3>
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${round.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-brand-600 hover:underline font-mono"
                    title={round.txHash}
                  >
                    {shortAddress(round.txHash)}
                  </a>
                </div>
                <p className="text-sm text-slate-600">
                  🎯 ${formatUsdc(round.amount)} paid to{" "}
                  <span className="font-mono">
                    {shortAddress(round.recipient)}
                  </span>
                </p>
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
                className="flex items-center justify-between text-sm text-red-700 bg-red-100 rounded-lg px-3 py-2"
              >
                <span className="font-mono">{shortAddress(d.member_address)}</span>
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
        <input
          readOnly
          value={inviteUrl}
          className="w-full font-mono text-xs bg-white border border-slate-300 rounded px-3 py-2 text-slate-600"
          onClick={(e) => (e.target as HTMLInputElement).select()}
          aria-label="Invite link"
          placeholder="Loading URL…"
        />
      </div>
    </div>
  );
}

// ─── getMemberContributionStatus ─────────────────────────────────────────────
//
// Determines a member's contribution status for the current active round.
//
// Logic:
//   - "not_applicable" → circle is not Active, or the member is the next payout
//                         recipient (payout_order === current_round)
//   - "contributed"    → member's total_contributions count is > current_round
//                         index (they have already paid for this round)
//   - "defaulted"      → member has at least one default and has NOT contributed
//   - "pending"        → anything else (active round, no contribution yet)

function getMemberContributionStatus(
  member: CircleMember,
  currentRound: number,
  status: string,
): "contributed" | "pending" | "defaulted" | "not_applicable" {
  if (status !== "Active") return "not_applicable";
  // The next payout recipient is index currentRound — they don't contribute
  if (member.payout_order === currentRound) return "not_applicable";

  const hasContributed = Number(member.total_contributions) > currentRound;
  if (hasContributed) return "contributed";
  if (member.defaults > 0) return "defaulted";
  return "pending";
}

// ─── Contribution status badge ────────────────────────────────────────────────

interface ContributionStatusBadgeProps {
  status: "contributed" | "pending" | "defaulted" | "not_applicable";
}

function ContributionStatusBadge({ status }: ContributionStatusBadgeProps) {
  switch (status) {
    case "contributed":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
          ✓ contributed
        </span>
      );
    case "pending":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
          ⏳ pending
        </span>
      );
    case "defaulted":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
          ✗ defaulted
        </span>
      );
    case "not_applicable":
    default:
      return <span className="text-slate-400 text-xs">waiting</span>;
  }
}
