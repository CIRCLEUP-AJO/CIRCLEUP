"use client";
import { useState, useEffect } from "react";
import {
  computeDeadlineDisplay,
  DEADLINE_MAX_DATA_AGE_MS as MAX_DATA_AGE_MS,
  SECONDS_PER_LEDGER,
} from "@/lib/deadline";

// Re-export so callers that imported MAX_DATA_AGE_MS from this module keep building.
export { MAX_DATA_AGE_MS };

interface DeadlineProps {
  deadlineLedger: number | null | undefined;
  latestLedger:   number | null | undefined;
  status: string;
  /** Wall-clock ms when the deadline data was last successfully fetched. */
  fetchedAtMs: number;
  /** ISO-8601 checkpoint timestamp from the indexer. null = absent from response. */
  checkpointTime?: string | null;
}

// ─── CheckpointAgeRow ─────────────────────────────────────────────────────────
//
// Shows the indexer processing age alongside the ledger countdown so operators
// can distinguish ledger *distance* from approximate *processing age*.
// When checkpointTime is null the row says so explicitly — absence is a
// diagnostic signal and must never be silently omitted.

export function CheckpointAgeRow({ checkpointTime }: { checkpointTime: string | null }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  if (checkpointTime == null) {
    return (
      <p
        className="text-xs opacity-60 mt-1"
        title="The indexer response did not include a checkpointTime field. Processing age is unknown."
      >
        Indexer age: no checkpoint data · source: absent
      </p>
    );
  }

  const parsed = Date.parse(checkpointTime);
  if (isNaN(parsed)) {
    return (
      <p className="text-xs opacity-60 mt-1">
        Indexer age: unparseable timestamp · source: indexer_response
      </p>
    );
  }

  // Clamp to ≥ 0: minor clock skew (indexer clock slightly ahead of client)
  // produces a confusing negative age without this guard.
  const ageSec = Math.max(0, (nowMs - parsed) / 1000);
  const ageStr =
    ageSec < 60
      ? `${Math.round(ageSec)}s ago`
      : ageSec < 3600
      ? `${Math.round(ageSec / 60)}m ago`
      : `${(ageSec / 3600).toFixed(1)}h ago`;

  return (
    <p
      className="text-xs opacity-60 mt-1"
      title={`Checkpoint timestamp: ${checkpointTime}`}
    >
      Indexer age: {ageStr} · source: indexer_response
    </p>
  );
}

export function RoundDeadlineStatus({
  deadlineLedger,
  latestLedger,
  status,
  fetchedAtMs,
  checkpointTime = null,
}: DeadlineProps) {
  const display = computeDeadlineDisplay({
    deadlineLedger,
    latestLedger,
    status,
    fetchedAtMs,
    checkpointTime,
  });

  // Only tick for fresh data on an Active circle.  Stale or missing data is
  // never presented as a live, precise countdown — it stays a static estimate
  // (or is shown as unavailable) so users aren't misled about when a default
  // is permitted.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (status !== "Active" || display.kind !== "fresh") return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [status, display.kind]);

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

  if (display.kind === "unavailable") {
    return (
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-start gap-3">
        <span className="text-xl mt-0.5" aria-hidden="true">⏱️</span>
        <div>
          <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">
            Round deadline
          </p>
          <p className="text-sm text-slate-400 mt-0.5">
            Deadline data not available for this circle
          </p>
          {/* Explicitly report missing checkpoint — absence itself is diagnostic. */}
          <CheckpointAgeRow checkpointTime={display.checkpointTime} />
        </div>
      </div>
    );
  }

  const isStale = display.kind === "stale";
  const { human, isOverdue, urgency, ledgersRemaining } = display;

  const colorMap = {
    green:  "bg-brand-50 border-brand-200 text-brand-800",
    yellow: "bg-amber-50 border-amber-300 text-amber-800",
    red:    "bg-red-50 border-red-300 text-red-800",
  } as const;

  const boxClasses = `border rounded-xl p-4 flex items-start gap-3 ${
    isStale ? "bg-amber-50 border-amber-200 text-amber-800" : colorMap[urgency]
  }`;

  return (
    <div
      className={boxClasses}
      role="status"
      aria-live="polite"
      aria-label={`Round deadline: ${display.label}, ${human}`}
    >
      <span className="text-xl mt-0.5" aria-hidden="true">
        {isOverdue ? "🔴" : "⏱️"}
      </span>
      <div className="flex-1">
        <p className="text-xs font-medium uppercase tracking-wide opacity-70">
          {display.label}
        </p>
        <p className="text-lg font-bold mt-0.5 tabular-nums">{human}</p>
        <p className="text-xs opacity-60 mt-0.5">
          Deadline at ledger {deadlineLedger!.toLocaleString()} ·{" "}
          {Math.abs(ledgersRemaining!).toLocaleString()} ledger
          {Math.abs(ledgersRemaining!) !== 1 ? "s" : ""}{" "}
          {isOverdue ? "past deadline" : "remaining"}{" "}
          · ~{SECONDS_PER_LEDGER}s per ledger (estimate)
          {isStale
            ? ` · indexed data is ${Math.round(
                (display.dataAgeMs ?? 0) / 1000,
              )}s old — refresh for an accurate deadline`
            : ""}
        </p>
        {/* Checkpoint age separates ledger distance from approximate processing age.
            Always rendered — if absent the row labels that explicitly. */}
        <CheckpointAgeRow checkpointTime={display.checkpointTime} />
      </div>
    </div>
  );
}
