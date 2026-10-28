"use client";
import { type CircleRound } from "@/lib/circleTypes";
import { shortAddress, formatUsdc, getExplorerLink, ACTIVE_NETWORK } from "@/lib/config";

export interface RoundCardProps {
  round: CircleRound;
}

export function RoundCard({ round }: RoundCardProps) {
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
              aria-label={`Round status: ${statusLabel[round.status]}`}
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
          <span aria-hidden="true">💸 </span>
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
