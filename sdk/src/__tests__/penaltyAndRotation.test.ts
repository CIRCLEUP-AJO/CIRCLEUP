/**
 * SDK mirrors of contract penalty rounding (#874) and payout rotation (#873).
 * Expected values are the same hand-derived table used by
 * contracts/circle/tests/default_penalty_boundary_tests.rs.
 */
import { describe, it, expect } from "vitest";

import {
  PENALTY_ROUNDING,
  computeDefaultPenalty,
  projectCollateralAfterDefaults,
} from "../penalty";
import { payoutSchedule, payoutSlotOf, recipientForRound } from "../rotation";

describe("computeDefaultPenalty — floor rule", () => {
  it("declares floor rounding", () => {
    expect(PENALTY_ROUNDING).toBe("floor");
  });

  const table: Array<[bigint, bigint, bigint]> = [
    [0n, 0n, 0n],
    [1n, 0n, 1n],
    [4n, 0n, 4n],
    [5n, 1n, 4n],
    [9n, 1n, 8n],
    [10n, 2n, 8n],
    [9_999n, 1_999n, 8_000n],
    [10_000n, 2_000n, 8_000n],
    [10_001n, 2_000n, 8_001n],
    [10_000_000n, 2_000_000n, 8_000_000n],
    [100_000_000n, 20_000_000n, 80_000_000n],
  ];
  it.each(table)("collateral %s → penalty %s, remaining %s", (c, p, r) => {
    expect(computeDefaultPenalty(c)).toEqual({ penalty: p, remaining: r });
  });

  it("equals floor(c / 5) and never goes negative", () => {
    for (let c = 0n; c <= 2_000n; c++) {
      const { penalty, remaining } = computeDefaultPenalty(c);
      expect(penalty).toBe(c / 5n);
      expect(remaining >= 0n).toBe(true);
      if (c >= 1n) expect(remaining >= 1n).toBe(true);
    }
  });

  it("rejects negative collateral and invalid bps", () => {
    expect(() => computeDefaultPenalty(-1n)).toThrow(RangeError);
    expect(() => computeDefaultPenalty(10n, -1)).toThrow(RangeError);
    expect(() => computeDefaultPenalty(10n, 10_001)).toThrow(RangeError);
    expect(() => computeDefaultPenalty(10n, 1.5)).toThrow(RangeError);
  });
});

describe("projectCollateralAfterDefaults", () => {
  it("decays on the remaining balance", () => {
    expect(projectCollateralAfterDefaults(100n, 4)).toEqual([80n, 64n, 52n, 42n]);
  });

  it("smallest contribution stays at 1 stroop", () => {
    expect(projectCollateralAfterDefaults(1n, 4)).toEqual([1n, 1n, 1n, 1n]);
  });

  it("is monotone non-increasing", () => {
    const seq = projectCollateralAfterDefaults(1_000_000_007n, 256);
    let prev = 1_000_000_007n;
    for (const c of seq) {
      expect(c <= prev && c >= 1n).toBe(true);
      prev = c;
    }
  });
});

describe("payout rotation", () => {
  // Deliberately not sorted.
  const members = ["GCZZ", "GAAA", "GMMM"];

  it("preserves input order and maps round i to members[i]", () => {
    expect(payoutSchedule(members)).toEqual([
      { roundIndex: 0, roundNumber: 1, recipient: "GCZZ" },
      { roundIndex: 1, roundNumber: 2, recipient: "GAAA" },
      { roundIndex: 2, roundNumber: 3, recipient: "GMMM" },
    ]);
    expect(recipientForRound(members, 0)).toBe("GCZZ");
    expect(recipientForRound(members, 3)).toBeUndefined();
    expect(recipientForRound(members, -1)).toBeUndefined();
    expect(payoutSlotOf(members, "GMMM")).toBe(2);
    expect(payoutSlotOf(members, "GXXX")).toBe(-1);
  });

  it("schedules each member exactly once", () => {
    const max = Array.from({ length: 256 }, (_, i) => `G${String((i * 7 + 3) % 256).padStart(3, "0")}`);
    const schedule = payoutSchedule(max);
    expect(schedule).toHaveLength(256);
    expect(new Set(schedule.map((s) => s.recipient)).size).toBe(256);
    expect(schedule.map((s) => s.recipient)).toEqual(max);
    expect([...max].sort()).not.toEqual(max);
  });

  it("rejects duplicates (the contract would too)", () => {
    expect(() => payoutSchedule(["GA", "GB", "GA"])).toThrow(/duplicate/);
  });
});
