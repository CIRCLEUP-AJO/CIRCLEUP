"use client";

import { useState } from "react";
import {
  ACTIVITY_CATEGORY_LABELS,
  buildTimelinePage,
  type ActivityEntry,
  type ActivityEventCategory,
} from "@/lib/activityTimeline";
import { shortAddress, getExplorerLink, ACTIVE_NETWORK } from "@/lib/config";

// ─── Visual config per category ───────────────────────────────────────────────

const CATEGORY_STYLES: Record<
  ActivityEventCategory,
  { dot: string; badge: string; icon: string }
> = {
  join:        { dot: "bg-brand-500",  badge: "bg-brand-100 text-brand-700",  icon: "🔓" },
  contribute:  { dot: "bg-blue-500",   badge: "bg-blue-100 text-blue-700",    icon: "💵" },
  payout:      { dot: "bg-green-500",  badge: "bg-green-100 text-green-700",  icon: "🏅" },
  default:     { dot: "bg-red-500",    badge: "bg-red-100 text-red-700",      icon: "⚠️" },
  cancellation:{ dot: "bg-red-400",    badge: "bg-red-50 text-red-600",       icon: "✖️" },
  pause:       { dot: "bg-amber-400",  badge: "bg-amber-50 text-amber-700",   icon: "⏸️" },
  completion:  { dot: "bg-green-600",  badge: "bg-green-100 text-green-800",  icon: "🏁" },
  close:       { dot: "bg-slate-500",  badge: "bg-slate-100 text-slate-700",  icon: "🔐" },
  unknown:     { dot: "bg-slate-300",  badge: "bg-slate-100 text-slate-500",  icon: "❓" },
};

const PAGE_SIZE = 20;

// ─── Single entry row ─────────────────────────────────────────────────────────

function TimelineEntry({ entry }: { entry: ActivityEntry }) {
  const style = CATEGORY_STYLES[entry.category] ?? CATEGORY_STYLES.unknown;
  const label = ACTIVITY_CATEGORY_LABELS[entry.category];
  const explorerUrl =
    entry.txHash
      ? getExplorerLink(ACTIVE_NETWORK, "tx", entry.txHash)
      : null;

  return (
    <li className="flex gap-3 items-start py-3 border-b border-slate-100 last:border-0">
      {/* Timeline dot */}
      <span
        className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${style.dot}`}
        aria-hidden="true"
      />

      <div className="flex-1 min-w-0 space-y-0.5">
        {/* Category badge + round */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${style.badge}`}
          >
            <span aria-hidden="true">{style.icon}</span>
            {label}
          </span>
          {entry.round !== null && (
            <span className="text-xs text-slate-500">
              Round {entry.round}
            </span>
          )}
          {entry.category === "unknown" && entry.rawEventType && (
            <span
              className="text-xs text-slate-400 font-mono"
              title={`Raw event type: ${entry.rawEventType}`}
            >
              ({entry.rawEventType})
            </span>
          )}
        </div>

        {/* Actor */}
        {entry.actor !== null && (
          <p className="text-xs text-slate-500 font-mono truncate" title={entry.actor}>
            {shortAddress(entry.actor)}
          </p>
        )}

        {/* Amount */}
        {entry.amountStroops !== null && (
          <p className="text-xs text-slate-600">
            {formatStroopsDisplay(entry.amountStroops)}
          </p>
        )}

        {/* Tx hash + explorer link */}
        {entry.txHash !== null && (
          <p className="text-xs text-slate-400 font-mono">
            Tx:{" "}
            {explorerUrl ? (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-brand-600"
                title={entry.txHash}
              >
                {shortAddress(entry.txHash)}
              </a>
            ) : (
              <span title={entry.txHash}>{shortAddress(entry.txHash)}</span>
            )}
          </p>
        )}

        {/* Source label */}
        <p className="text-xs text-slate-400">{entry.sourceLabel}</p>
      </div>
    </li>
  );
}

// ─── Empty / error states ─────────────────────────────────────────────────────

function EmptyTimeline() {
  return (
    <p className="text-sm text-slate-500 py-4 text-center">
      No activity recorded yet. Events will appear here as the circle progresses.
    </p>
  );
}

// ─── CircleTimeline ───────────────────────────────────────────────────────────

export interface CircleTimelineProps {
  /**
   * Raw event objects from the indexer. Unknown shapes are handled gracefully —
   * unknown event types become category:"unknown" entries, not errors.
   */
  rawEvents: unknown[];
  /** ISO-8601 timestamp of when the data was fetched — shown as freshness label. */
  fetchedAt?: string | null;
}

/**
 * Chronological activity timeline for a circle.
 *
 * Renders a bounded, paginated list of normalised events. Unknown event types
 * are shown explicitly rather than hidden, so the timeline never silently drops
 * data. Transaction hashes link to Stellar Expert when available.
 */
export function CircleTimeline({ rawEvents, fetchedAt }: CircleTimelineProps) {
  const [offset, setOffset] = useState(0);

  const page = buildTimelinePage(rawEvents, offset, PAGE_SIZE);

  const freshnessLabel = fetchedAt
    ? `Indexed data · fetched ${new Date(fetchedAt).toLocaleTimeString()}`
    : "Indexed data";

  return (
    <section aria-label="Circle activity timeline">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-800">Activity Timeline</h2>
        <span
          className="text-xs text-slate-400"
          title="Events are sourced from the indexer and may lag the chain by one or more ledgers."
          aria-label={`Timeline data source: ${freshnessLabel}`}
        >
          {freshnessLabel}
        </span>
      </div>

      {page.entries.length === 0 ? (
        <EmptyTimeline />
      ) : (
        <>
          <ol
            className="divide-y divide-slate-100"
            aria-label={`${page.totalCount} activity event${page.totalCount !== 1 ? "s" : ""}`}
          >
            {page.entries.map((entry) => (
              <TimelineEntry key={entry.id} entry={entry} />
            ))}
          </ol>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-3 text-xs text-slate-500">
            <span>
              Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, page.totalCount)} of{" "}
              {page.totalCount}
            </span>
            <div className="flex gap-2">
              {offset > 0 && (
                <button
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 transition-colors"
                >
                  Previous
                </button>
              )}
              {page.hasMore && (
                <button
                  onClick={() => setOffset(page.nextOffset)}
                  className="px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 transition-colors"
                >
                  Next
                </button>
              )}
            </div>
          </div>
        </>
      )}

      <p
        className="text-xs text-slate-400 mt-3 border-t border-slate-100 pt-2"
        role="note"
      >
        ℹ️ Timeline events are sourced from indexed data and may lag the chain.
        Transaction hashes link to Stellar Expert for on-chain confirmation.
      </p>
    </section>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatStroopsDisplay(stroops: string): string {
  try {
    const n = BigInt(stroops.trim());
    if (n < 0n) return "0.00 USDC";
    const units = n / 10_000_000n;
    const frac = (n % 10_000_000n).toString().padStart(7, "0").slice(0, 2);
    return `${units}.${frac} USDC`;
  } catch {
    return "— USDC";
  }
}
