"use client";
import { useState, useEffect } from "react";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { getWalletAddress, invokeContract } from "@/lib/stellar";
import { shortAddress, stroopsToUsdc, INDEXER_URL } from "@/lib/config";
import { ReputationBadge } from "@/components/ReputationBadge";
import clsx from "clsx";

interface Member {
  member_address: string;
  payout_order: number;
  collateral: string;
  defaults: number;
  joined_at: string | null;
  reputation_score: number;
  total_contributions: number;
}

interface Round {
  roundIndex: number;
  recipient: string;
  amount: string;
  txHash: string;
  contributions: any[];
  defaults: any[];
}

interface Props {
  circleAddress: string;
  circleData: {
    circle: any;
    members: Member[];
    rounds: Round[];
    pendingDefaults: any[];
  };
}

export function CircleDetailClient({ circleAddress, circleData }: Props) {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [data, setData] = useState(circleData);

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
        // Refresh data
        const res = await fetch(`${INDEXER_URL}/circles/${circleAddress}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const updated = await res.json();
          setData((prev) => ({ ...prev, ...updated }));
        }
      }
    } catch (err: any) {
      setError(err.message || "Unknown error");
    } finally {
      setLoading(null);
    }
  }

  const handleJoin = () => doAction("join", [new Address(walletAddress!).toScVal()]);
  const handleContribute = () => doAction("contribute", [new Address(walletAddress!).toScVal()]);
  const handlePayout = () => doAction("payout", []);
  const handleClose = () => doAction("close", []);

  return (
    <div className="space-y-8">
      {/* Action panel */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-800 mb-4">Actions</h2>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-3">
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

          {data.circle.status === "Active" && isMember && !myContributedThisRound && (
            <button
              onClick={handleContribute}
              disabled={!!loading}
              className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {loading === "contribute" ? "Contributing…" : "💰 Contribute Round " + currentRound}
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

          {(data.circle.status === "Completed" || data.circle.status === "Cancelled") && (
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

      {/* Rotation view */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-800 mb-4">🔄 Rotation Order</h2>
        <div className="space-y-2">
          {data.members.map((member, i) => {
            const isPaid = i < currentRound;
            const isNext = i === currentRound && data.circle.status === "Active";
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
                <span className="text-slate-400 text-sm w-5 text-right">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-xs text-slate-600 truncate">
                    {member.member_address}
                    {member.member_address === walletAddress && (
                      <span className="ml-1 text-brand-600 font-sans font-medium">(you)</span>
                    )}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <ReputationBadge score={member.reputation_score} size="sm" />
                    {member.defaults > 0 && (
                      <span className="text-xs text-red-600 font-medium">
                        ⚠️ {member.defaults} default{member.defaults > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right text-sm">
                  {isPaid ? (
                    <span className="text-slate-500">
                      ✅ received ${stroopsToUsdc(roundForMember?.amount || "0")}
                    </span>
                  ) : isNext ? (
                    <span className="text-brand-700 font-semibold">← next payout</span>
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
                  <h3 className="font-medium text-slate-800">Round {round.roundIndex}</h3>
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
                  🎯 ${stroopsToUsdc(round.amount)} paid to{" "}
                  <span className="font-mono">{shortAddress(round.recipient)}</span>
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  {round.contributions.length} contributions
                  {round.defaults.length > 0 && (
                    <span className="text-red-500 ml-2">
                      · {round.defaults.length} default{round.defaults.length > 1 ? "s" : ""}
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
          <h2 className="font-semibold text-red-800 mb-3">⚠️ Defaults (current round)</h2>
          <div className="space-y-2">
            {data.pendingDefaults.map((d: any, i: number) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm text-red-700 bg-red-100 rounded-lg px-3 py-2"
              >
                <span className="font-mono">{shortAddress(d.member_address)}</span>
                <span>Penalty: ${stroopsToUsdc(d.penalty)}</span>
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
