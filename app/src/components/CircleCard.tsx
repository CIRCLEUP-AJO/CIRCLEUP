"use client";
import Link from "next/link";
import { shortAddress, formatUsdc, formatPot } from "@/lib/config";
import clsx from "clsx";

export interface Circle {
  address: string;
  creator: string;
  /** Per-member round contribution, in stroops */
  round_amount: string;
  member_count: number;
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
}

const STATUS_COLORS: Record<string, string> = {
  Pending: "bg-yellow-100 text-yellow-800",
  Active: "bg-brand-100 text-brand-800",
  Completed: "bg-blue-100 text-blue-800",
  Cancelled: "bg-red-100 text-red-800",
};

export function CircleCard({ circle }: { circle: Circle }) {
  const progressPct =
    circle.total_rounds > 0
      ? Math.round((circle.current_round / circle.total_rounds) * 100)
      : 0;

  return (
    <Link href={`/circles/${circle.address}`} className="block group">
      <div className="bg-white rounded-xl border border-slate-200 p-5 hover:border-brand-400 hover:shadow-md transition-all">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="font-mono text-xs text-slate-500">
              {shortAddress(circle.address)}
            </p>
            {/* formatUsdc → always 2 dp, e.g. "$10.00 / round" */}
            <p className="text-lg font-semibold text-slate-800 mt-0.5">
              ${formatUsdc(circle.round_amount)} / round
            </p>
          </div>
          <span
            className={clsx(
              "text-xs font-medium px-2 py-1 rounded-full",
              STATUS_COLORS[circle.status] || "bg-slate-100 text-slate-700",
            )}
          >
            {circle.status}
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
              {circle.current_round}/{circle.total_rounds}
            </p>
            <p className="text-slate-500">rounds</p>
          </div>
          <div className="bg-slate-50 rounded-lg py-2">
            {/* formatPot → pot = round_amount × member_count, 2 dp */}
            <p className="font-semibold text-slate-800">
              ${formatPot(circle.round_amount, circle.member_count)}
            </p>
            <p className="text-slate-500">pot</p>
          </div>
        </div>

        {/* Progress bar */}
        {circle.total_rounds > 0 && (
          <div
            className="w-full bg-slate-100 rounded-full h-1.5"
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Round progress: ${circle.current_round} of ${circle.total_rounds}`}
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
}
