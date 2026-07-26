"use client";
import { memo } from "react";
import Link from "next/link";
import { shortAddress, formatUsdc, formatPot } from "@/lib/config";
import clsx from "clsx";

/** Indexer list shape for a circle. Mirrors ApiCircleRow in sdk/src/types.ts.
 *  Keep in sync when the indexer schema changes. */
export interface Circle {
  address: string;
  creator: string;
  /** Per-member round contribution, in stroops */
  round_amount: string;
  member_count: number;
  /** Canonical values from the contract's CircleStatus enum:
   *  "Pending" | "Active" | "Completed" | "Cancelled". Kept as string
   *  because the value arrives from the indexer/RPC untyped. */
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
}

interface StatusMeta {
  label: string;
  /** Plain-language explanation, surfaced as a tooltip */
  description: string;
  chipClasses: string;
  dotClasses: string;
}

const STATUS_META: Record<string, StatusMeta> = {
  pending: {
    label: "Pending",
    description: "Waiting for members to join",
    chipClasses: "bg-yellow-100 text-yellow-800",
    dotClasses: "bg-yellow-500",
  },
  active: {
    label: "Active",
    description: "Rounds in progress",
    // brand-800 is not defined in the Tailwind palette; 700 matches ReputationBadge
    chipClasses: "bg-brand-100 text-brand-700",
    dotClasses: "bg-brand-500",
  },
  completed: {
    label: "Completed",
    description: "All rounds finished",
    chipClasses: "bg-blue-100 text-blue-800",
    dotClasses: "bg-blue-500",
  },
  cancelled: {
    label: "Cancelled",
    description: "Closed before all rounds completed",
    chipClasses: "bg-red-100 text-red-800",
    dotClasses: "bg-red-400",
  },
};

export function getStatusMeta(status: string): StatusMeta {
  const known = STATUS_META[status?.trim().toLowerCase()];
  if (known) return known;
  return {
    label: status?.trim() || "Unknown",
    description: "Status not recognized",
    chipClasses: "bg-slate-100 text-slate-700",
    dotClasses: "bg-slate-400",
  };
}

// ─── Input guards ─────────────────────────────────────────────────────────────
//
// The indexer returns amounts as string-serialised stroops and counts as
// numbers. Both should always be valid, but the API contract is not enforced
// at compile time, so guard before passing to formatUsdc / formatPot to
// prevent NaN / "0.00" from silently replacing real values.

function safeFormatUsdc(stroops: string): string {
  let n: bigint;
  try {
    n = BigInt(stroops.trim() || "0");
  } catch {
    return "0.00";
  }
  if (n < 0n) return "0.00";
  return formatUsdc(n);
}

function safeFormatPot(stroops: string, memberCount: number): string {
  let n: bigint;
  try {
    n = BigInt(stroops.trim() || "0");
  } catch {
    return "0.00";
  }
  const count = Number.isFinite(memberCount) && memberCount > 0 ? memberCount : 0;
  if (n < 0n || count === 0) return "0.00";
  return formatPot(n, count);
}

// ─── CircleCard ───────────────────────────────────────────────────────────────
//
// Wrapped in React.memo so parent re-renders (e.g. Suspense boundary settling,
// context changes) do not re-render every card in the list when their props
// have not changed. This is most valuable when the list is long or when the
// parent page re-renders due to router state changes.

export const CircleCard = memo(function CircleCard({ circle }: { circle: Circle }) {
  const status = getStatusMeta(circle.status);
  const totalRounds = circle.total_rounds > 0 ? circle.total_rounds : 0;
  const currentRound = Math.max(0, circle.current_round);
  const progressPct =
    totalRounds > 0
      ? Math.round((currentRound / totalRounds) * 100)
      : 0;

  // Human-readable label used both by the aria-label on the link and the
  // screen-reader-only heading inside the card, so assistive technology
  // announces the card's purpose unambiguously.
  const cardLabel = `Circle ${shortAddress(circle.address)} — $${safeFormatUsdc(circle.round_amount)} per round, ${status.label}`;

  return (
    <Link
      href={`/circles/${circle.address}`}
      className="block group"
      aria-label={cardLabel}
    >
      <div className="bg-white rounded-xl border border-slate-200 p-5 hover:border-brand-400 hover:shadow-md transition-all">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="font-mono text-xs text-slate-500">
              {shortAddress(circle.address)}
            </p>
            {/* safeFormatUsdc → always 2 dp, e.g. "$10.00 / round" */}
            <p className="text-lg font-semibold text-slate-800 mt-0.5">
              ${safeFormatUsdc(circle.round_amount)} / round
            </p>
          </div>
          <span
            className={clsx(
              "inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium px-2 py-1 rounded-full",
              status.chipClasses,
            )}
            title={status.description}
          >
            <span
              className={clsx("h-1.5 w-1.5 rounded-full", status.dotClasses)}
              aria-hidden="true"
            />
            <span className="sr-only">Status: </span>
            {status.label}
          </span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2 text-center text-xs mb-3">
          <div className="bg-slate-50 rounded-lg py-2">
            <p className="font-semibold text-slate-800">{circle.member_count}</p>
            <p className="text-slate-500">members</p>
          </div>
          <div className="bg-slate-50 rounded-lg py-2">
            <p className="font-semibold text-slate-800">
              {currentRound}/{totalRounds}
            </p>
            <p className="text-slate-500">rounds</p>
          </div>
          <div className="bg-slate-50 rounded-lg py-2">
            {/* safeFormatPot → pot = round_amount × member_count, 2 dp */}
            <p className="font-semibold text-slate-800">
              ${safeFormatPot(circle.round_amount, circle.member_count)}
            </p>
            <p className="text-slate-500">pot</p>
          </div>
        </div>

        {/* Progress bar */}
        {totalRounds > 0 && (
          <div
            className="w-full bg-slate-100 rounded-full h-1.5"
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Round progress: ${currentRound} of ${totalRounds}`}
          >
            <div
              className="bg-brand-500 h-1.5 rounded-full transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}

        <p className="text-xs text-slate-400 mt-2">
          by {shortAddress(circle.creator)}
        </p>
      </div>
    </Link>
  );
});
