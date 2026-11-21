// ─── Deadline display model (Issues: stale ledger data must not look exact; #866) ───
//
// A round deadline is a LEDGER SEQUENCE (`deadline_ledger`), not a timestamp.
// The contract decides eligibility by comparing ledger sequences, so the app
// does the same: every state that affects what a user may do (open / due /
// passed) comes from `ledgerDeadlinePhase()` in lib/gating.ts, which only sees
// `deadline_ledger` and `latestLedger`.
//
// Wall-clock text ("≈ 2h 15m") is a convenience estimate derived from an
// assumed seconds-per-ledger cadence. It is:
//
//   • always labelled approximate ("≈", "approximately");
//   • coarse — never shown to the second, never ticking every second;
//   • suppressed entirely when `latestLedger` is missing or the indexed data
//     is stale; ledger progress, the deadline ledger and a stale/unavailable
//     indicator are shown instead;
//   • never used to declare a deadline passed.
//
// Seconds-per-ledger assumption
// ─────────────────────────────
// Stellar targets a ~5 s close time and recent public-network history has
// averaged roughly 5–6 s per ledger, with occasional slower ledgers under
// load or during upgrades. The default (5 s) therefore tends to slightly
// under-estimate remaining time. Deployments may override it with
// NEXT_PUBLIC_SECONDS_PER_LEDGER (accepted range 1–60, else the default is
// used). No external service is queried for countdown precision.

import { ledgerDeadlinePhase, type LedgerDeadlinePhase } from "./gating";

/** Maximum age of indexed data before the deadline is treated as stale. */
export const DEADLINE_MAX_DATA_AGE_MS = 2 * 60 * 1000; // 2 minutes

/** Documented default cadence used when no override is configured. */
export const DEFAULT_SECONDS_PER_LEDGER = 5;

/** Bounds for a configured override; values outside fall back to the default. */
export const MIN_SECONDS_PER_LEDGER = 1;
export const MAX_SECONDS_PER_LEDGER = 60;

/**
 * Parse a configured seconds-per-ledger value. Invalid, non-finite or
 * out-of-range input falls back to {@link DEFAULT_SECONDS_PER_LEDGER}.
 */
export function resolveSecondsPerLedger(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_SECONDS_PER_LEDGER;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < MIN_SECONDS_PER_LEDGER || n > MAX_SECONDS_PER_LEDGER) {
    return DEFAULT_SECONDS_PER_LEDGER;
  }
  return n;
}

/** Approximate seconds per Stellar ledger. Wall-clock conversion is always an estimate. */
export const SECONDS_PER_LEDGER = resolveSecondsPerLedger(
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_SECONDS_PER_LEDGER : undefined,
);

/**
 * Urgency thresholds expressed in LEDGERS so styling follows ledger state,
 * not the time estimate. 17 280 ledgers ≈ 1 day at the default 5 s cadence.
 */
export const URGENCY_RED_LEDGERS = 17_280;
export const URGENCY_YELLOW_LEDGERS = 2 * 17_280;

export type DeadlineDataKind = "fresh" | "stale" | "unavailable";
export type DeadlineUrgency = "green" | "yellow" | "red";

export interface DeadlineDisplay {
  /** Whether the underlying ledger data is fresh, stale, or unavailable. */
  readonly kind: DeadlineDataKind;
  /** Ledger-authoritative phase (from lib/gating.ts). */
  readonly phase: LedgerDeadlinePhase;
  /** Deadline ledger, forwarded so it can be shown even when latestLedger is missing. */
  readonly deadlineLedger: number | null;
  /** Latest indexed ledger, forwarded for the ledger-progress line. */
  readonly latestLedger: number | null;
  /** Ledgers between the latest indexed ledger and the deadline ledger. */
  readonly ledgersRemaining: number | null;
  /**
   * Approximate seconds remaining. Null whenever a time estimate must be
   * suppressed (missing/stale data, deadline reached or passed).
   */
  readonly secondsRemaining: number | null;
  /**
   * Primary display text. A "≈ …" time estimate when fresh and open;
   * otherwise ledger-derived wording ("Due at this ledger", "Deadline passed",
   * "1,000 ledgers remaining", "—").
   */
  readonly human: string;
  /** The approximate time estimate on its own, or null when suppressed. */
  readonly timeEstimate: string | null;
  /** Ledger-derived: true only when latestLedger > deadlineLedger. */
  readonly isOverdue: boolean;
  /** Ledger-derived urgency; always consistent with {@link label}. */
  readonly urgency: DeadlineUrgency;
  /** Text urgency label, aligned with {@link urgency} and {@link phase}. */
  readonly label: string;
  /** Short data-freshness indicator ("Live", "Stale — updating", "Unavailable"). */
  readonly freshnessLabel: string;
  /** Full sentence for assistive technology. */
  readonly srText: string;
  /** Wall-clock age of the data in ms (null when unavailable). */
  readonly dataAgeMs: number | null;
  /** Wall-clock timing is always an estimate — never presented as exact. */
  readonly isEstimate: true;
  /** Seconds-per-ledger assumption used for the estimate. */
  readonly secondsPerLedger: number;
  /**
   * ISO-8601 checkpoint timestamp from the indexer, forwarded for display.
   * null when the field was absent from the response — absence must never be
   * treated as a healthy or "fresh" signal.
   */
  readonly checkpointTime: string | null;
}

/**
 * Coarse, approximate duration for a ledger count. Deliberately never shows
 * seconds: the inputs (ledger cadence, indexer lag) are not that precise.
 *
 * Ledger boundary: the deadline passes only when latestLedger EXCEEDS
 * deadlineLedger (see lib/gating.ts). At exact equality the round is due
 * now, not overdue — wall-clock time alone never declares it passed.
 */
export function ledgersToHuman(
  ledgers: number,
  secondsPerLedger: number = SECONDS_PER_LEDGER,
): string {
  if (ledgers < 0) return "overdue";
  if (ledgers === 0) return "due now";
  const totalSeconds = ledgers * secondsPerLedger;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "under 1m";
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

function urgencyFor(phase: LedgerDeadlinePhase, ledgersRemaining: number | null): DeadlineUrgency {
  if (phase === "passed" || phase === "due") return "red";
  if (ledgersRemaining === null) return "green";
  if (ledgersRemaining < URGENCY_RED_LEDGERS) return "red";
  if (ledgersRemaining < URGENCY_YELLOW_LEDGERS) return "yellow";
  return "green";
}

function labelFor(phase: LedgerDeadlinePhase, urgency: DeadlineUrgency): string {
  switch (phase) {
    case "passed":
      return "Round deadline passed";
    case "due":
      return "Deadline ledger reached";
    case "unknown":
      return "Round deadline";
    case "open":
      return urgency === "red"
        ? "Deadline imminent"
        : urgency === "yellow"
          ? "Deadline approaching"
          : "Time remaining";
  }
}

/**
 * Compute how a round deadline should be displayed, given the indexed ledger
 * heights and the age of the data.
 *
 * The boundary for staleness is inclusive: data exactly `maxDataAgeMs` old is
 * already stale. `status` is accepted for API compatibility; non-Active
 * circles are handled by the rendering component.
 */
export function computeDeadlineDisplay({
  deadlineLedger,
  latestLedger,
  fetchedAtMs,
  checkpointTime = null,
  nowMs = Date.now(),
  maxDataAgeMs = DEADLINE_MAX_DATA_AGE_MS,
  secondsPerLedger = SECONDS_PER_LEDGER,
}: {
  deadlineLedger: number | null | undefined;
  latestLedger: number | null | undefined;
  status?: string;
  fetchedAtMs: number;
  checkpointTime?: string | null;
  nowMs?: number;
  maxDataAgeMs?: number;
  secondsPerLedger?: number;
}): DeadlineDisplay {
  const spl = resolveSecondsPerLedger(secondsPerLedger);
  const phase = ledgerDeadlinePhase(deadlineLedger, latestLedger);

  // Missing ledger data → never fabricate a countdown or a pass/fail claim.
  if (phase === "unknown") {
    const knownDeadline =
      typeof deadlineLedger === "number" && Number.isInteger(deadlineLedger) && deadlineLedger >= 0
        ? deadlineLedger
        : null;
    const srText =
      knownDeadline !== null
        ? `Round deadline at ledger ${knownDeadline.toLocaleString("en-US")}. ` +
          "Latest ledger unavailable, so time remaining cannot be estimated."
        : "Round deadline data not available.";
    return {
      kind: "unavailable",
      phase,
      deadlineLedger: knownDeadline,
      latestLedger: null,
      ledgersRemaining: null,
      secondsRemaining: null,
      human: "—",
      timeEstimate: null,
      isOverdue: false,
      urgency: "green",
      label: knownDeadline !== null ? "Latest ledger unavailable" : "Deadline data not available",
      freshnessLabel: "Unavailable",
      srText,
      dataAgeMs: null,
      isEstimate: true,
      secondsPerLedger: spl,
      checkpointTime,
    };
  }

  // phase !== "unknown" guarantees both are valid integers.
  const deadline = deadlineLedger as number;
  const latest = latestLedger as number;
  const dataAgeMs = nowMs - fetchedAtMs;
  const isStale = dataAgeMs >= maxDataAgeMs;
  const ledgersRemaining = deadline - latest;
  const isOverdue = phase === "passed";
  const urgency = urgencyFor(phase, ledgersRemaining);
  const label = labelFor(phase, urgency);

  // A time estimate is only meaningful while the window is open and the
  // ledger tip is current.
  const showEstimate = phase === "open" && !isStale;
  const timeEstimate = showEstimate ? `≈ ${ledgersToHuman(ledgersRemaining, spl)}` : null;
  const secondsRemaining = showEstimate ? ledgersRemaining * spl : null;

  let human: string;
  if (phase === "passed") human = "Deadline passed";
  else if (phase === "due") human = "Due at this ledger";
  else if (timeEstimate !== null) human = timeEstimate;
  else human = `${plural(ledgersRemaining, "ledger")} remaining`;

  const progress =
    phase === "passed"
      ? `${plural(-ledgersRemaining, "ledger")} past deadline`
      : `${plural(ledgersRemaining, "ledger")} remaining`;

  const srParts = [
    `${label}.`,
    `Deadline ledger ${deadline.toLocaleString("en-US")}, latest indexed ledger ${latest.toLocaleString("en-US")}, ${progress}.`,
  ];
  if (timeEstimate !== null) {
    srParts.push(
      `Approximately ${ledgersToHuman(ledgersRemaining, spl)} remaining, assuming about ${spl} seconds per ledger.`,
    );
  }
  if (isStale) {
    srParts.push(
      phase === "open"
        ? "Ledger data is stale and updating; time estimate hidden and the deadline may already have passed."
        : "Ledger data is stale and updating.",
    );
  }

  return {
    kind: isStale ? "stale" : "fresh",
    phase,
    deadlineLedger: deadline,
    latestLedger: latest,
    ledgersRemaining,
    secondsRemaining,
    human,
    timeEstimate,
    isOverdue,
    urgency,
    label,
    freshnessLabel: isStale ? "Stale — updating" : "Live",
    srText: srParts.join(" "),
    dataAgeMs,
    isEstimate: true,
    secondsPerLedger: spl,
    checkpointTime,
  };
}
