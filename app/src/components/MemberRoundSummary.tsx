"use client";

import {
  MEMBER_ROUND_STATUS_LABELS,
  MEMBER_ROUND_STATUS_DESCRIPTIONS,
  type MemberRoundSummaryResult,
  type MemberRoundEntry,
  type MemberRoundStatus,
} from "@/lib/memberRoundSummary";
import { shortAddress, getExplorerLink, ACTIVE_NETWORK, formatUsdc } from "@/lib/config";

// ─── Status badge styles ──────────────────────────────────────────────────────

const STATUS_BADGE: Record<MemberRoundStatus, string> = {
  contributed:      "bg-green-100 text-green-700",
  received:         "bg-brand-100 text-brand-700",
  defaulted:        "bg-red-100 text-red-700",
  inconsistent:     "bg-amber-100 text-amber-800 font-semibold",
  not_yet_recorded: "bg-slate-100 text-slate-500",
  not_obligated:    "bg-slate-100 text-slate-500",
  unavailable:      "bg-slate-100 text-slate-400",
  unknown:          "bg-slate-100 text-slate-400",
};

const STATUS_ICONS: Record<MemberRoundStatus, string> = {
  contributed:      "✓",
  received:         "🏅",
  defaulted:        "⚠",
  inconsistent:     "⚡",
  not_yet_recorded: "…",
  not_obligated:    "—",
  unavailable:      "✖",
  unknown:          "?",
};

// ─── Round entry row ──────────────────────────────────────────────────────────

function RoundEntryRow({ entry }: { entry: MemberRoundEntry }) {
  const badgeClass = STATUS_BADGE[entry.status] ?? STATUS_BADGE.unknown;
  const icon = STATUS_ICONS[entry.status] ?? "?";
  const label = MEMBER_ROUND_STATUS_LABELS[entry.status];
  const description = MEMBER_ROUND_STATUS_DESCRIPTIONS[entry.status];

  const txHash =
    entry.contributionRecord?.tx_hash ?? entry.payoutTxHash ?? null;
  const explorerUrl =
    txHash ? getExplorerLink(ACTIVE_NETWORK, "tx", txHash) : null;

  return (
    <tr className="border-b border-slate-100 last:border-0">
      {/* Round # */}
      <td className="py-2.5 pr-3 text-sm text-slate-600 w-16 shrink-0">
        Round {entry.roundIndex}
      </td>

      {/* Status badge */}
      <td className="py-2.5 pr-3">
        <span
          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${badgeClass}`}
          title={description}
          aria-label={`Status: ${label}. ${description}`}
        >
          <span aria-hidden="true">{icon}</span>
          {label}
        </span>
      </td>

      {/* Detail */}
      <td className="py-2.5 text-xs text-slate-500">
        {entry.status === "inconsistent" && (
          <span className="text-amber-700 font-medium">
            Both contribution and default records exist — refer to contract.
          </span>
        )}
        {entry.status === "contributed" && entry.contributionRecord && (
          <span>
            {safeFormatUsdc(entry.contributionRecord.amount)}{" "}
            {txHash && explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono underline hover:text-brand-600"
                title={txHash}
              >
                {shortAddress(txHash)}
              </a>
            )}
            {txHash && !explorerUrl && (
              <span className="font-mono" title={txHash}>
                {shortAddress(txHash)}
              </span>
            )}
          </span>
        )}
        {entry.status === "received" && entry.payoutAmountStroops && (
          <span>
            {safeFormatUsdc(entry.payoutAmountStroops)}{" "}
            {txHash && explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono underline hover:text-brand-600"
                title={txHash}
              >
                {shortAddress(txHash)}
              </a>
            )}
          </span>
        )}
        {entry.status === "defaulted" && entry.defaultRecord && (
          <span className="text-red-600">
            Penalty: {safeFormatUsdc(entry.defaultRecord.penalty)}
          </span>
        )}
      </td>
    </tr>
  );
}

// ─── MemberRoundSummary ───────────────────────────────────────────────────────

export interface MemberRoundSummaryProps {
  summary: MemberRoundSummaryResult;
}

/**
 * Read-only per-member round participation table.
 *
 * Shows each round's status derived from indexed contribution, default, and
 * payout records. Contradictory records are surfaced as "inconsistent" rather
 * than silently collapsed.
 *
 * This component is purely advisory — it never initiates transactions.
 */
export function MemberRoundSummary({ summary }: MemberRoundSummaryProps) {
  if (summary.entries.length === 0) {
    return (
      <section aria-label="Member round participation">
        <p className="text-sm text-slate-500 py-2">
          No round data yet for this member.
        </p>
        <p className="text-xs text-slate-400 mt-1" role="note">
          {summary.indexerLagNote}
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Member round participation">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-slate-800 text-sm">
          Round Participation —{" "}
          <span className="font-mono text-xs text-slate-500" title={summary.memberAddress}>
            {shortAddress(summary.memberAddress)}
          </span>
        </h3>
        {summary.inconsistentCount > 0 && (
          <span
            className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium"
            role="alert"
            aria-live="polite"
          >
            ⚡ {summary.inconsistentCount} inconsistent record
            {summary.inconsistentCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-label="Round participation details">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-200">
              <th scope="col" className="pb-2 pr-3 font-medium">Round</th>
              <th scope="col" className="pb-2 pr-3 font-medium">Status</th>
              <th scope="col" className="pb-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {summary.entries.map((entry) => (
              <RoundEntryRow key={entry.roundIndex} entry={entry} />
            ))}
          </tbody>
        </table>
      </div>

      <p
        className="text-xs text-slate-400 mt-3 border-t border-slate-100 pt-2"
        role="note"
        aria-label="Data source advisory"
      >
        ℹ️ {summary.indexerLagNote}
      </p>

      {summary.inconsistentCount > 0 && (
        <p
          className="text-xs text-amber-700 mt-1"
          role="note"
        >
          Inconsistent records indicate both a contribution and a default exist
          for the same round. This may reflect replayed or malformed indexed
          data. The contract is the authoritative source — check on-chain state
          before acting.
        </p>
      )}
    </section>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeFormatUsdc(stroops: string): string {
  try {
    const n = BigInt(stroops.trim() || "0");
    if (n < 0n) return "$0.00";
    return `$${formatUsdc(n)}`;
  } catch {
    return "$0.00";
  }
}
