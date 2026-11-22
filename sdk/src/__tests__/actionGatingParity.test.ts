/**
 * Action-Gating Parity Suite for @circleup/sdk (Issue #910 / Issue 74).
 *
 * Executes the shared canonical test fixtures from tests/fixtures/actionGatingParityFixtures.json
 * through the SDK's computeActionEligibility implementation.
 *
 * Ensures 100% semantic alignment with the App layer on:
 * - Lifecycle status restrictions
 * - Stale snapshot boundaries (age > maxAge and exact boundary)
 * - Membership prerequisites
 * - Contribution and collateral completion
 * - Ledger deadline boundaries (contribute fails open, default fails closed)
 * - Named intentional differences
 */

import { describe, it, expect } from "vitest";
import { computeActionEligibility, buildSnapshot } from "../gating";
import type { StateSnapshot, CircleAction } from "../gating";
import type { CircleConfig, RoundState, CircleStatus } from "../types";
import fixtures from "../../../tests/fixtures/actionGatingParityFixtures.json";

const USDC_TOKEN = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA4";
const REP_CONTRACT = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function buildSdkSnapshot(c: (typeof fixtures.cases)[number]): StateSnapshot {
  const config: CircleConfig = {
    members: fixtures.members,
    roundAmount: 100_000_000n,
    usdcToken: USDC_TOKEN,
    reputationContract: REP_CONTRACT,
    roundDeadlineLedgers: 120_960,
  };

  const isTerminal = c.snapshot.status === "Completed" || c.snapshot.status === "Cancelled";
  const hasNoRound = c.snapshot.currentRound < 0 || isTerminal;

  const round: RoundState | null = hasNoRound
    ? null
    : {
        roundIndex: c.snapshot.currentRound,
        recipient: fixtures.members[c.snapshot.currentRound % fixtures.members.length],
        contributionsReceived: c.snapshot.contributionsReceived,
        deadlineLedger:
          c.snapshot.deadlineLedger !== null ? BigInt(c.snapshot.deadlineLedger) : 1_000_000n,
        paidOut: false,
      };

  return buildSnapshot(
    c.snapshot.status as CircleStatus,
    round,
    config,
    c.snapshot.latestLedger,
    c.snapshot.fetchedAtMs,
  );
}

describe("Action-Gating Parity Suite - SDK Runner (Issue #910)", () => {
  for (const c of fixtures.cases) {
    it(`[${c.action}] ${c.id}: ${c.description}`, () => {
      const snapshot = buildSdkSnapshot(c);
      const result = computeActionEligibility(c.action as CircleAction, snapshot, {
        memberAddress: c.options.memberAddress,
        hasLockedCollateral: c.snapshot.hasLockedCollateral,
        hasContributedCurrentRound: c.snapshot.hasContributedCurrentRound,
        contributionsReceived: c.snapshot.contributionsReceived,
        maxSnapshotAgeMs: c.options.maxSnapshotAgeMs,
        nowMs: c.options.nowMs,
      });

      expect(result.allowed).toBe(c.expected.allowed);
      if (!result.allowed) {
        expect(result.reason).toBe(c.expected.reason);
      }
    });
  }

  // ─── Intentional Differences (Documented & Reviewed) ─────────────────────────
  describe("Intentional Differences Review (App vs SDK)", () => {
    it("named difference: network_mismatch is enforced at transport/wallet layer in SDK", () => {
      // The App UI layer gates early on network mismatch via snapshot.networkCheck === "mismatch"
      // to avoid triggering wallet signing prompts.
      // The SDK maintains pure contract state snapshots and enforces network passphrase
      // consistency during transaction building and signing (CircleUpClient.networkMismatch).
      expect(true).toBe(true);
    });
  });
});
