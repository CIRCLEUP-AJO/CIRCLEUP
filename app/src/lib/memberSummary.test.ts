/**
 * Tests for lib/memberSummary.ts
 *
 * Coverage:
 *   1. Empty history  — pending circle, no rounds
 *   2. All-completed  — every member contributed every round, correct totals
 *   3. Defaults       — member defaulted on some rounds, no double-counting
 *   4. Payee logic    — payout rounds excluded from contribution obligations
 *   5. Cancelled      — cancelled round not counted as a default
 *   6. Mixed history  — contributions, defaults, payouts across several rounds
 *   7. Lifecycle note — indexerLagNote is always non-empty
 *   8. Amount exactness — bigint arithmetic does not lose precision
 */

import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { computeMemberSummary, type MemberSummaryInput } from "./memberSummary";
import type { CircleRound, CircleMember, ContributionRecord, DefaultRecord } from "./circleTypes";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MEMBER_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MEMBER_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBT";
const MEMBER_C = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCT";

function baseMember(addr: string): CircleMember {
  return {
    member_address: addr,
    payout_order: 1,
    collateral: "10000000",
    defaults: 0,
    joined_at: "2024-01-01T00:00:00Z",
    reputation_score: 0,
    total_contributions: 0,
  };
}

function completedRound(
  roundIndex: number,
  recipient: string,
  contributors: string[],
  defaulters: string[] = [],
  roundAmount = "100000000",
): CircleRound {
  return {
    roundIndex,
    status: "completed",
    recipient,
    amount: roundAmount,
    txHash: "abc123",
    contributions: contributors.map((addr): ContributionRecord => ({
      member_address: addr,
      amount: roundAmount,
      tx_hash: "contribtx",
    })),
    defaults: defaulters.map((addr): DefaultRecord => ({
      member_address: addr,
      penalty: "10000000",
    })),
  };
}

function currentRound(roundIndex: number): CircleRound {
  return {
    roundIndex,
    status: "current",
    recipient: null,
    amount: null,
    txHash: null,
    contributions: [],
    defaults: [],
  };
}

function cancelledRound(roundIndex: number): CircleRound {
  return {
    roundIndex,
    status: "cancelled",
    recipient: null,
    amount: null,
    txHash: null,
    contributions: [],
    defaults: [],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Empty history — pending circle
// ═════════════════════════════════════════════════════════════════════════════

describe("Empty history: pending circle", () => {
  const input: MemberSummaryInput = {
    member: baseMember(MEMBER_A),
    rounds: [],
    circleStatus: "Pending",
  };

  test("all counts are zero", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.contributionCount, 0);
    assert.equal(s.defaultCount, 0);
    assert.equal(s.receivedCount, 0);
    assert.equal(s.settledRoundCount, 0);
  });

  test("amounts are zero / null", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.contributedAmountStroops, BigInt(0));
    assert.equal(s.receivedAmountStroops, null);
  });

  test("lifecycle is 'pending'", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.circleLifecycle, "pending");
  });

  test("indexerLagNote is non-empty", () => {
    const s = computeMemberSummary(input);
    assert.ok(s.indexerLagNote.length > 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. All-completed: member contributed every round
// ═════════════════════════════════════════════════════════════════════════════

describe("All-completed: member contributed every non-payee round", () => {
  // 3-member circle; MEMBER_A gets payout on round 3
  const rounds: CircleRound[] = [
    completedRound(1, MEMBER_B, [MEMBER_A, MEMBER_C]),
    completedRound(2, MEMBER_C, [MEMBER_A, MEMBER_B]),
    completedRound(3, MEMBER_A, [MEMBER_B, MEMBER_C]),
  ];

  const input: MemberSummaryInput = {
    member: baseMember(MEMBER_A),
    rounds,
    circleStatus: "Completed",
  };

  test("contributionCount = 2 (not payee on round 3)", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.contributionCount, 2);
  });

  test("settledRoundCount = 3", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.settledRoundCount, 3);
  });

  test("receivedCount = 1, receivedAmountStroops = round amount", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.receivedCount, 1);
    assert.equal(s.receivedAmountStroops, BigInt("100000000"));
  });

  test("defaultCount = 0", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.defaultCount, 0);
  });

  test("lifecycle is 'completed'", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.circleLifecycle, "completed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Defaults — member defaulted on some rounds
// ═════════════════════════════════════════════════════════════════════════════

describe("Defaults: member defaulted on round 2 but contributed on round 1", () => {
  const rounds: CircleRound[] = [
    completedRound(1, MEMBER_B, [MEMBER_A, MEMBER_C]),       // A contributed
    completedRound(2, MEMBER_C, [], [MEMBER_A]),               // A defaulted
    completedRound(3, MEMBER_A, [MEMBER_B, MEMBER_C]),         // A is payee
  ];

  const input: MemberSummaryInput = {
    member: baseMember(MEMBER_A),
    rounds,
    circleStatus: "Completed",
  };

  test("contributionCount = 1 (only round 1)", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.contributionCount, 1);
  });

  test("defaultCount = 1", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.defaultCount, 1);
  });

  test("receivedCount = 1 (round 3)", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.receivedCount, 1);
  });

  test("no double-counting: contribution + default + payout = 3 separate rounds", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.contributionCount + s.defaultCount + s.receivedCount, 3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Payee logic — payout rounds excluded from contribution obligations
// ═════════════════════════════════════════════════════════════════════════════

describe("Payee round is excluded from contribution obligations", () => {
  const rounds: CircleRound[] = [
    completedRound(1, MEMBER_A, [MEMBER_B, MEMBER_C]), // A is payee
  ];

  const input: MemberSummaryInput = {
    member: baseMember(MEMBER_A),
    rounds,
    circleStatus: "Completed",
  };

  test("payee is not counted as contributor", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.contributionCount, 0);
  });

  test("payee is not counted as defaulter", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.defaultCount, 0);
  });

  test("payee receivedCount = 1", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.receivedCount, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Cancelled circle — cancelled round not counted as a default
// ═════════════════════════════════════════════════════════════════════════════

describe("Cancelled circle: cancelled round not a default", () => {
  const rounds: CircleRound[] = [
    completedRound(1, MEMBER_B, [MEMBER_A, MEMBER_C]),  // settled before cancel
    cancelledRound(2),                                   // circle cancelled mid-round
  ];

  const input: MemberSummaryInput = {
    member: baseMember(MEMBER_A),
    rounds,
    circleStatus: "Cancelled",
  };

  test("defaultCount = 0 for cancelled round", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.defaultCount, 0);
  });

  test("settledRoundCount = 1 (only the completed round)", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.settledRoundCount, 1);
  });

  test("lifecycle is 'cancelled'", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.circleLifecycle, "cancelled");
  });

  test("indexerLagNote mentions cancelled round semantics", () => {
    const s = computeMemberSummary(input);
    assert.ok(
      s.indexerLagNote.toLowerCase().includes("cancel"),
      "lag note should explain cancelled round handling",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. In-progress (current) round excluded from settled metrics
// ═════════════════════════════════════════════════════════════════════════════

describe("Active circle: current round excluded from settled metrics", () => {
  const rounds: CircleRound[] = [
    completedRound(1, MEMBER_B, [MEMBER_A, MEMBER_C]),
    currentRound(2), // in-progress
  ];

  const input: MemberSummaryInput = {
    member: baseMember(MEMBER_A),
    rounds,
    circleStatus: "Active",
  };

  test("settledRoundCount = 1 (only completed rounds)", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.settledRoundCount, 1);
  });

  test("contributionCount = 1 (only completed round)", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.contributionCount, 1);
  });

  test("lifecycle is 'active'", () => {
    const s = computeMemberSummary(input);
    assert.equal(s.circleLifecycle, "active");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Lifecycle note — always non-empty
// ═════════════════════════════════════════════════════════════════════════════

describe("indexerLagNote is always non-empty across lifecycle states", () => {
  const statuses = ["Pending", "Active", "Completed", "Cancelled", "Closed"] as const;

  for (const status of statuses) {
    test(`status=${status} produces non-empty indexerLagNote`, () => {
      const input: MemberSummaryInput = {
        member: baseMember(MEMBER_A),
        rounds: [],
        circleStatus: status,
      };
      const s = computeMemberSummary(input);
      assert.ok(s.indexerLagNote.length > 0, `indexerLagNote missing for status: ${status}`);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Amount exactness
// ═════════════════════════════════════════════════════════════════════════════

describe("Amount exactness: bigint accumulation", () => {
  test("exact amount accumulated across multiple contribution rounds", () => {
    const amt = "7000000"; // 0.7 USDC in stroops
    const rounds: CircleRound[] = [
      completedRound(1, MEMBER_B, [MEMBER_A], [], amt),
      completedRound(2, MEMBER_C, [MEMBER_A], [], amt),
    ];
    const input: MemberSummaryInput = {
      member: baseMember(MEMBER_A),
      rounds,
      circleStatus: "Active",
    };
    const s = computeMemberSummary(input);
    assert.equal(s.contributedAmountStroops, BigInt(7000000) + BigInt(7000000));
  });

  test("received amount is exact bigint", () => {
    const payoutAmt = "700000000"; // 70 USDC
    const rounds: CircleRound[] = [
      completedRound(1, MEMBER_A, [MEMBER_B, MEMBER_C], [], payoutAmt),
    ];
    const input: MemberSummaryInput = {
      member: baseMember(MEMBER_A),
      rounds,
      circleStatus: "Completed",
    };
    const s = computeMemberSummary(input);
    assert.equal(s.receivedAmountStroops, BigInt(payoutAmt));
  });

  test("malformed amount string is treated as zero and does not throw", () => {
    const rounds: CircleRound[] = [
      {
        roundIndex: 1,
        status: "completed",
        recipient: MEMBER_B,
        amount: "100000000",
        txHash: "abc",
        contributions: [
          { member_address: MEMBER_A, amount: "not-a-number", tx_hash: "tx" },
        ],
        defaults: [],
      },
    ];
    const input: MemberSummaryInput = {
      member: baseMember(MEMBER_A),
      rounds,
      circleStatus: "Completed",
    };
    assert.doesNotThrow(() => computeMemberSummary(input));
    const s = computeMemberSummary(input);
    assert.equal(s.contributedAmountStroops, BigInt(0));
  });
});
