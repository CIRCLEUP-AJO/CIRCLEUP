"use client";
import { useState, useEffect } from "react";
import {
  computeDeadlineDisplay,
  DEADLINE_MAX_DATA_AGE_MS as MAX_DATA_AGE_MS,
} from "@/lib/deadline";

// Re-export so callers that imported MAX_DATA_AGE_MS from this module keep building.
export { MAX_DATA_AGE_MS };

/** How often the component re-checks data staleness (not a countdown tick). */
export const STALENESS_RECHECK_MS = 15_000;

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
  // Re-evaluate staleness on a coarse 15 s cadence. There is deliberately no
  // second-by-second countdown: the time estimate is derived from ledger
  // sequences that only change when the indexer reports a new ledger, so a
  // per-second tick would imply precision the inputs do not have.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "Active") return;
    const id = setInterval(() => setNowMs(Date.now()), STALENESS_RECHECK_MS);
    return () => clearInterval(id);
  }, [status]);

  const display = computeDeadlineDisplay({
    deadlineLedger,
    latestLedger,
    status,
    fetchedAtMs,
    checkpointTime,
    nowMs,
  });

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
      <div
        className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-start gap-3"
        role="status"
        aria-label={display.srText}
        data-deadline-phase={display.phase}
        data-deadline-kind={display.kind}
      >
        <span className="text-xl mt-0.5" aria-hidden="true">⏱️</span>
        <div>
          <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">
            Round deadline
          </p>
          <p className="text-sm text-slate-500 mt-0.5">
            {display.deadlineLedger !== null
              ? `Deadline at ledger ${display.deadlineLedger.toLocaleString("en-US")} · latest ledger unavailable`
              : "Deadline data not available for this circle"}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            <span className="font-medium">{display.freshnessLabel}</span> · time estimate
            hidden until ledger data loads
          </p>
          {/* Explicitly report missing checkpoint — absence itself is diagnostic. */}
          <CheckpointAgeRow checkpointTime={display.checkpointTime} />
        </div>
      </div>
    );
  }

  const isStale = display.kind === "stale";
  const { human, isOverdue, urgency, ledgersRemaining, phase } = display;

  // Visual urgency comes from the same ledger-derived `urgency` that drives
  // the text label, so colour and wording can never disagree.
  const colorMap = {
    green:  "bg-brand-50 border-brand-200 text-brand-800",
    yellow: "bg-amber-50 border-amber-300 text-amber-800",
    red:    "bg-red-50 border-red-300 text-red-800",
  } as const;

  const boxClasses = `border rounded-xl p-4 flex items-start gap-3 ${colorMap[urgency]}${
    isStale ? " border-dashed" : ""
  }`;

  const progress =
    phase === "passed"
      ? `${Math.abs(ledgersRemaining!).toLocaleString("en-US")} ledger${
          Math.abs(ledgersRemaining!) !== 1 ? "s" : ""
        } past deadline`
      : `${ledgersRemaining!.toLocaleString("en-US")} ledger${
          ledgersRemaining !== 1 ? "s" : ""
        } remaining`;

  return (
    <div
      className={boxClasses}
      role="status"
      aria-live="polite"
      aria-label={display.srText}
      data-deadline-phase={phase}
      data-deadline-kind={display.kind}
      data-deadline-urgency={urgency}
    >
      <span className="text-xl mt-0.5" aria-hidden="true">
        {isOverdue ? "🔴" : "⏱️"}
      </span>
      <div className="flex-1">
        <p className="text-xs font-medium uppercase tracking-wide opacity-70">
          {display.label}
        </p>
        <p className="text-lg font-bold mt-0.5">{human}</p>
        {display.timeEstimate !== null && (
          <p className="text-xs opacity-70 mt-0.5">
            Approximate — assumes ~{display.secondsPerLedger}s per ledger. The
            deadline ledger is authoritative.
          </p>
        )}
        <p className="text-xs opacity-70 mt-0.5">
          Deadline at ledger {display.deadlineLedger!.toLocaleString("en-US")} · latest
          indexed ledger {display.latestLedger!.toLocaleString("en-US")} · {progress}
        </p>
        {isStale && (
          <p className="text-xs font-medium mt-0.5">
            {display.freshnessLabel} — indexed data is{" "}
            {Math.round((display.dataAgeMs ?? 0) / 1000)}s old; time estimate hidden
            {phase === "open" ? " and the deadline may already have passed" : ""}.
          </p>
        )}
        {/* Checkpoint age separates ledger distance from approximate processing age.
            Always rendered — if absent the row labels that explicitly. */}
        <CheckpointAgeRow checkpointTime={display.checkpointTime} />
      </div>
    </div>
  );
}
