/**
 * Unit tests for the canonical action-gating model (sdk/src/gating.ts).
 *
 * All tests are pure (no RPC, no I/O).  Time is controlled via the `nowMs`
 * option so TTL and expiry behaviour is deterministic.
 *
 * Coverage areas:
 *   - isSnapshotFresh / snapshotAgeMs helpers
 *   - buildSnapshot factory
 *   - computeActionEligibility for every action × every guard condition
 *   - Expired TTL blocking (stale_snapshot)
 *   - Cache invalidation and round-progression guards
 *   - Type-guard helpers (isGateAllowed / isGateBlocked)
 */

import { describe, it, expect } from "vitest";
import {
  computeActionEligibility,
  buildSnapshot,
  isSnapshotFresh,
  snapshotAgeMs,
  isGateAllowed,
  isGateBlocked,
  DEFAULT_MAX_SNAPSHOT_AGE_MS,
} from "../gating";
import type { StateSnapshot, GateOptions } from "../gating";
import type { CircleConfig, RoundState, CircleStatus } from "../types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ALICE = "GABC0000000000000000000000000000000000000000000000000000";
const BOB   = "GDEF0000000000000000000000000000000000000000000000000000";
const CAROL = "GHIJ0000000000000000000000000000000000000000000000000000";

const BASE_CONFIG: CircleConfig = {
  members: [ALICE, BOB, CAROL],
  roundAmount: 100_000_000n,
  usdcToken: "CUSDC0000000000000000000000000000000000000000000000000000",
  reputationContract: "CREP00000000000000000000000000000000000000000000000000000",
  roundDeadlineLedgers: 1_000,
};

const ACTIVE_ROUND: RoundState = {
  roundIndex: 0,
  recipient: ALICE,
  contributionsReceived: 0,
  deadlineLedger: 10_000n,
  paidOut: false,
};

const NOW_MS  = 1_000_000; // fixed "now" for all tests
const FRESH_AT = NOW_MS - 1_000; // 1 s ago — well within any reasonable TTL

function makeSnapshot(
  status: CircleStatus,
  round: RoundState | null = ACTIVE_ROUND,
  opts: Partial<Pick<StateSnapshot, "fetchedAtMs" | "latestLedger">> = {},
): StateSnapshot {
  return buildSnapshot(
    status,
    round,
    BASE_CONFIG,
    opts.latestLedger ?? null,
    opts.fetchedAtMs ?? FRESH_AT,
  );
}

// ─── isSnapshotFresh ───────────────────────────────────────────────────────────

describe("isSnapshotFresh", () => {
  it("returns true when snapshot is younger than maxAgeMs", () => {
    const snap = { fetchedAtMs: NOW_MS - 5_000 };
    expect(isSnapshotFresh(snap, 10_000, NOW_MS)).toBe(true);
  });

  it("returns false when snapshot equals maxAgeMs (boundary is exclusive)", () => {
    const snap = { fetchedAtMs: NOW_MS - 10_000 };
    expect(isSnapshotFresh(snap, 10_000, NOW_MS)).toBe(false);
  });

  it("returns false when snapshot is older than maxAgeMs", () => {
    const snap = { fetchedAtMs: NOW_MS - 30_001 };
    expect(isSnapshotFresh(snap, 30_000, NOW_MS)).toBe(false);
  });

  it("returns true for any age when maxAgeMs is Infinity", () => {
    const snap = { fetchedAtMs: 0 }; // extremely old
    expect(isSnapshotFresh(snap, Infinity, NOW_MS)).toBe(true);
  });

  it("uses DEFAULT_MAX_SNAPSHOT_AGE_MS when maxAgeMs is omitted", () => {
    const justFresh = { fetchedAtMs: NOW_MS - DEFAULT_MAX_SNAPSHOT_AGE_MS + 1 };
    const tooOld    = { fetchedAtMs: NOW_MS - DEFAULT_MAX_SNAPSHOT_AGE_MS };
    expect(isSnapshotFresh(justFresh, undefined, NOW_MS)).toBe(true);
    expect(isSnapshotFresh(tooOld,    undefined, NOW_MS)).toBe(false);
  });
});

// ─── snapshotAgeMs ────────────────────────────────────────────────────────────

describe("snapshotAgeMs", () => {
  it("returns the difference between nowMs and fetchedAtMs", () => {
    expect(snapshotAgeMs({ fetchedAtMs: NOW_MS - 7_500 }, NOW_MS)).toBe(7_500);
  });

  it("returns 0 when the snapshot was just fetched", () => {
    expect(snapshotAgeMs({ fetchedAtMs: NOW_MS }, NOW_MS)).toBe(0);
  });
});

// ─── buildSnapshot ────────────────────────────────────────────────────────────

describe("buildSnapshot", () => {
  it("sets fetchedAtMs to nowMs", () => {
    const s = buildSnapshot("Active", ACTIVE_ROUND, BASE_CONFIG, null, NOW_MS);
    expect(s.fetchedAtMs).toBe(NOW_MS);
  });

  it("preserves all fields", () => {
    const s = buildSnapshot("Pending", null, BASE_CONFIG, 500, NOW_MS);
    expect(s.status).toBe("Pending");
    expect(s.currentRound).toBeNull();
    expect(s.config).toBe(BASE_CONFIG);
    expect(s.latestLedger).toBe(500);
  });
});

// ─── Type guards ──────────────────────────────────────────────────────────────

describe("isGateAllowed / isGateBlocked", () => {
  it("isGateAllowed returns true for an allowed result", () => {
    const r = computeActionEligibility("payout", makeSnapshot("Active", {
      ...ACTIVE_ROUND,
      contributionsReceived: 3,
    }), { contributionsReceived: 3, nowMs: NOW_MS });
    expect(isGateAllowed(r)).toBe(true);
    expect(isGateBlocked(r)).toBe(false);
  });

  it("isGateBlocked returns true for a blocked result", () => {
    const r = computeActionEligibility("join", makeSnapshot("Active"), { nowMs: NOW_MS });
    expect(isGateBlocked(r)).toBe(true);
    expect(isGateAllowed(r)).toBe(false);
  });
});

// ─── join ─────────────────────────────────────────────────────────────────────

describe("computeActionEligibility — join", () => {
  it("allows join on a fresh Pending circle for a listed member", () => {
    const snap = makeSnapshot("Pending", ACTIVE_ROUND);
    const r = computeActionEligibility("join", snap, {
      memberAddress: ALICE,
      hasLockedCollateral: false,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks join on an Active circle (wrong_status)", () => {
    const snap = makeSnapshot("Active");
    const r = computeActionEligibility("join", snap, {
      memberAddress: ALICE,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("blocks join on a Completed circle (wrong_status)", () => {
    const snap = makeSnapshot("Completed", null);
    const r = computeActionEligibility("join", snap, {
      memberAddress: ALICE,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("blocks join on a Cancelled circle (wrong_status)", () => {
    const snap = makeSnapshot("Cancelled", null);
    const r = computeActionEligibility("join", snap, {
      memberAddress: ALICE,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("blocks join when member is not in the config list (not_a_member)", () => {
    const snap = makeSnapshot("Pending");
    const outsider = "GZZZ0000000000000000000000000000000000000000000000000000";
    const r = computeActionEligibility("join", snap, {
      memberAddress: outsider,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("not_a_member");
  });

  it("blocks join when member has already locked collateral (already_joined)", () => {
    const snap = makeSnapshot("Pending");
    const r = computeActionEligibility("join", snap, {
      memberAddress: ALICE,
      hasLockedCollateral: true,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("already_joined");
  });

  it("blocks join on a stale snapshot (stale_snapshot)", () => {
    const staleAt = NOW_MS - 60_000; // 60 s ago
    const snap = makeSnapshot("Pending", ACTIVE_ROUND, { fetchedAtMs: staleAt });
    const r = computeActionEligibility("join", snap, {
      memberAddress: ALICE,
      maxSnapshotAgeMs: 30_000,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });

  it("allows join without a memberAddress check when memberAddress is omitted", () => {
    const snap = makeSnapshot("Pending");
    const r = computeActionEligibility("join", snap, { nowMs: NOW_MS });
    expect(r.allowed).toBe(true);
  });
});

// ─── contribute ───────────────────────────────────────────────────────────────

describe("computeActionEligibility — contribute", () => {
  it("allows contribute on a fresh Active circle before the deadline", () => {
    // latestLedger = 5_000 < deadlineLedger = 10_000
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 5_000 });
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks contribute on a Pending circle (wrong_status)", () => {
    const snap = makeSnapshot("Pending");
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("blocks contribute when there is no active round (no_active_round)", () => {
    const snap = makeSnapshot("Active", null); // no round — unusual but guard it
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("no_active_round");
  });

  it("blocks contribute for a non-member (not_a_member)", () => {
    const outsider = "GZZZ0000000000000000000000000000000000000000000000000000";
    const snap = makeSnapshot("Active");
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: outsider,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("not_a_member");
  });

  it("blocks contribute when the deadline has passed (deadline_passed)", () => {
    // latestLedger = 10_001 > deadlineLedger = 10_000
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 10_001 });
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("deadline_passed");
  });

  it("does not block on deadline when latestLedger is null (no ledger data)", () => {
    // When latestLedger is unknown we skip the deadline check
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: null });
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks contribute when member already contributed this round (already_contributed)", () => {
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 5_000 });
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: true,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("already_contributed");
  });

  it("blocks contribute on a stale snapshot (stale_snapshot)", () => {
    const staleAt = NOW_MS - 45_000;
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { fetchedAtMs: staleAt });
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      maxSnapshotAgeMs: 30_000,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });

  it("allows contribute at exactly the deadline ledger (boundary inclusive)", () => {
    // latestLedger = deadlineLedger (not yet past)
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 10_000 });
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });
});

// ─── payout ───────────────────────────────────────────────────────────────────

describe("computeActionEligibility — payout", () => {
  it("allows payout when all members have contributed (contributionsReceived = member_count)", () => {
    const fullRound: RoundState = { ...ACTIVE_ROUND, contributionsReceived: 3 };
    const snap = makeSnapshot("Active", fullRound);
    const r = computeActionEligibility("payout", snap, {
      contributionsReceived: 3,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks payout when contributions are incomplete (round_not_complete)", () => {
    const snap = makeSnapshot("Active", { ...ACTIVE_ROUND, contributionsReceived: 1 });
    const r = computeActionEligibility("payout", snap, {
      contributionsReceived: 1,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("round_not_complete");
  });

  it("uses round.contributionsReceived when opts.contributionsReceived is not supplied", () => {
    // Round has 2 out of 3 contributions — incomplete
    const snap = makeSnapshot("Active", { ...ACTIVE_ROUND, contributionsReceived: 2 });
    const r = computeActionEligibility("payout", snap, { nowMs: NOW_MS });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("round_not_complete");
  });

  it("blocks payout on a Pending circle (wrong_status)", () => {
    const snap = makeSnapshot("Pending");
    const r = computeActionEligibility("payout", snap, { nowMs: NOW_MS });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("blocks payout on a Completed circle (wrong_status)", () => {
    const snap = makeSnapshot("Completed", null);
    const r = computeActionEligibility("payout", snap, { nowMs: NOW_MS });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("blocks payout when there is no active round (no_active_round)", () => {
    const snap = makeSnapshot("Active", null);
    const r = computeActionEligibility("payout", snap, { nowMs: NOW_MS });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("no_active_round");
  });

  it("blocks payout on a stale snapshot (stale_snapshot)", () => {
    const staleAt = NOW_MS - 60_001;
    const snap = makeSnapshot("Active", { ...ACTIVE_ROUND, contributionsReceived: 3 }, {
      fetchedAtMs: staleAt,
    });
    const r = computeActionEligibility("payout", snap, {
      contributionsReceived: 3,
      maxSnapshotAgeMs: 30_000,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });
});

// ─── default (mark_default) ─────────────────────────────────────────────────

describe("computeActionEligibility — default", () => {
  it("allows default once the deadline has passed and the target has not contributed", () => {
    // latestLedger = 10_001 > deadlineLedger = 10_000
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 10_001 });
    const r = computeActionEligibility("default", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks default before the deadline (deadline_not_passed)", () => {
    // latestLedger = 5_000 < deadlineLedger = 10_000 — window still open
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 5_000 });
    const r = computeActionEligibility("default", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("deadline_not_passed");
  });

  it("blocks default at exactly the deadline ledger (boundary — not yet passed)", () => {
    // Mirror image of contribute's inclusive boundary: at deadlineLedger the
    // window is still open, so a default is premature.
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 10_000 });
    const r = computeActionEligibility("default", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("deadline_not_passed");
  });

  it("fails closed when latestLedger is null (unknown ledger disables default)", () => {
    // Unlike contribute (which fails open on null ledger), default must refuse.
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: null });
    const r = computeActionEligibility("default", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("deadline_not_passed");
  });

  it("blocks default on a Pending circle (wrong_status)", () => {
    const snap = makeSnapshot("Pending");
    const r = computeActionEligibility("default", snap, {
      memberAddress: BOB,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("blocks default when there is no active round (no_active_round)", () => {
    const snap = makeSnapshot("Active", null);
    const r = computeActionEligibility("default", snap, {
      memberAddress: BOB,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("no_active_round");
  });

  it("blocks default for a target that is not a member (not_a_member)", () => {
    const outsider = "GZZZ0000000000000000000000000000000000000000000000000000";
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 10_001 });
    const r = computeActionEligibility("default", snap, {
      memberAddress: outsider,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("not_a_member");
  });

  it("blocks default when the target already contributed (already_contributed)", () => {
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 10_001 });
    const r = computeActionEligibility("default", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: true,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("already_contributed");
  });

  it("blocks default on a stale snapshot (stale_snapshot)", () => {
    const staleAt = NOW_MS - 45_000;
    const snap = makeSnapshot("Active", ACTIVE_ROUND, {
      fetchedAtMs: staleAt,
      latestLedger: 10_001,
    });
    const r = computeActionEligibility("default", snap, {
      memberAddress: BOB,
      maxSnapshotAgeMs: 30_000,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });
});

// ─── close ────────────────────────────────────────────────────────────────────

describe("computeActionEligibility — close", () => {
  it("allows close on a Completed circle for a listed member", () => {
    const snap = makeSnapshot("Completed", null);
    const r = computeActionEligibility("close", snap, {
      memberAddress: CAROL,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });

  it("allows close on a Cancelled circle", () => {
    const snap = makeSnapshot("Cancelled", null);
    const r = computeActionEligibility("close", snap, {
      memberAddress: BOB,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks close on an Active circle (wrong_status)", () => {
    const snap = makeSnapshot("Active");
    const r = computeActionEligibility("close", snap, {
      memberAddress: ALICE,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("blocks close on a Pending circle (wrong_status)", () => {
    const snap = makeSnapshot("Pending");
    const r = computeActionEligibility("close", snap, {
      memberAddress: ALICE,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("blocks close for a non-member (not_a_member)", () => {
    const snap = makeSnapshot("Completed", null);
    const outsider = "GZZZ0000000000000000000000000000000000000000000000000000";
    const r = computeActionEligibility("close", snap, {
      memberAddress: outsider,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("not_a_member");
  });

  it("blocks close on a stale snapshot (stale_snapshot)", () => {
    const staleAt = NOW_MS - 60_000;
    const snap = makeSnapshot("Completed", null, { fetchedAtMs: staleAt });
    const r = computeActionEligibility("close", snap, {
      memberAddress: ALICE,
      maxSnapshotAgeMs: 30_000,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });
});

// ─── Stale snapshot (cross-action) ────────────────────────────────────────────

describe("stale_snapshot blocks every action when TTL has expired", () => {
  const STALE_AT = NOW_MS - DEFAULT_MAX_SNAPSHOT_AGE_MS; // exactly at the boundary → stale
  const staleSnap = (status: CircleStatus, round: RoundState | null = ACTIVE_ROUND) =>
    makeSnapshot(status, round, { fetchedAtMs: STALE_AT });

  const cases: Array<[CircleAction, CircleStatus, RoundState | null, GateOptions]> = [
    ["join",       "Pending",   ACTIVE_ROUND,                            { memberAddress: ALICE }],
    ["contribute", "Active",    ACTIVE_ROUND,                            { memberAddress: BOB }],
    ["payout",     "Active",    { ...ACTIVE_ROUND, contributionsReceived: 3 }, { contributionsReceived: 3 }],
    ["default",    "Active",    ACTIVE_ROUND,                            { memberAddress: BOB }],
    ["close",      "Completed", null,                                    { memberAddress: CAROL }],
  ];

  it.each(cases)(
    "%s on a %s circle with a stale snapshot → stale_snapshot",
    (action, status, round, opts) => {
      const snap = staleSnap(status, round);
      const r = computeActionEligibility(action, snap, { ...opts, nowMs: NOW_MS });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
    },
  );
});

// ─── maxSnapshotAgeMs override ────────────────────────────────────────────────

describe("maxSnapshotAgeMs option overrides the default", () => {
  it("custom 5 s TTL treats a 6 s old snapshot as stale", () => {
    const snap = makeSnapshot("Pending", ACTIVE_ROUND, { fetchedAtMs: NOW_MS - 6_000 });
    const r = computeActionEligibility("join", snap, {
      memberAddress: ALICE,
      maxSnapshotAgeMs: 5_000,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });

  it("custom 5 s TTL treats a 4 s old snapshot as fresh", () => {
    const snap = makeSnapshot("Pending", ACTIVE_ROUND, { fetchedAtMs: NOW_MS - 4_000 });
    const r = computeActionEligibility("join", snap, {
      memberAddress: ALICE,
      maxSnapshotAgeMs: 5_000,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });

  it("Infinity disables the age check entirely", () => {
    const ancientSnap = makeSnapshot("Pending", ACTIVE_ROUND, { fetchedAtMs: 0 });
    const r = computeActionEligibility("join", ancientSnap, {
      memberAddress: ALICE,
      maxSnapshotAgeMs: Infinity,
      nowMs: NOW_MS,
    });
    expect(r.allowed).toBe(true);
  });
});

// ─── Round-progression guard ───────────────────────────────────────────────────
//
// After a payout the on-chain round advances.  If a client snapshot still shows
// the OLD round index and the member queries hasContributedCurrentRound, the
// stale snapshot should be caught before the contribution is submitted so the
// client doesn't write against the wrong round.

describe("round-progression stale-state guard", () => {
  it("blocks contribute on a snapshot that is too old to trust the round index", () => {
    // Simulate: snapshot was fetched 35 s ago (round 0), payout already ran
    // and chain is now on round 1.  The app doesn't know yet.
    const oldRoundSnap = makeSnapshot("Active", {
      ...ACTIVE_ROUND,
      roundIndex: 0,
      contributionsReceived: 0,
    }, { fetchedAtMs: NOW_MS - 35_000 });

    const r = computeActionEligibility("contribute", oldRoundSnap, {
      memberAddress: BOB,
      maxSnapshotAgeMs: 30_000,
      nowMs: NOW_MS,
    });

    // The primary gate is stale_snapshot — the round-index divergence is
    // irrelevant because the freshness check fires first.
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });

  it("allows contribute once snapshot is refreshed to the new round", () => {
    const refreshedSnap = makeSnapshot("Active", {
      ...ACTIVE_ROUND,
      roundIndex: 1,
      contributionsReceived: 0,
      deadlineLedger: 20_000n,
    }, { fetchedAtMs: NOW_MS - 1_000, latestLedger: 15_000 });

    const r = computeActionEligibility("contribute", refreshedSnap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      maxSnapshotAgeMs: 30_000,
      nowMs: NOW_MS,
    });

    expect(r.allowed).toBe(true);
  });

  it("blocks payout on a snapshot taken before all contributions arrived", () => {
    // Snapshot shows only 2 of 3 contributions.  Even if contributions later
    // come in the old snapshot must be rejected.
    const partialSnap = makeSnapshot("Active", {
      ...ACTIVE_ROUND,
      contributionsReceived: 2,
    });

    const r = computeActionEligibility("payout", partialSnap, {
      contributionsReceived: 2,
      nowMs: NOW_MS,
    });

    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("round_not_complete");
  });

  it("allows payout once snapshot is refreshed to show all contributions", () => {
    const fullSnap = makeSnapshot("Active", {
      ...ACTIVE_ROUND,
      contributionsReceived: 3,
    });

    const r = computeActionEligibility("payout", fullSnap, {
      contributionsReceived: 3,
      nowMs: NOW_MS,
    });

    expect(r.allowed).toBe(true);
  });
});

// ─── Message content ──────────────────────────────────────────────────────────

describe("blocked results carry informative messages", () => {
  it("stale_snapshot message includes age and limit", () => {
    const staleAt = NOW_MS - 45_000;
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { fetchedAtMs: staleAt });
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      maxSnapshotAgeMs: 30_000,
      nowMs: NOW_MS,
    });
    if (!r.allowed) {
      expect(r.message).toContain("45000ms");
      expect(r.message).toContain("30000ms");
    }
  });

  it("deadline_passed message includes the deadline and latest ledger", () => {
    const snap = makeSnapshot("Active", ACTIVE_ROUND, { latestLedger: 11_000 });
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      nowMs: NOW_MS,
    });
    if (!r.allowed) {
      expect(r.message).toContain("10000");  // deadlineLedger
      expect(r.message).toContain("11000");  // latestLedger
    }
  });

  it("round_not_complete message includes received and member count", () => {
    const snap = makeSnapshot("Active", { ...ACTIVE_ROUND, contributionsReceived: 1 });
    const r = computeActionEligibility("payout", snap, {
      contributionsReceived: 1,
      nowMs: NOW_MS,
    });
    if (!r.allowed) {
      expect(r.message).toContain("3");   // member count
      expect(r.message).toContain("1");   // received
    }
  });
});
