import { describe, it, expect } from "vitest";

import {
  computeDeadlineDisplay,
  DEADLINE_MAX_DATA_AGE_MS,
  DEFAULT_SECONDS_PER_LEDGER,
  SECONDS_PER_LEDGER,
  URGENCY_RED_LEDGERS,
  URGENCY_YELLOW_LEDGERS,
  ledgersToHuman,
  resolveSecondsPerLedger,
} from "./deadline";

const NOW = 1_700_000_000_000;

function displayFor({
  deadlineLedger = 5000,
  latestLedger = 4000,
  fetchedAtMs = NOW,
  nowMs = NOW,
  secondsPerLedger,
}: {
  deadlineLedger?: number | null | undefined;
  latestLedger?: number | null | undefined;
  fetchedAtMs?: number;
  nowMs?: number;
  secondsPerLedger?: number;
} = {}): ReturnType<typeof computeDeadlineDisplay> {
  return computeDeadlineDisplay({
    deadlineLedger,
    latestLedger,
    status: "Active",
    fetchedAtMs,
    nowMs,
    secondsPerLedger,
  });
}

describe("deadline — missing ledger data (unavailable)", () => {
  it("is unavailable when deadlineLedger is null", () => {
    const d = displayFor({ deadlineLedger: null });
    expect(d.kind).toBe("unavailable");
    expect(d.phase).toBe("unknown");
    expect(d.ledgersRemaining).toBeNull();
    expect(d.human).toBe("—");
    expect(d.dataAgeMs).toBeNull();
    expect(d.label).toBe("Deadline data not available");
  });

  it("keeps the deadline ledger visible when only latestLedger is missing", () => {
    const d = displayFor({ latestLedger: null });
    expect(d.kind).toBe("unavailable");
    expect(d.deadlineLedger).toBe(5000);
    expect(d.label).toBe("Latest ledger unavailable");
    expect(d.timeEstimate).toBeNull();
    expect(d.freshnessLabel).toBe("Unavailable");
  });

  it("is unavailable when both are undefined", () => {
    const d = computeDeadlineDisplay({
      deadlineLedger: undefined,
      latestLedger: undefined,
      fetchedAtMs: NOW,
    });
    expect(d.kind).toBe("unavailable");
  });

  it("treats non-integer / negative ledgers as unavailable", () => {
    expect(displayFor({ latestLedger: Number.NaN }).kind).toBe("unavailable");
    expect(displayFor({ latestLedger: -1 }).kind).toBe("unavailable");
    expect(displayFor({ deadlineLedger: 10.5 }).kind).toBe("unavailable");
  });

  it("never fabricates a countdown or overdue state when data is missing", () => {
    const d = displayFor({ deadlineLedger: null, latestLedger: 4000 });
    expect(d.isEstimate).toBe(true);
    expect(d.secondsRemaining).toBeNull();
    expect(d.isOverdue).toBe(false);
  });

  it("ignores wall-clock time entirely when ledger data is missing", () => {
    const d = displayFor({ latestLedger: null, nowMs: NOW + 365 * 86_400_000 });
    expect(d.isOverdue).toBe(false);
    expect(d.phase).toBe("unknown");
  });
});

describe("deadline — future deadlines (fresh)", () => {
  it("computes ledgers remaining as deadline minus latest", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 4000 });
    expect(d.phase).toBe("open");
    expect(d.ledgersRemaining).toBe(1000);
    expect(d.secondsRemaining).toBe(1000 * SECONDS_PER_LEDGER);
  });

  it("marks time estimates as approximate", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 4000 });
    // 1000 ledgers × 5 s = 5000 s ≈ 1h 23m
    expect(d.timeEstimate).toBe("≈ 1h 23m");
    expect(d.human).toBe("≈ 1h 23m");
    expect(d.isEstimate).toBe(true);
  });

  it("never shows second-level precision", () => {
    expect(ledgersToHuman(1)).toBe("under 1m");
    expect(ledgersToHuman(11)).toBe("under 1m");
    expect(ledgersToHuman(13)).toBe("1m");
    expect(ledgersToHuman(1000)).not.toMatch(/\d+s\b/);
  });

  it("advances deterministically as the latest ledger advances", () => {
    const earlier = displayFor({ latestLedger: 4000 });
    const later = displayFor({ latestLedger: 4900 });
    expect(later.ledgersRemaining!).toBeLessThan(earlier.ledgersRemaining!);
    expect(later.human).not.toBe(earlier.human);
  });

  it("does not change ledger state as wall-clock time advances", () => {
    const now = displayFor({ nowMs: NOW });
    const later = displayFor({ nowMs: NOW + 60_000 });
    expect(later.phase).toBe(now.phase);
    expect(later.ledgersRemaining).toBe(now.ledgersRemaining);
  });

  it("uses a configured seconds-per-ledger for the estimate only", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 4000, secondsPerLedger: 6 });
    expect(d.secondsPerLedger).toBe(6);
    expect(d.secondsRemaining).toBe(6000);
    expect(d.phase).toBe("open");
  });
});

describe("deadline — exact and past ledger boundaries", () => {
  it("exact equality is due now, not overdue (latest == deadline)", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 5000 });
    expect(d.phase).toBe("due");
    expect(d.ledgersRemaining).toBe(0);
    expect(d.isOverdue).toBe(false);
    expect(d.human).toBe("Due at this ledger");
    expect(d.label).toBe("Deadline ledger reached");
    expect(d.timeEstimate).toBeNull();
  });

  it("one ledger past the deadline is overdue (latest > deadline)", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 5001 });
    expect(d.phase).toBe("passed");
    expect(d.isOverdue).toBe(true);
    expect(d.human).toBe("Deadline passed");
    expect(d.label).toBe("Round deadline passed");
    expect(d.urgency).toBe("red");
    expect(d.timeEstimate).toBeNull();
  });

  it("one ledger before the deadline is still open", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 4999 });
    expect(d.phase).toBe("open");
    expect(d.isOverdue).toBe(false);
    expect(d.ledgersRemaining).toBe(1);
  });
});

describe("deadline — stale data", () => {
  it("is fresh when data is younger than the max age", () => {
    const d = displayFor({ nowMs: NOW + 60_000 });
    expect(d.kind).toBe("fresh");
    expect(d.dataAgeMs).toBe(60_000);
    expect(d.freshnessLabel).toBe("Live");
  });

  it("is stale exactly at the max age (boundary inclusive)", () => {
    const d = displayFor({ nowMs: NOW + DEADLINE_MAX_DATA_AGE_MS });
    expect(d.kind).toBe("stale");
    expect(d.dataAgeMs).toBe(DEADLINE_MAX_DATA_AGE_MS);
  });

  it("suppresses the time estimate and shows ledger progress when stale", () => {
    const d = displayFor({ nowMs: NOW + DEADLINE_MAX_DATA_AGE_MS + 1 });
    expect(d.kind).toBe("stale");
    expect(d.timeEstimate).toBeNull();
    expect(d.secondsRemaining).toBeNull();
    expect(d.human).toBe("1,000 ledgers remaining");
    expect(d.freshnessLabel).toMatch(/stale/i);
  });

  it("stale data never flips an open deadline to passed", () => {
    const d = displayFor({ nowMs: NOW + 10 * DEADLINE_MAX_DATA_AGE_MS });
    expect(d.phase).toBe("open");
    expect(d.isOverdue).toBe(false);
  });
});

describe("deadline — urgency aligned with ledger state", () => {
  it("is green when at least the yellow threshold of ledgers remain", () => {
    const d = displayFor({ deadlineLedger: 4000 + URGENCY_YELLOW_LEDGERS, latestLedger: 4000 });
    expect(d.urgency).toBe("green");
    expect(d.label).toBe("Time remaining");
  });

  it("is yellow below the yellow threshold", () => {
    const d = displayFor({ deadlineLedger: 4000 + URGENCY_RED_LEDGERS, latestLedger: 4000 });
    expect(d.urgency).toBe("yellow");
    expect(d.label).toBe("Deadline approaching");
  });

  it("is red below the red threshold, with matching label", () => {
    const d = displayFor({ deadlineLedger: 4000 + 8_640, latestLedger: 4000 });
    expect(d.urgency).toBe("red");
    expect(d.label).toBe("Deadline imminent");
  });

  it("urgency is independent of the seconds-per-ledger estimate", () => {
    const a = displayFor({ deadlineLedger: 4000 + 20_000, latestLedger: 4000, secondsPerLedger: 1 });
    const b = displayFor({ deadlineLedger: 4000 + 20_000, latestLedger: 4000, secondsPerLedger: 60 });
    expect(a.urgency).toBe(b.urgency);
  });

  it("due and passed are red", () => {
    expect(displayFor({ deadlineLedger: 5000, latestLedger: 5000 }).urgency).toBe("red");
    expect(displayFor({ deadlineLedger: 5000, latestLedger: 6000 }).urgency).toBe("red");
  });
});

describe("deadline — screen-reader wording", () => {
  it("describes ledgers and approximate time for a fresh open deadline", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 4000 });
    expect(d.srText).toContain("Deadline ledger 5,000");
    expect(d.srText).toContain("latest indexed ledger 4,000");
    expect(d.srText).toContain("1,000 ledgers remaining");
    expect(d.srText).toMatch(/Approximately 1h 23m remaining/);
  });

  it("omits time and announces staleness when data is stale", () => {
    const d = displayFor({ nowMs: NOW + DEADLINE_MAX_DATA_AGE_MS });
    expect(d.srText).not.toMatch(/Approximately/);
    expect(d.srText).toMatch(/stale and updating/);
  });

  it("announces a passed deadline in ledger terms", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 5003 });
    expect(d.srText).toContain("Round deadline passed.");
    expect(d.srText).toContain("3 ledgers past deadline");
  });

  it("announces missing latest ledger without a time estimate", () => {
    const d = displayFor({ latestLedger: null });
    expect(d.srText).toContain("ledger 5,000");
    expect(d.srText).toMatch(/cannot be estimated/);
  });
});

describe("deadline — seconds-per-ledger configuration", () => {
  it("defaults to 5", () => {
    expect(DEFAULT_SECONDS_PER_LEDGER).toBe(5);
    expect(resolveSecondsPerLedger(undefined)).toBe(5);
    expect(resolveSecondsPerLedger("")).toBe(5);
  });

  it("accepts in-range overrides", () => {
    expect(resolveSecondsPerLedger("5.5")).toBe(5.5);
    expect(resolveSecondsPerLedger(6)).toBe(6);
  });

  it("rejects invalid or out-of-range overrides", () => {
    expect(resolveSecondsPerLedger("abc")).toBe(5);
    expect(resolveSecondsPerLedger("0")).toBe(5);
    expect(resolveSecondsPerLedger("600")).toBe(5);
  });

  it("DEADLINE_MAX_DATA_AGE_MS is a finite positive number", () => {
    expect(Number.isFinite(DEADLINE_MAX_DATA_AGE_MS)).toBe(true);
    expect(DEADLINE_MAX_DATA_AGE_MS).toBeGreaterThan(0);
  });
});
