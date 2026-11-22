/**
 * Action-Gating Parity Suite for App (Issue #910 / Issue 74).
 *
 * Executes the shared canonical test fixtures from tests/fixtures/actionGatingParityFixtures.json
 * through the App's computeActionEligibility implementation.
 *
 * Validates that App decisions are 100% aligned with SDK gating rules without
 * adding any runtime dependency on the @circleup/sdk package.
 */

import { describe, it, expect } from "vitest";
import {
  computeActionEligibility,
  buildAppSnapshot,
  type CircleAction,
  type AppStateSnapshot,
} from "../lib/gating";
import fixtures from "../../../tests/fixtures/actionGatingParityFixtures.json";

function buildSnapshot(c: (typeof fixtures.cases)[number]): AppStateSnapshot {
  return buildAppSnapshot(
    c.snapshot.status,
    c.snapshot.currentRound,
    c.snapshot.deadlineLedger,
    c.snapshot.latestLedger,
    fixtures.members,
    c.snapshot.hasLockedCollateral,
    c.snapshot.hasContributedCurrentRound,
    c.snapshot.contributionsReceived,
    c.snapshot.networkCheck as any,
    c.snapshot.fetchedAtMs,
  );
}

describe("Action-Gating Parity Suite - App Runner (Issue #910)", () => {
  for (const c of fixtures.cases) {
    it(`[${c.action}] ${c.id}: ${c.description}`, () => {
      const snapshot = buildSnapshot(c);
      const result = computeActionEligibility(c.action as CircleAction, snapshot, {
        maxSnapshotAgeMs: c.options.maxSnapshotAgeMs,
        nowMs: c.options.nowMs,
        memberAddress: c.options.memberAddress,
      });

      expect(result.allowed).toBe(c.expected.allowed);
      if (!result.allowed) {
        expect(result.reason).toBe(c.expected.reason);
      }
    });
  }

  // ─── Intentional Differences (Documented & Reviewed) ─────────────────────────
  describe("Intentional Differences Review (App vs SDK)", () => {
    it("named difference: App early UI network_mismatch block", () => {
      // In the App, when a wallet is connected to an unmatching network,
      // all write actions are blocked with reason "network_mismatch" to
      // prevent signing failure errors.
      const snap = buildAppSnapshot(
        "Active",
        0,
        5000,
        4000,
        fixtures.members,
        true,
        false,
        0,
        "mismatch", // Wallet on different network
        1000000,
      );

      const result = computeActionEligibility("contribute", snap, {
        maxSnapshotAgeMs: 30000,
        nowMs: 1005000,
        memberAddress: fixtures.members[0],
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe("network_mismatch");
        expect(result.message).toContain("different Stellar network");
      }
    });
  });
});
