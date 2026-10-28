"use client";

export interface StaleDataBannerProps {
  onRefresh: () => void;
  isRefreshing: boolean;
}

// ─── Stale data banner ─────────────────────────────────────────────────────────
//
// Shown when the data is older than MAX_DATA_AGE_MS. Distinct from partial data:
// the data was complete when it arrived, but it's now too old to trust for
// financial operations.

export function StaleDataBanner({ onRefresh, isRefreshing }: StaleDataBannerProps) {
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
