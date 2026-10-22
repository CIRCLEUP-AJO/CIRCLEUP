/**
 * Tests for per-member round participation summary.
 *
 * Acceptance criteria:
 *   - contributed, defaulted, received, not_yet_recorded, unavailable statuses
 *     are correctly derived from round data.
 *   - Inconsistent records (both contribution + default) are surfaced, not collapsed.
 *   - Cancelled rounds produce "unavailable", not "defaulted".
 *   - Current/open rounds produce "not_yet_recorded".
 *   - The payee of a round is "not_obligated" (unsettled) or "received" (settled).
 *   - indexerLagNote is always non-null.
 *   - Entries are sorted by roundIndex ascending.
 */
import { describe, it, expect } from "vitest";
import {
  computeMemberRoundSummary,
  type MemberRoundStatus,
} from "./memberRoundSummary";
import type { CircleRound, ContributionRecord, DefaultRecord } from "./circleTypes";

const MEMBER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA001";
const OTHER  = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA002";

function makeRound(
  index: number,
  status: CircleRound["status"],
  overrides: Partial<CircleRound> = {},
): CircleRound {
  return {
    roundIndex: index,
    status,
    recipient: null,
    amount: null,
    txHash: null,
    contributions: [],
    defaults: [],
    ...overrides,
  };
}

function contrib(addr: string, amount = "10000000"): ContributionRecord {
  return { member_address: addr, amount, tx_hash: "txhash" };
}

function def(addr: string, penalty = "5000000"): DefaultRecord {
  return { member_address: addr, penalty };
}

// ─── Basic statuses ───────────────────────────────────────────────────────────

describe("computeMemberRoundSummary — basic statuses", () => {
  it("contributed: member has a contribution record in a completed round", () => {
    const rounds = [
      makeRound(0, "completed", { contributions: [contrib(MEMBER)] }),
    ];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.entries[0].status).toBe("contributed");
    expect(result.entries[0].contributionRecord).not.toBeNull();
  });

  it("defaulted: member has a default record in a completed round", () => {
    const rounds = [
      makeRound(0, "completed", { defaults: [def(MEMBER)] }),
    ];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.entries[0].status).toBe("defaulted");
    expect(result.entries[0].defaultRecord).not.toBeNull();
  });

  it("received: member is the recipient of a completed round", () => {
    const rounds = [
      makeRound(0, "completed", {
        recipient: MEMBER,
        amount: "40000000",
        txHash: "payout_tx",
      }),
    ];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.entries[0].status).toBe("received");
    expect(result.entries[0].payoutAmountStroops).toBe("40000000");
    expect(result.entries[0].payoutTxHash).toBe("payout_tx");
  });

  it("not_yet_recorded: member in a current round", () => {
    const rounds = [makeRound(0, "current")];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.entries[0].status).toBe("not_yet_recorded");
  });

  it("not_yet_recorded: member in an open round", () => {
    const rounds = [makeRound(0, "open")];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.entries[0].status).toBe("not_yet_recorded");
  });

  it("unavailable: cancelled round", () => {
    const rounds = [makeRound(0, "cancelled")];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Cancelled");
    expect(result.entries[0].status).toBe("unavailable");
  });

  it("not_obligated: member is payee of a non-completed round", () => {
    const rounds = [makeRound(0, "current", { recipient: MEMBER })];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.entries[0].status).toBe("not_obligated");
  });
});

// ─── Inconsistency detection ──────────────────────────────────────────────────

describe("computeMemberRoundSummary — inconsistent records", () => {
  it("inconsistent: both contribution and default present for same member in same round", () => {
    const rounds = [
      makeRound(0, "completed", {
        contributions: [contrib(MEMBER)],
        defaults: [def(MEMBER)],
      }),
    ];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.entries[0].status).toBe("inconsistent");
    expect(result.entries[0].contributionRecord).not.toBeNull();
    expect(result.entries[0].defaultRecord).not.toBeNull();
    expect(result.inconsistentCount).toBe(1);
  });

  it("inconsistentCount is 0 when no conflicts exist", () => {
    const rounds = [
      makeRound(0, "completed", { contributions: [contrib(MEMBER)] }),
      makeRound(1, "completed", { defaults: [def(MEMBER)] }),
    ];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.inconsistentCount).toBe(0);
  });

  it("counts multiple inconsistent rounds", () => {
    const rounds = [
      makeRound(0, "completed", {
        contributions: [contrib(MEMBER)],
        defaults: [def(MEMBER)],
      }),
      makeRound(1, "completed", {
        contributions: [contrib(MEMBER)],
        defaults: [def(MEMBER)],
      }),
    ];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.inconsistentCount).toBe(2);
  });
});

// ─── Multi-round scenarios ────────────────────────────────────────────────────

describe("computeMemberRoundSummary — multi-round scenarios", () => {
  it("handles a mix of completed, current, and cancelled rounds", () => {
    const rounds = [
      makeRound(0, "completed", { contributions: [contrib(MEMBER)] }),
      makeRound(1, "completed", { defaults: [def(MEMBER)] }),
      makeRound(2, "current"),
      makeRound(3, "cancelled"),
    ];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    const statuses = result.entries.map((e) => e.status);
    expect(statuses).toEqual([
      "contributed",
      "defaulted",
      "not_yet_recorded",
      "unavailable",
    ]);
  });

  it("entries are sorted by roundIndex ascending regardless of input order", () => {
    const rounds = [
      makeRound(3, "completed", { contributions: [contrib(MEMBER)] }),
      makeRound(1, "completed", { contributions: [contrib(MEMBER)] }),
      makeRound(2, "current"),
    ];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.entries.map((e) => e.roundIndex)).toEqual([1, 2, 3]);
  });

  it("does not include records for a different member", () => {
    const rounds = [
      makeRound(0, "completed", { contributions: [contrib(OTHER)] }),
    ];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    // MEMBER has no contribution record — status should be unknown (no evidence)
    expect(result.entries[0].status).toBe("unknown");
  });

  it("empty rounds → empty entries", () => {
    const result = computeMemberRoundSummary(MEMBER, [], "Pending");
    expect(result.entries).toHaveLength(0);
    expect(result.inconsistentCount).toBe(0);
  });
});

// ─── Indexer lag note ─────────────────────────────────────────────────────────

describe("computeMemberRoundSummary — indexerLagNote", () => {
  it("is always non-null and non-empty", () => {
    const result = computeMemberRoundSummary(MEMBER, [], "Active");
    expect(result.indexerLagNote).toBeTruthy();
    expect(result.indexerLagNote.length).toBeGreaterThan(10);
  });

  it("freshnessNote on each entry is non-empty", () => {
    const rounds = [makeRound(0, "current")];
    const result = computeMemberRoundSummary(MEMBER, rounds, "Active");
    expect(result.entries[0].freshnessNote).toBeTruthy();
  });
});

// ─── Circle status is preserved ──────────────────────────────────────────────

describe("computeMemberRoundSummary — circleStatus", () => {
  it("reflects the input circleStatus", () => {
    const result = computeMemberRoundSummary(MEMBER, [], "Completed");
    expect(result.circleStatus).toBe("Completed");
  });
});
