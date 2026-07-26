import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupByRoundIndex,
  groupCircleRounds,
} from "./groupRounds";

test("groupByRoundIndex buckets rows in a single pass", () => {
  const rows = [
    { round_index: 0, id: "a" },
    { round_index: 1, id: "b" },
    { round_index: 0, id: "c" },
  ];
  const map = groupByRoundIndex(rows);
  assert.equal(map.get(0)?.length, 2);
  assert.equal(map.get(1)?.length, 1);
  assert.equal(map.has(2), false);
});

test("groupCircleRounds nests contributions and defaults under completed payouts", () => {
  const result = groupCircleRounds(
    { current_round: 1, status: "Active" },
    [
      {
        round_index: 0,
        recipient: "GREC",
        amount: "100",
        tx_hash: "tx0",
        ledger: "10",
      },
    ],
    [
      { round_index: 0, member_address: "M1" },
      { round_index: 0, member_address: "M2" },
      { round_index: 1, member_address: "M1" },
    ],
    [{ round_index: 0, member_address: "M3", penalty: "20" }],
  );

  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].status, "completed");
  assert.equal(result.rounds[0].recipient, "GREC");
  assert.equal(result.rounds[0].contributions.length, 2);
  assert.equal(result.rounds[0].defaults.length, 1);

  assert.ok(result.currentRound);
  assert.equal(result.currentRound!.status, "current");
  assert.equal(result.currentRound!.roundIndex, 1);
  assert.equal(result.currentRound!.contributions.length, 1);
  assert.equal(result.currentRound!.recipient, null);

  assert.equal(result.openRounds.length, 0);
  assert.equal(result.pendingDefaults.length, 0);
});

test("groupCircleRounds surfaces unpaid non-current activity as openRounds", () => {
  // Contribution landed on round 0 but no payout yet, while circle already
  // advanced current_round to 1 (edge / reorg / partial ingest case).
  const result = groupCircleRounds(
    { current_round: 1, status: "Active" },
    [],
    [{ round_index: 0, member_address: "M1" }],
    [{ round_index: 0, member_address: "M2", penalty: "5" }],
  );

  assert.equal(result.rounds.length, 0);
  assert.equal(result.openRounds.length, 1);
  assert.equal(result.openRounds[0].roundIndex, 0);
  assert.equal(result.openRounds[0].status, "open");
  assert.equal(result.openRounds[0].contributions.length, 1);
  assert.equal(result.openRounds[0].defaults.length, 1);

  assert.ok(result.currentRound);
  assert.equal(result.currentRound!.roundIndex, 1);
  assert.equal(result.pendingDefaults.length, 1);
});

test("groupCircleRounds marks cancelled current round without mixing into completed", () => {
  const result = groupCircleRounds(
    { current_round: 2, status: "Cancelled" },
    [
      {
        round_index: 0,
        recipient: "GREC",
        amount: "50",
        tx_hash: "tx0",
        ledger: "1",
      },
    ],
    [{ round_index: 2, member_address: "M1" }],
    [],
  );

  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].status, "completed");
  assert.ok(result.currentRound);
  assert.equal(result.currentRound!.status, "cancelled");
  assert.equal(result.currentRound!.contributions.length, 1);
});
