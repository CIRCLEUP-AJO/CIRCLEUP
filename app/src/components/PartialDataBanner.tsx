"use client";
import { type CircleDetailData } from "@/lib/circleTypes";

export interface PartialDataBannerProps {
  data: CircleDetailData;
  onRefresh: () => void;
  isRefreshing: boolean;
}

// ─── Partial data banner ───────────────────────────────────────────────────────
//
// Shown when data is structurally present but incomplete. Explains why actions
// are locked and provides a Retry button. Distinct from a network/fetch error —
// this is "we got a response, but it doesn't have everything we need yet."

export function PartialDataBanner({ data, onRefresh, isRefreshing }: PartialDataBannerProps) {
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
      <span className="text-xl mt-0.5" aria-hidden="true">⚠</span>
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
