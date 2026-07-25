"use client";
import { useState, useEffect } from "react";
import { Address, xdr } from "@stellar/stellar-sdk";
import { getWalletAddress, invokeContract } from "@/lib/stellar";
import { shortAddress, formatUsdc, INDEXER_URL } from "@/lib/config";
import { ReputationBadge } from "@/components/ReputationBadge";
import clsx from "clsx";

// ─── Types (exported so page.tsx can import the canonical shape) ──────────────

export interface CircleMember {
  member_address: string;
  payout_order: number;
  collateral: string;
  defaults: number;
  joined_at: string | null;
  reputation_score: number;
  total_contributions: number;
}

export interface CircleRound {
  roundIndex: number;
  recipient: string;
  amount: string;
  txHash: string;
  contributions: unknown[];
  defaults: unknown[];
}

export interface CirclePendingDefault {
  member_address: string;
  penalty: string;
}

export interface CircleState {
  status: string;
  current_round: number;
  total_rounds: number;
  round_amount: string;
  member_count: number;
  /** Computed deadline ledger for the current active round (null if unknown) */
  deadline_ledger?: number | null;
}

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

// ─── Round deadline countdown ──────────────────────────────────────────────────
//
// Stellar produces a ledger roughly every 5 seconds. Given:
//   • deadline_ledger  – the ledger at which the current round expires
//   • latestLedger     – the most recent ledger the indexer has seen
//
// We compute ledgers remaining, convert to a wall-clock estimate, and display a
// live countdown that ticks every second using a client-side interval.
//
// When deadline_ledger is null (circle predates the migration, or not Active)
// we show a neutral fallback rather than a misleading value.

const SECONDS_PER_LEDGER = 5;

function ledgersToHuman(ledgers: number): string {
  if (ledgers <= 0) return "overdue";
  const totalSeconds = ledgers * SECONDS_PER_LEDGER;
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

interface DeadlineProps {
  deadlineLedger: number | null | undefined;
  latestLedger: number | null | undefined;
  status: string;
}

function RoundDeadlineStatus({ deadlineLedger, latestLedger, status }: DeadlineProps) {
  // Tick every second so the display stays live without a full re-fetch
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

  // ledgersRemaining is a static snapshot from the last indexer poll.
  // The 1-second interval above re-renders to keep the display visually alive,
  // but the ledger count only advances when the indexer refetches.
  const ledgersRemaining = deadlineLedger - latestLedger;
  const isOverdue = ledgersRemaining <= 0;
  const human = ledgersToHuman(ledgersRemaining);

  // Color band: > 2 days → green, 1–2 days → yellow, < 1 day → red
  const totalSecondsRemaining = ledgersRemaining * SECONDS_PER_LEDGER;
  const urgency =
    isOverdue || totalSecondsRemaining < 86_400
      ? "red"
      : totalSecondsRemaining < 2 * 86_400
      ? "yellow"
      : "green";

  const colorMap = {
    green: "bg-brand-50 border-brand-200 text-brand-800",
    yellow: "bg-amber-50 border-amber-300 text-amber-800",
    red: "bg-red-50 border-red-300 text-red-800",
  } as const;

  const labelMap = {
    green: "Time remaining",
    yellow: "Deadline approaching",
    red: isOverdue ? "Payout overdue" : "Deadline imminent",
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
          {isOverdue ? "past deadline" : "remaining"}
          {" "}· ~{SECONDS_PER_LEDGER}s per ledger
        </p>
      </div>
    </div>
  );
}

// ─── Main client component ────────────────────────────────────────────────────

export function CircleDetailClient({ circleAddress, circleData }: Props) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [data, setData] = useState<CircleDetailData>(circleData);

  useEffect(() => {
    getWalletAddress().then(setWalletAddress);
  }, []);

  const isMember = walletAddress
    ? data.members.some((m) => m.member_address === walletAddress)
    : false;

  const currentRound = data.circle.current_round;

  const myContributedThisRound = walletAddress
    ? data.members.find(
        (m) =>
          m.member_address === walletAddress &&
          Number(m.total_contributions) > currentRound,
      )
    : false;

  async function doAction(action: string, args: xdr.ScVal[] = []) {
    if (!walletAddress) {
      setError("Connect your wallet first.");
      return;
    }
    setError("");
    setSuccess("");
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
        setSuccess(`${action} successful! Tx: ${shortAddress(result.txHash)}`);
        // Refresh data after a successful action
        const res = await fetch(`${INDEXER_URL}/circles/${circleAddress}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const updated: Partial<CircleDetailData> = await res.json();
          setData((prev) => ({ ...prev, ...updated }));
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setLoading(null);
    }
  }

  const handleJoin = () =>
    doAction("join", [new Address(walletAddress!).toScVal()]);
  const handleContribute = () =>
    doAction("contribute", [new Address(walletAddress!).toScVal()]);
  const handlePayout = () => doAction("payout", []);
  const handleClose = () => doAction("close", []);

  return (
    <div className="space-y-8">
      {/* Action panel */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-800 mb-4">Actions</h2>

        {error && (
          <div
            role="alert"
            className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-3"
          >
            {error}
          </div>
        )}
        {success && (
          <div className="bg-brand-50 border border-brand-200 rounded-lg p-3 text-sm text-brand-700 mb-3">
            ✅ {success}
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          {data.circle.status === "Pending" && isMember && (
            <button
              onClick={handleJoin}
              disabled={!!loading}
              className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {loading === "join" ? "Joining…" : "🔒 Lock Collateral & Join"}
            </button>
          )}

          {data.circle.status === "Active" &&
            isMember &&
            !myContributedThisRound && (
              <button
                onClick={handleContribute}
                disabled={!!loading}
                className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {loading === "contribute"
                  ? "Contributing…"
                  : "💰 Contribute Round " + currentRound}
              </button>
            )}

          {data.circle.status === "Active" && (
            <button
              onClick={handlePayout}
              disabled={!!loading}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading === "payout" ? "Paying out…" : "🎯 Trigger Payout"}
            </button>
          )}

          {(data.circle.status === "Completed" ||
            data.circle.status === "Cancelled") && (
            <button
              onClick={handleClose}
              disabled={!!loading}
              className="bg-slate-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
            >
              {loading === "close" ? "Closing…" : "🔓 Release Collateral"}
            </button>
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
                <div className="text-right text-sm">
                  {isPaid ? (
                    <span className="text-slate-500">
                      ✅ received ${formatUsdc(roundForMember?.amount || "0")}
                    </span>
                  ) : isNext ? (
                    <span className="text-brand-700 font-semibold">
                      ← next payout
                    </span>
                  ) : (
                    <span className="text-slate-400">waiting</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
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
                  {round.contributions.length} contributions
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
          Share this link so members can contribute:
        </p>
        <input
          readOnly
          value={typeof window !== "undefined" ? window.location.href : ""}
          className="w-full font-mono text-xs bg-white border border-slate-300 rounded px-3 py-2 text-slate-600"
          onClick={(e) => (e.target as HTMLInputElement).select()}
          aria-label="Invite link"
        />
      </div>
    </div>
  );
}
