/**
 * Ledger-authoritative deadline gating (#866).
 *
 * Contract-action eligibility must be derived only from `deadlineLedger` vs.
 * `latestLedger`. These tests pin the boundary semantics and prove wall-clock
 * time never changes a deadline decision.
 */
import { describe, it, expect } from "vitest";

import {
  buildAppSnapshot,
  computeActionEligibility,
  isDeadlinePassedByLedger,
  ledgerDeadlinePhase,
} from "./gating";

const NOW = 1_700_000_000_000;
const MEMBERS = ["GA", "GB", "GC"];

function snap(deadline: number | null, latest: number | null, contributed = false) {
  return buildAppSnapshot("Active", 2, deadline, latest, MEMBERS, true, contributed, 1, "match", NOW);
}

describe("ledgerDeadlinePhase", () => {
  it("open / due / passed / unknown", () => {
    expect(ledgerDeadlinePhase(100, 99)).toBe("open");
    expect(ledgerDeadlinePhase(100, 100)).toBe("due");
    expect(ledgerDeadlinePhase(100, 101)).toBe("passed");
    expect(ledgerDeadlinePhase(null, 101)).toBe("unknown");
    expect(ledgerDeadlinePhase(100, undefined)).toBe("unknown");
    expect(ledgerDeadlinePhase(100, Number.NaN)).toBe("unknown");
    expect(ledgerDeadlinePhase(100, -5)).toBe("unknown");
  });

  it("isDeadlinePassedByLedger is true only when latest > deadline", () => {
    expect(isDeadlinePassedByLedger(100, 100)).toBe(false);
    expect(isDeadlinePassedByLedger(100, 101)).toBe(true);
    expect(isDeadlinePassedByLedger(null, null)).toBe(false);
  });
});

describe("contribute gating — ledger only", () => {
  it("allows at the exact deadline ledger", () => {
    expect(computeActionEligibility("contribute", snap(100, 100), { nowMs: NOW }).allowed).toBe(true);
  });

  it("blocks one ledger past the deadline", () => {
    const r = computeActionEligibility("contribute", snap(100, 101), { nowMs: NOW });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("deadline_passed");
  });

  it("fails open when ledger data is missing", () => {
    expect(computeActionEligibility("contribute", snap(100, null), { nowMs: NOW }).allowed).toBe(true);
  });
});

describe("default gating — ledger only, fails closed", () => {
  it("blocks at the exact deadline ledger", () => {
    const r = computeActionEligibility("default", snap(100, 100), { nowMs: NOW });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("deadline_not_passed");
  });

  it("allows one ledger past the deadline", () => {
    expect(computeActionEligibility("default", snap(100, 101), { nowMs: NOW }).allowed).toBe(true);
  });

  it("blocks when latestLedger is missing", () => {
    const r = computeActionEligibility("default", snap(100, null), { nowMs: NOW });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("deadline_not_passed");
  });

  it("wall-clock time far in the future never declares the deadline passed", () => {
    // Snapshot-age gating is disabled so only deadline logic is exercised.
    const r = computeActionEligibility("default", snap(100, 50), {
      nowMs: NOW + 365 * 86_400_000,
      maxSnapshotAgeMs: Infinity,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("deadline_not_passed");
  });
});

describe("join / payout gating are independent of deadline ledgers", () => {
  it("payout depends on contributions, not the deadline", () => {
    const full = buildAppSnapshot("Active", 2, 100, 500, MEMBERS, true, true, 3, "match", NOW);
    expect(computeActionEligibility("payout", full, { nowMs: NOW }).allowed).toBe(true);
  });

  it("join is unaffected by missing ledger data", () => {
    const pending = buildAppSnapshot("Pending", 0, null, null, MEMBERS, false, false, 0, "match", NOW);
    expect(computeActionEligibility("join", pending, { nowMs: NOW }).allowed).toBe(true);
  });
});
