/**
 * Integration tests — stale app state blocks invalid writes.
 *
 * These tests simulate realistic race-condition scenarios that the app or SDK
 * could encounter:
 *
 *   1. A snapshot is fetched while the circle is Active.
 *   2. Another member's transaction is confirmed on-chain (payout, default, …)
 *      which changes the circle state.
 *   3. The original snapshot is now stale.
 *   4. The action gate must block any write based on the stale snapshot.
 *
 * No RPC is involved — we model the "on-chain state changed" event by
 * manipulating fake snapshot data and the `fetchedAtMs` timestamp.
 *
 * The scenarios below directly model the acceptance criteria from issue #173:
 *   - The app and SDK cannot allow an action based on stale or expired state.
 *   - A stale snapshot is rejected with clear, deterministic guard logic.
 *   - TTL expiry, invalidation, and round progression update the eligibility model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeActionEligibility,
  buildSnapshot,
  isGateBlocked,
  isGateAllowed,
  DEFAULT_MAX_SNAPSHOT_AGE_MS,
} from "../gating";
import { CircleClient, GateError, DEFAULT_FULL_STATE_CACHE_TTL_MS } from "../client";
import type { CircleConfig, RoundState, CircleStatus, CircleUpConfig } from "../types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ALICE = "GABC0000000000000000000000000000000000000000000000000000";
const BOB   = "GDEF0000000000000000000000000000000000000000000000000000";
const CAROL = "GHIJ0000000000000000000000000000000000000000000000000000";

const CONFIG: CircleConfig = {
  members: [ALICE, BOB, CAROL],
  roundAmount: 100_000_000n,
  usdcToken: "CUSDC0000000000000000000000000000000000000000000000000000",
  reputationContract: "CREP00000000000000000000000000000000000000000000000000000",
  roundDeadlineLedgers: 1_000,
};

const SDK_CONFIG: CircleUpConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: {
    circleFactory: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    reputation:    "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    usdc:          "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  },
};

const CIRCLE_ADDR = "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";

const ROUND_0: RoundState = {
  roundIndex: 0,
  recipient: ALICE,
  contributionsReceived: 0,
  deadlineLedger: 20_000n,
  paidOut: false,
};

// ─── Scenario 1: TTL expiry blocks all writes ─────────────────────────────────

describe("Scenario 1: TTL expiry blocks every write action", () => {
  const MAX_AGE = 30_000;

  it("join is blocked when the snapshot has expired", () => {
    const snapshotFetchedAt = 1_000_000;
    const nowAfterExpiry    = snapshotFetchedAt + MAX_AGE; // exactly at boundary → stale

    const snap = buildSnapshot("Pending", ROUND_0, CONFIG, null, snapshotFetchedAt);
    const r = computeActionEligibility("join", snap, {
      memberAddress: ALICE,
      maxSnapshotAgeMs: MAX_AGE,
      nowMs: nowAfterExpiry,
    });

    expect(isGateBlocked(r)).toBe(true);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });

  it("contribute is blocked when the snapshot has expired", () => {
    const snapshotFetchedAt = 2_000_000;
    const nowAfterExpiry    = snapshotFetchedAt + MAX_AGE + 1;

    const snap = buildSnapshot("Active", ROUND_0, CONFIG, null, snapshotFetchedAt);
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      maxSnapshotAgeMs: MAX_AGE,
      nowMs: nowAfterExpiry,
    });

    expect(isGateBlocked(r)).toBe(true);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });

  it("payout is blocked when the snapshot has expired", () => {
    const snapshotFetchedAt = 3_000_000;
    const nowAfterExpiry    = snapshotFetchedAt + MAX_AGE + 1;

    const fullRound: RoundState = { ...ROUND_0, contributionsReceived: 3 };
    const snap = buildSnapshot("Active", fullRound, CONFIG, null, snapshotFetchedAt);
    const r = computeActionEligibility("payout", snap, {
      contributionsReceived: 3,
      maxSnapshotAgeMs: MAX_AGE,
      nowMs: nowAfterExpiry,
    });

    expect(isGateBlocked(r)).toBe(true);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });

  it("close is blocked when the snapshot has expired", () => {
    const snapshotFetchedAt = 4_000_000;
    const nowAfterExpiry    = snapshotFetchedAt + MAX_AGE + 1;

    const snap = buildSnapshot("Completed", null, CONFIG, null, snapshotFetchedAt);
    const r = computeActionEligibility("close", snap, {
      memberAddress: CAROL,
      maxSnapshotAgeMs: MAX_AGE,
      nowMs: nowAfterExpiry,
    });

    expect(isGateBlocked(r)).toBe(true);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });
});

// ─── Scenario 2: Payout happened while client was holding a stale snapshot ────
//
// The client fetched state while Alice was the recipient in round 0.
// Before the client could call contribute, payout ran and the circle advanced
// to round 1.  The old snapshot shows round 0 — it is now stale.

describe("Scenario 2: Payout ran while client held a stale snapshot", () => {
  it("contribute based on the old round snapshot is blocked once TTL expires", () => {
    const T0 = 5_000_000;   // snapshot fetched while circle was on round 0
    const T1 = T0 + 35_000; // 35 s later: payout confirmed, round advanced to 1

    // Old snapshot — still shows round 0, now stale
    const staleSnap = buildSnapshot("Active", {
      ...ROUND_0,
      roundIndex: 0,
      contributionsReceived: 2, // two members contributed before payout ran
    }, CONFIG, null, T0);

    const r = computeActionEligibility("contribute", staleSnap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      maxSnapshotAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
      nowMs: T1,
    });

    expect(isGateBlocked(r)).toBe(true);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });

  it("contribute is allowed once the snapshot is refreshed to the new round", () => {
    const T1 = 5_035_000; // after payout; fresh snapshot fetched

    const freshSnap = buildSnapshot("Active", {
      ...ROUND_0,
      roundIndex: 1,       // new round
      recipient: BOB,
      contributionsReceived: 0,
      deadlineLedger: 25_000n,
    }, CONFIG, 21_000, T1);

    const r = computeActionEligibility("contribute", freshSnap, {
      memberAddress: CAROL,
      hasContributedCurrentRound: false,
      maxSnapshotAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
      nowMs: T1 + 1_000,
    });

    expect(isGateAllowed(r)).toBe(true);
  });
});

// ─── Scenario 3: Default event changed collateral while snapshot was stale ────
//
// A member was marked default after the deadline, changing the on-chain state.
// The app still holds the pre-default snapshot.  Any action from that snapshot
// must be blocked once the TTL lapses.

describe("Scenario 3: Default event fired while client snapshot was stale", () => {
  it("payout attempt with stale-pre-default snapshot is blocked", () => {
    const T0 = 6_000_000;   // snapshot fetched before default
    const T1 = T0 + 40_000; // 40 s later: mark_default confirmed

    // Snapshot shows contributions_received = 2 (missing Carol's).
    // Even if we bump contributions to 3 to simulate a confused app state,
    // the staleness check fires first.
    const staleSnap = buildSnapshot("Active", {
      ...ROUND_0,
      contributionsReceived: 3, // app incorrectly believes all contributed
    }, CONFIG, null, T0);

    const r = computeActionEligibility("payout", staleSnap, {
      contributionsReceived: 3,
      maxSnapshotAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
      nowMs: T1,
    });

    expect(isGateBlocked(r)).toBe(true);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });
});

// ─── Scenario 4: Circle status changed from Active → Completed ───────────────
//
// Final payout ran and the circle is now Completed.  The stale snapshot still
// says "Active".  Any Active-only action (contribute, payout) must be blocked
// — first by staleness, and after a fresh fetch by wrong_status.

describe("Scenario 4: Circle transitioned to Completed while snapshot was stale", () => {
  it("contribute is blocked via stale_snapshot on an outdated Active snapshot", () => {
    const T0 = 7_000_000;
    const T1 = T0 + 60_000; // 1 minute later: final payout confirmed

    const staleActiveSnap = buildSnapshot("Active", ROUND_0, CONFIG, null, T0);
    const r = computeActionEligibility("contribute", staleActiveSnap, {
      memberAddress: BOB,
      maxSnapshotAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
      nowMs: T1,
    });

    expect(isGateBlocked(r)).toBe(true);
    if (!r.allowed) expect(r.reason).toBe("stale_snapshot");
  });

  it("contribute is blocked via wrong_status on a freshly fetched Completed snapshot", () => {
    const T1 = 7_060_000;

    // Fresh snapshot — correctly reflects the new Completed status
    const completedSnap = buildSnapshot("Completed", null, CONFIG, null, T1);
    const r = computeActionEligibility("contribute", completedSnap, {
      memberAddress: BOB,
      maxSnapshotAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
      nowMs: T1 + 500,
    });

    expect(isGateBlocked(r)).toBe(true);
    if (!r.allowed) expect(r.reason).toBe("wrong_status");
  });

  it("close is allowed on a freshly fetched Completed snapshot", () => {
    const T1 = 7_060_000;
    const completedSnap = buildSnapshot("Completed", null, CONFIG, null, T1);
    const r = computeActionEligibility("close", completedSnap, {
      memberAddress: ALICE,
      maxSnapshotAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
      nowMs: T1 + 500,
    });

    expect(isGateAllowed(r)).toBe(true);
  });
});

// ─── Scenario 5: CircleClient.gateActionOrThrow blocks writes via GateError ──

describe("Scenario 5: CircleClient.gateActionOrThrow blocks invalid writes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Create a CircleClient whose read methods are mocked to return given state. */
  function makeClient(status: CircleStatus, round: RoundState | null) {
    const client = new CircleClient(SDK_CONFIG, CIRCLE_ADDR, DEFAULT_FULL_STATE_CACHE_TTL_MS);

    vi.spyOn(client as any, "getConfig").mockResolvedValue(CONFIG);
    vi.spyOn(client as any, "getStatus").mockResolvedValue(status);
    // getFullState calls getCurrentRoundResult (non-throwing) for Active/Pending circles
    vi.spyOn(client as any, "getCurrentRoundResult").mockResolvedValue(
      round ? { ok: true, value: round } : { ok: false, error: "no active round" },
    );

    return client;
  }

  it("gateActionOrThrow does NOT throw when the action is allowed", async () => {
    const client = makeClient("Pending", ROUND_0);
    await client.getFullState(); // populate cache

    await expect(
      client.gateActionOrThrow("join", {
        memberAddress: ALICE,
        hasLockedCollateral: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("gateActionOrThrow throws GateError with wrong_status when circle is not Active", async () => {
    const client = makeClient("Pending", ROUND_0);
    await client.getFullState();

    await expect(
      client.gateActionOrThrow("contribute", { memberAddress: BOB }),
    ).rejects.toMatchObject({
      name: "GateError",
      reason: "wrong_status",
    });
  });

  it("gateActionOrThrow throws GateError with stale_snapshot after cache expires", async () => {
    // Use a very long cache TTL (60 s) so the cache stays valid throughout.
    // The gate's maxSnapshotAgeMs is set to 5 s so the snapshot becomes stale
    // after we advance the fake clock by 6 s — the gate sees an old fetchedAtMs
    // from the cache entry and blocks with stale_snapshot.
    const longTtlClient = new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 60_000);
    vi.spyOn(longTtlClient as any, "getConfig").mockResolvedValue(CONFIG);
    vi.spyOn(longTtlClient as any, "getStatus").mockResolvedValue("Active");
    vi.spyOn(longTtlClient as any, "getCurrentRoundResult").mockResolvedValue({
      ok: true, value: { ...ROUND_0, contributionsReceived: 0 },
    });

    await longTtlClient.getFullState(); // cache populated at fake t=0

    // Advance 6 s — cache is still valid (60 s TTL) but the gate sees a 6 s
    // old snapshot which exceeds the custom maxSnapshotAgeMs of 5 s.
    vi.advanceTimersByTime(6_000);

    await expect(
      longTtlClient.gateActionOrThrow("contribute", {
        memberAddress: BOB,
        hasContributedCurrentRound: false,
        maxSnapshotAgeMs: 5_000,
      }),
    ).rejects.toMatchObject({
      name: "GateError",
      reason: "stale_snapshot",
    });
  });

  it("gateAction returns a GateBlocked result (non-throwing variant) for wrong state", async () => {
    const client = makeClient("Completed", null);
    await client.getFullState();

    const result = await client.gateAction("payout");
    expect(isGateBlocked(result)).toBe(true);
    if (!result.allowed) expect(result.reason).toBe("wrong_status");
  });

  it("gateAction returns GateAllowed for close on a Completed circle", async () => {
    const client = makeClient("Completed", null);
    await client.getFullState();

    const result = await client.gateAction("close", { memberAddress: ALICE });
    expect(isGateAllowed(result)).toBe(true);
  });

  it("GateError carries the reason and a human-readable message", async () => {
    const client = makeClient("Active", ROUND_0);
    await client.getFullState();

    let caught: GateError | null = null;
    try {
      // not_a_member — outsider is not in CONFIG.members
      const outsider = "GZZZ0000000000000000000000000000000000000000000000000000";
      await client.gateActionOrThrow("contribute", { memberAddress: outsider });
    } catch (err) {
      caught = err as GateError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.name).toBe("GateError");
    expect(caught?.reason).toBe("not_a_member");
    expect(typeof caught?.message).toBe("string");
    expect(caught!.message.length).toBeGreaterThan(0);
  });
});

// ─── Scenario 6: Cache invalidation restores correct eligibility ──────────────

describe("Scenario 6: Cache invalidation resets eligibility after round progression", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("invalidateCache causes the next gateAction to re-evaluate with fresh state", async () => {
    const client = new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 60_000 /* long TTL */);

    // First fetch: circle is Active on round 0
    const getStatusSpy = vi.spyOn(client as any, "getStatus")
      .mockResolvedValueOnce("Active")
      .mockResolvedValueOnce("Completed"); // second fetch: circle completed

    vi.spyOn(client as any, "getConfig").mockResolvedValue(CONFIG);
    vi.spyOn(client as any, "getCurrentRoundResult")
      .mockResolvedValueOnce({ ok: true, value: ROUND_0 })
      .mockResolvedValueOnce({ ok: false, error: "no active round" });

    await client.getFullState(); // cache: Active, round 0

    // Invalidate — simulates receiving an external event (payout, indexer update)
    client.invalidateCache();

    // After invalidation gateAction re-fetches: circle is now Completed
    const result = await client.gateAction("payout");

    expect(isGateBlocked(result)).toBe(true);
    if (!result.allowed) expect(result.reason).toBe("wrong_status");
    expect(getStatusSpy).toHaveBeenCalledTimes(2); // re-fetched after invalidation
  });
});

// ─── Scenario 7: Deadline-based blocking with live ledger data ────────────────

describe("Scenario 7: Deadline boundary — contribute vs mark_default window", () => {
  const NOW_MS = 8_000_000;

  it("contribute is allowed when latestLedger < deadlineLedger", () => {
    const snap = buildSnapshot(
      "Active",
      { ...ROUND_0, deadlineLedger: 20_000n },
      CONFIG,
      19_999, // latest ledger is before deadline
      NOW_MS - 2_000,
    );
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      maxSnapshotAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
      nowMs: NOW_MS,
    });
    expect(isGateAllowed(r)).toBe(true);
  });

  it("contribute is blocked when latestLedger > deadlineLedger", () => {
    const snap = buildSnapshot(
      "Active",
      { ...ROUND_0, deadlineLedger: 20_000n },
      CONFIG,
      20_001, // one past deadline
      NOW_MS - 2_000,
    );
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      maxSnapshotAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
      nowMs: NOW_MS,
    });
    expect(isGateBlocked(r)).toBe(true);
    if (!r.allowed) expect(r.reason).toBe("deadline_passed");
  });

  it("contribute at exactly the deadline ledger is still allowed (inclusive boundary)", () => {
    const snap = buildSnapshot(
      "Active",
      { ...ROUND_0, deadlineLedger: 20_000n },
      CONFIG,
      20_000, // exactly at deadline
      NOW_MS - 2_000,
    );
    const r = computeActionEligibility("contribute", snap, {
      memberAddress: BOB,
      hasContributedCurrentRound: false,
      maxSnapshotAgeMs: DEFAULT_MAX_SNAPSHOT_AGE_MS,
      nowMs: NOW_MS,
    });
    expect(isGateAllowed(r)).toBe(true);
  });
});
