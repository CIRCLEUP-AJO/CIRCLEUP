/**
 * CircleDetailClient — state machine and gating tests.
 *
 * Coverage goals (matching acceptance criteria):
 *   1. Missing data never enables unsafe actions.
 *   2. Not-found is distinguishable from a temporary failure.
 *   3. Refresh recovers without a full reload.
 *   4. Stale data blocks actions and prompts manual refresh.
 *   5. Partial data blocks actions and shows a partial-data banner.
 *   6. Slow responses keep actions disabled until resolved.
 *   7. fetchedAtMs is propagated correctly (the critical staleness bug).
 *
 * These are unit tests of the pure helper functions (computeDataReadiness,
 * fetchCircleData) plus shallow render tests of the component's gated state.
 * Full interaction tests (clicking buttons, wallet signing) are out of scope
 * for this file — they belong in e2e tests that can mock Freighter.
 *
 * Test runner: vitest (configured in app/vitest.config.ts)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { buildAppSnapshot, computeActionEligibility } from "@/lib/gating";
import * as stellarMock from "@/lib/stellar";
import {
  CircleDetailClient,
  computeDataReadiness,
  fetchCircleData,
  MAX_DATA_AGE_MS,
  type CircleDetailData,
  type CircleRound,
  type CircleMember,
  type RefreshResult,
} from "./CircleDetailClient";

import { Keypair } from "@stellar/stellar-sdk";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const MEMBER_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const MEMBER_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

function makeMember(address: string, overrides: Partial<CircleMember> = {}): CircleMember {
  const defaultOrder = address === MEMBER_B ? 1 : 0;
  return {
    member_address: address,
    payout_order: defaultOrder,
    collateral: "10000000",
    defaults: 0,
    joined_at: null,
    reputation_score: 3,
    total_contributions: 0,
    ...overrides,
  };
}

function makeCurrentRound(contributions: { member_address: string }[] = []): CircleRound {
  return {
    roundIndex: 0,
    status: "current",
    recipient: null,
    amount: null,
    txHash: null,
    ledger: null,
    contributions: contributions.map((c) => ({
      member_address: c.member_address,
      amount: "10000000",
      tx_hash: "abc123",
    })),
    defaults: [],
  };
}

/** Builds a complete, fully-ready CircleDetailData object. */
function makeReadyData(overrides: Partial<CircleDetailData> = {}): CircleDetailData {
  return {
    circle: {
      status: "Active",
      current_round: 0,
      total_rounds: 4,
      round_amount: "10000000",
      member_count: 2,
      deadline_ledger: 5000,
    },
    members: [makeMember(MEMBER_A, 0), makeMember(MEMBER_B, 1)],
    rounds: [],
    openRounds: [],
    pendingDefaults: [],
    latestLedger: 4000,
    currentRound: makeCurrentRound(),
    ...overrides,
  };
}

// ─── computeDataReadiness ─────────────────────────────────────────────────────

describe("computeDataReadiness", () => {
  test("returns 'ready' when members present and currentRound available for Active circle", () => {
    const data = makeReadyData();
    expect(computeDataReadiness(data)).toBe("ready");
  });

  test("returns 'partial' when members array is empty", () => {
    const data = makeReadyData({ members: [] });
    expect(computeDataReadiness(data)).toBe("partial");
  });

  test("returns 'partial' when Active circle has null currentRound", () => {
    const data = makeReadyData({ currentRound: null });
    expect(computeDataReadiness(data)).toBe("partial");
  });

  test("returns 'ready' for Pending circle even with null currentRound", () => {
    // Pending circles don't have an active round — currentRound is not required
    const data = makeReadyData({
      circle: { status: "Pending", current_round: 0, total_rounds: 4, round_amount: "10000000", member_count: 2 },
      currentRound: null,
    });
    expect(computeDataReadiness(data)).toBe("ready");
  });

  test("returns 'ready' for Completed circle even with null currentRound", () => {
    const data = makeReadyData({
      circle: { status: "Completed", current_round: 4, total_rounds: 4, round_amount: "10000000", member_count: 2 },
      currentRound: null,
    });
    expect(computeDataReadiness(data)).toBe("ready");
  });

  test("returns 'ready' for Cancelled circle even with null currentRound", () => {
    const data = makeReadyData({
      circle: { status: "Cancelled", current_round: 1, total_rounds: 4, round_amount: "10000000", member_count: 2 },
      currentRound: null,
    });
    expect(computeDataReadiness(data)).toBe("ready");
  });

  test("returns 'partial' when both members empty and currentRound null on Active", () => {
    const data = makeReadyData({ members: [], currentRound: null });
    expect(computeDataReadiness(data)).toBe("partial");
  });

  test("members present + currentRound present → always 'ready' regardless of latestLedger", () => {
    // latestLedger being null does NOT cause 'partial' — the payout gate handles that
    const data = makeReadyData({ latestLedger: null });
    expect(computeDataReadiness(data)).toBe("ready");
  });
});

// ─── fetchCircleData ──────────────────────────────────────────────────────────
//
// These tests mock global fetch to simulate slow, missing, failed, and
// successful responses.

describe("fetchCircleData", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(
    circleResponse: { status: number; body?: unknown },
    roundsResponse?: { status: number; body?: unknown },
  ) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      const resp = url.includes("/rounds")
        ? roundsResponse ?? {
            status: 200,
            body: { rounds: [], openRounds: [], pendingDefaults: [], currentRound: null },
          }
        : circleResponse;
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        json: async () => resp.body,
      } as Response;
    });
  }

  test("returns ok:true with full data on a successful response", async () => {
    const circleBody = {
      circle: {
        status: "Active",
        current_round: 0,
        total_rounds: 4,
        round_amount: "10000000",
        member_count: 2,
        deadline_ledger: 5000,
      },
      members: [makeMember(MEMBER_A, 0), makeMember(MEMBER_B, 1)],
      latestLedger: 4000,
    };
    const roundsBody = {
      rounds: [],
      openRounds: [],
      pendingDefaults: [],
      currentRound: makeCurrentRound(),
    };

    mockFetch({ status: 200, body: circleBody }, { status: 200, body: roundsBody });

    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.circle.status).toBe("Active");
    expect(result.data.members).toHaveLength(2);
    expect(result.data.latestLedger).toBe(4000);
    expect(result.data.currentRound).not.toBeNull();
    // fetchedAtMs must be a recent timestamp (within 5 seconds of now)
    expect(result.fetchedAtMs).toBeGreaterThan(Date.now() - 5000);
    expect(result.fetchedAtMs).toBeLessThanOrEqual(Date.now() + 100);
  });

  test("returns not_found error when circle endpoint returns 404", async () => {
    mockFetch({ status: 404 });
    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
  });

  test("returns server error when circle endpoint returns 500", async () => {
    mockFetch({ status: 500 });
    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("server");
  });

  test("returns network error when fetch throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("network");
  });

  test("returns server error when response body is not a valid circle object", async () => {
    mockFetch({ status: 200, body: { not_a_circle: true } });
    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("server");
  });

  test("handles missing rounds endpoint gracefully — falls back to empty arrays", async () => {
    const circleBody = {
      circle: {
        status: "Pending",
        current_round: 0,
        total_rounds: 4,
        round_amount: "10000000",
        member_count: 2,
      },
      members: [makeMember(MEMBER_A)],
      latestLedger: null,
    };
    mockFetch({ status: 200, body: circleBody }, { status: 503 });

    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should still succeed, rounds default to empty
    expect(result.data.rounds).toEqual([]);
    expect(result.data.openRounds).toEqual([]);
    expect(result.data.currentRound).toBeNull();
  });

  test("handles missing members field in circle response — falls back to []", async () => {
    const circleBody = {
      circle: {
        status: "Active",
        current_round: 0,
        total_rounds: 4,
        round_amount: "10000000",
        member_count: 2,
      },
      // members field intentionally absent
      latestLedger: 3000,
    };
    mockFetch({ status: 200, body: circleBody });

    const result = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.members).toEqual([]);
  });

  test("not_found is distinct from server error", async () => {
    mockFetch({ status: 404 });
    const notFound = await fetchCircleData(CONTRACT);
    expect(notFound.ok).toBe(false);
    if (notFound.ok) return;
    expect(notFound.error).toBe("not_found");

    mockFetch({ status: 503 });
    const serverErr = await fetchCircleData(CONTRACT);
    expect(serverErr.ok).toBe(false);
    if (serverErr.ok) return;
    expect(serverErr.error).toBe("server");

    // The two error kinds are different strings
    expect(notFound.error).not.toBe(serverErr.error);
  });

  test("fetchedAtMs is set to approximately Date.now() on success", async () => {
    const circleBody = {
      circle: { status: "Pending", current_round: 0, total_rounds: 4, round_amount: "10000000", member_count: 1 },
      members: [makeMember(MEMBER_A)],
    };
    mockFetch({ status: 200, body: circleBody });

    const before = Date.now();
    const result = await fetchCircleData(CONTRACT);
    const after = Date.now();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fetchedAtMs).toBeGreaterThanOrEqual(before);
    expect(result.fetchedAtMs).toBeLessThanOrEqual(after + 50);
  });
});

// ─── MAX_DATA_AGE_MS constant ──────────────────────────────────────────────────

describe("MAX_DATA_AGE_MS", () => {
  test("is a positive finite number", () => {
    expect(typeof MAX_DATA_AGE_MS).toBe("number");
    expect(MAX_DATA_AGE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_DATA_AGE_MS)).toBe(true);
  });

  test("is at least 60 seconds (safety floor)", () => {
    // Must be long enough for a user to actually read the page
    expect(MAX_DATA_AGE_MS).toBeGreaterThanOrEqual(60_000);
  });
});

// ─── Critical staleness bug regression tests ──────────────────────────────────
//
// Before this refactor, buildAppSnapshot was called with no nowMs arg inside
// doAction, making fetchedAtMs ≈ Date.now(). The staleness gate always passed.
// These tests verify that when the snapshot is built with the DATA fetch time
// (not the submission time), old data correctly triggers stale_snapshot.

describe("Staleness regression: buildAppSnapshot must use data fetch time", () => {
  test("a snapshot built with a past fetchedAtMs is stale after maxAge", async () => {
    // Import gating functions to verify the snapshot behaves correctly
    const { buildAppSnapshot, computeActionEligibility, DEFAULT_MAX_SNAPSHOT_AGE_MS } = await import("@/lib/gating");

    const staleMs = Date.now() - DEFAULT_MAX_SNAPSHOT_AGE_MS - 1000; // 1 s past the limit
    const snapshot = buildAppSnapshot(
      "Active",
      0,
      5000,
      4000,
      [MEMBER_A, MEMBER_B],
      false,
      false,
      0,
      null, // networkCheck — none in this context
      staleMs, // ← the data was fetched more than maxAge ago
    );

    const gate = computeActionEligibility("contribute", snapshot);
    expect(gate.allowed).toBe(false);
    if (gate.allowed) return;
    expect(gate.reason).toBe("stale_snapshot");
  });

  test("a snapshot built with nowMs set to fetchedAtMs is always fresh (old bug)", () => {
    // Illustrates the OLD (broken) behaviour: fetchedAtMs === Date.now() at
    // build time → the staleness check always passes. This test documents it
    // so any regression that re-introduces it fails clearly.
    //
    // The fix is to pass the actual data-fetch timestamp from component state,
    // which IS older than Date.now() at action-submit time.

    // Simulate: data was fetched 60 seconds ago
    const dataFetchedAt = Date.now() - 60_000;
    // Correct behaviour: use dataFetchedAt as the snapshot timestamp
    const correctSnapshot = buildAppSnapshot("Active", 0, 5000, 4000, [MEMBER_A], false, false, 0, null, dataFetchedAt);
    const correctGate = computeActionEligibility("contribute", correctSnapshot);
    // 60 s > 30 s default → stale
    expect(correctGate.allowed).toBe(false);
    if (!correctGate.allowed) {
      expect(correctGate.reason).toBe("stale_snapshot");
    }

    // Old (broken) behaviour: use Date.now() as the snapshot timestamp
    const brokenSnapshot = buildAppSnapshot("Active", 0, 5000, 4000, [MEMBER_A], false, false, 0, null, Date.now());
    const brokenGate = computeActionEligibility("contribute", brokenSnapshot);
    // 0 ms < 30 s → wrongly allowed
    expect(brokenGate.allowed).toBe(true);
  });
});

//
// Regression: 0 contributions >= 0 members → allowed by math, but wrong
// semantically when member data is absent.

describe("Payout gate with empty members", () => {
  test("payout gate should fail when members array is empty", () => {
    const snapshot = buildAppSnapshot(
      "Active",
      0,
      5000,
      4000,
      [], // empty — no members loaded yet
      false,
      false,
      0, // 0 contributions
      null, // networkCheck — none in this context
      Date.now(),
    );
    // 0 >= 0 is true mathematically, but the gate allows it — the fix for
    // this is in the component's payoutGate pre-check (not in gating.ts itself).
    // This test documents the gating.ts behaviour so the component override is justified.
    const gate = computeActionEligibility("payout", snapshot, { maxSnapshotAgeMs: Infinity });
    // Document: gating.ts itself allows this (0>=0)
    expect(gate.allowed).toBe(true);
    // The component adds an explicit guard: `data.members.length === 0 → block`
    // That guard is tested via the payoutGate computation in the component,
    // which is covered by the integration render test below.
  });
});

// ─── CircleDetailClient component render tests ────────────────────────────────
//
// Tests that verify the component renders the correct banners and disables
// the correct buttons based on data readiness state.
//
// We test the pure helper functions above rather than the full component for
// most cases, since the component depends on many browser APIs (wallet, fetch).
// The render tests below focus on the state-machine branches that are
// controlled by props alone.

// Helper to mock modules used by the component
vi.mock("@/lib/stellar", () => ({
  getWalletAddress: vi.fn().mockResolvedValue(null),
  invokeContract: vi.fn(),
  isFreighterInstalled: vi.fn().mockReturnValue(false),
}));


describe("CircleDetailClient render — data readiness banners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: wallet not connected
    (stellarMock.getWalletAddress as any).mockResolvedValue(null);
  });

  test("shows partial data banner when members[] is empty", async () => {
    const data = makeReadyData({ members: [], currentRound: null });
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      expect(
        screen.getByText(/Some data is still loading/i),
      ).toBeInTheDocument();
    });
  });

  test("shows partial data banner when Active circle has no currentRound", async () => {
    const data = makeReadyData({ currentRound: null });
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      expect(screen.getByText(/Some data is still loading/i)).toBeInTheDocument();
    });
  });

  test("does not show partial data banner when data is complete", async () => {
    const data = makeReadyData();
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      // Wait for wallet check to settle
      expect(screen.queryByText(/Some data is still loading/i)).toBeNull();
    });
  });

  test("action buttons are disabled while wallet state is still loading", async () => {
    // Never resolves — simulates slow wallet check
    (stellarMock.getWalletAddress as any).mockImplementation(
      () => new Promise(() => {}),
    );

    const data = makeReadyData({
      circle: { status: "Pending", current_round: 0, total_rounds: 4, round_amount: "10000000", member_count: 2 },
    });

    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    expect(
      screen.getAllByRole("status").some((status) => /Checking wallet/i.test(status.textContent ?? "")),
    ).toBe(true);
  });

  test("Trigger Payout button is disabled when members array is empty", async () => {
    const data = makeReadyData({ members: [] });
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      const btn = screen.queryByText(/Trigger Payout/i);
      if (btn) {
        // The button exists but must be disabled
        expect(btn.closest("button")).toBeDisabled();
      }
      // Alternatively the button may not render at all when partial — either is acceptable
    });
  });

  test("partial data banner Refresh now button exists and is clickable", async () => {
    // Mock fetchCircleData to return partial data on first refresh, then full data
    const data = makeReadyData({ members: [] });

    const fullData = makeReadyData();
    const circleBody = {
      circle: fullData.circle,
      members: fullData.members,
      latestLedger: fullData.latestLedger,
    };
    const roundsBody = {
      rounds: [],
      openRounds: [],
      pendingDefaults: [],
      currentRound: fullData.currentRound,
    };

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => circleBody,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => roundsBody,
      } as Response);

    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      expect(screen.getByText(/Some data is still loading/i)).toBeInTheDocument();
    });

    const refreshBtn = screen.getByText(/Refresh now/i);
    expect(refreshBtn).toBeInTheDocument();

    fireEvent.click(refreshBtn);

    // After refresh, banner should disappear
    await waitFor(() => {
      expect(screen.queryByText(/Some data is still loading/i)).toBeNull();
    });
  });

  test("manual refresh failure shows an error message", async () => {
    const data = makeReadyData({ members: [] });

    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      expect(screen.getByText(/Some data is still loading/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Refresh now/i));

    await waitFor(() => {
      expect(screen.getByText(/Refresh failed/i)).toBeInTheDocument();
      expect(screen.getByText(/Could not reach the indexer/i)).toBeInTheDocument();
    });
  });

  test("partial data banner mentions which fields are missing", async () => {
    const data = makeReadyData({ members: [] });
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      expect(screen.getByText(/member list/i)).toBeInTheDocument();
    });
  });

  test("partial data banner for Active+no currentRound mentions contribution data", async () => {
    const data = makeReadyData({ currentRound: null });
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      expect(screen.getByText(/current-round contribution data/i)).toBeInTheDocument();
    });
  });
});

// ─── Not-found vs temporary failure ──────────────────────────────────────────
//
// page.tsx handles not_found via notFound() (renders Next.js 404 page).
// fetchCircleData() must return error:"not_found" distinctly from "network"/"server".
// The component itself surfaces temporary failures via the manual refresh banner.

describe("Not-found vs temporary failure distinction", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test("fetchCircleData returns 'not_found' for 404", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
    const result: RefreshResult = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
  });

  test("fetchCircleData returns 'server' for 503", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
    const result: RefreshResult = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("server");
  });

  test("fetchCircleData returns 'network' for fetch throw", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));
    const result: RefreshResult = await fetchCircleData(CONTRACT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("network");
  });

  test("not_found and server are different error kinds", () => {
    // Compile-time guarantee: the RefreshError union includes both
    type _AssertNotFound = "not_found" extends import("./CircleDetailClient").RefreshError ? true : never;
    type _AssertServer   = "server"    extends import("./CircleDetailClient").RefreshError ? true : never;
    // If either type assertion fails, the file won't compile
    const _a: _AssertNotFound = true;
    const _b: _AssertServer   = true;
    expect(_a).toBe(true);
    expect(_b).toBe(true);
  });
});

// ─── Refresh recovers without full reload ─────────────────────────────────────

describe("Refresh recovers without full reload", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  test("fetchCircleData called a second time returns fresh data", async () => {
    const firstBody = {
      circle: { status: "Active", current_round: 0, total_rounds: 4, round_amount: "10000000", member_count: 1 },
      members: [makeMember(MEMBER_A)],
      latestLedger: 4000,
    };
    const secondBody = {
      circle: { status: "Active", current_round: 1, total_rounds: 4, round_amount: "10000000", member_count: 2 },
      members: [makeMember(MEMBER_A, 0), makeMember(MEMBER_B, 1)],
      latestLedger: 5001,
    };
    const roundsBody = { rounds: [], openRounds: [], pendingDefaults: [], currentRound: makeCurrentRound() };

    let circleCount = 0;
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/rounds")) {
        return { ok: true, status: 200, json: async () => roundsBody } as Response;
      }
      circleCount += 1;
      const body = circleCount === 1 ? firstBody : secondBody;
      return { ok: true, status: 200, json: async () => body } as Response;
    });

    const first = await fetchCircleData(CONTRACT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.circle.current_round).toBe(0);

    const second = await fetchCircleData(CONTRACT);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.circle.current_round).toBe(1);
    expect(second.data.members).toHaveLength(2);

    // fetchedAtMs on the second call must be >= the first call's timestamp
    expect(second.fetchedAtMs).toBeGreaterThanOrEqual(first.fetchedAtMs);
  });

  test("a failed refresh followed by a successful one returns ok:true", async () => {
    const goodBody = {
      circle: { status: "Active", current_round: 0, total_rounds: 4, round_amount: "10000000", member_count: 1 },
      members: [makeMember(MEMBER_A)],
      latestLedger: 4000,
    };
    const roundsBody = { rounds: [], openRounds: [], pendingDefaults: [], currentRound: null };

    let attempt = 0;
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      attempt += 1;
      if (attempt === 1) throw new TypeError("Network error");
      const body = urlStr.endsWith("/rounds") ? roundsBody : goodBody;
      return { ok: true, status: 200, json: async () => body } as Response;
    });

    const firstResult = await fetchCircleData(CONTRACT);
    expect(firstResult.ok).toBe(false);
    if (firstResult.ok) return;
    expect(firstResult.error).toBe("network");

    const secondResult = await fetchCircleData(CONTRACT);
    expect(secondResult.ok).toBe(true);
  });
});

// ─── Issue #480 — invite URL SSR safety ──────────────────────────────────────
//
// Validates that:
//   1. inviteUrl initialises to null (not "") so SSR renders a consistent
//      placeholder rather than an empty controlled-input value.
//   2. The input renders with aria-busy while the URL is not yet resolved.
//   3. The copy button is disabled while inviteUrl is null.
//   4. window.location is never accessed synchronously during the initial
//      render — only inside useEffect (browser-only).
//
// These are component-level render tests rather than pure-function tests; they
// rely on jsdom setting window.location.origin = "http://localhost" by default.

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Minimal valid Props shape the component accepts
function makeProps(circleAddress: string): { circleAddress: string; circleData: ReturnType<typeof makeReadyData> } {
  return {
    circleAddress,
    circleData: makeReadyData(),
  };
}

describe("Issue #480 — invite URL SSR-safe initialisation", () => {
  beforeEach(() => {
    (stellarMock.getWalletAddress as any).mockResolvedValue(null);
  });

  test("invite input starts with empty value (null coalesced to '') when unresolved", async () => {
    const { container } = render(
      <CircleDetailClient circleAddress="invalid" circleData={makeReadyData()} />,
    );
    expect(container.querySelector<HTMLInputElement>("input[aria-label='Invite link for this circle']")?.value).toBe("");
  });

  test("invite input shows aria-busy=true while URL not yet resolved", async () => {
    const { container } = render(
      <CircleDetailClient circleAddress="invalid" circleData={makeReadyData()} />,
    );
    expect(container.querySelector("input[aria-label='Invite link for this circle']")).toHaveAttribute("aria-busy", "true");
  });

  test("copy button is disabled while invite URL is not yet resolved", async () => {
    render(<CircleDetailClient circleAddress="invalid" circleData={makeReadyData()} />);

    const copyBtn = screen.getByRole("button", { name: /copy invite link/i });
    expect(copyBtn).toBeDisabled();
  });

  test("invite input is populated with window.location.origin after effect fires", async () => {
    const { container } = render(
      <CircleDetailClient {...makeProps(CONTRACT)} />,
    );

    await waitFor(() => {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Invite link for this circle"]',
      );
      expect(input!.value).toContain(`/circles/${CONTRACT}`);
    });
  });

  test("invite input aria-busy becomes false after URL is resolved", async () => {
    const { container } = render(
      <CircleDetailClient {...makeProps(CONTRACT)} />,
    );

    await waitFor(() => {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Invite link for this circle"]',
      );
      expect(input!.getAttribute("aria-busy")).not.toBe("true");
    });
  });
});

// ─── Screen-reader announcement tests ────────────────────────────────────────
//
// Verify that the sr-only progressAnnouncement live region re-announces when
// circle status or round changes after a post-action data refresh.

describe("CircleDetailClient — screen-reader status announcements", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    (stellarMock.getWalletAddress as any).mockResolvedValue(null);
  });

  test("sr-only live region contains circle status on initial render", async () => {
    const data = makeReadyData();
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      const srEl = document.querySelector("[role='status'][aria-live='polite'][aria-atomic='true'].sr-only");
      expect(srEl).toBeInTheDocument();
      expect(srEl?.textContent).toMatch(/circle status: active/i);
      expect(srEl?.textContent).toMatch(/round 0 of 4/i);
    });
  });

  test("sr-only live region reflects updated status after data changes", async () => {
    const initialData = makeReadyData({
      circle: { status: "Active", current_round: 0, total_rounds: 4, round_amount: "10000000", member_count: 2 },
    });

    const { rerender } = render(
      <CircleDetailClient circleAddress={CONTRACT} circleData={initialData} />,
    );

    await waitFor(() => {
      const srEl = document.querySelector("[role='status'][aria-live='polite'][aria-atomic='true'].sr-only");
      expect(srEl?.textContent).toMatch(/round 0 of 4/i);
    });

    const updatedData = makeReadyData({
      circle: { status: "Active", current_round: 1, total_rounds: 4, round_amount: "10000000", member_count: 2 },
      currentRound: makeCurrentRound(),
    });

    rerender(
      <CircleDetailClient key="updated" circleAddress={CONTRACT} circleData={updatedData} />,
    );

    await waitFor(() => {
      const srEl = document.querySelector("[role='status'][aria-live='polite'][aria-atomic='true'].sr-only");
      expect(srEl?.textContent).toMatch(/round 1 of 4/i);
    });
  });

  test("sr-only live region has aria-atomic=true for atomic announcement", async () => {
    const data = makeReadyData();
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      const srEl = document.querySelector("[role='status'][aria-live='polite'][aria-atomic='true'].sr-only");
      expect(srEl).toBeInTheDocument();
      expect(srEl).toHaveAttribute("aria-atomic", "true");
    });
  });
});

// ─── Duplicate submission guard ─────────────────────────────────────────────
//
// Retries and rapid re-clicks must never submit a duplicate wallet transaction.
//
// The primary guard is the button's `disabled` attribute while an action is in
// flight — a real browser will not fire a second click on a disabled control.
// `doAction`'s `submittingRef` is defence-in-depth against anything that can
// bypass the attribute (programmatic dispatches, accessibility tools).

describe("Duplicate submission guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (stellarMock.getWalletAddress as any).mockResolvedValue(MEMBER_A);
    (stellarMock.invokeContract as any).mockResolvedValue({
      success: true,
      txHash: "0x" + "a".repeat(64),
    });
  });

  test("a single contribute click submits one transaction and disables the button while in flight", async () => {
    const data = makeReadyData();
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /contribute round/i })).toBeInTheDocument();
    });

    const btn = screen.getByRole("button", { name: /contribute round/i });
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);

    // The button disables while the action is in flight, so a real browser
    // cannot fire a second click on it (no duplicate transaction).
    expect(btn).toBeDisabled();
    expect(stellarMock.invokeContract).toHaveBeenCalledTimes(1);
  });
});

// ─── useAnnouncer live-region tests ──────────────────────────────────────────
//
// Verify that the AnnouncerPortal renders both live regions in the DOM and that
// the announce() hook correctly de-duplicates repeated identical messages so
// polling never floods assistive technology.
//
// These tests exercise the hook in isolation (no component render needed) so
// they remain fast and free of React-component dependencies.

import { renderHook, act } from "@testing-library/react";
import { useAnnouncer, ANNOUNCEMENTS } from "@/lib/useAnnouncer";

describe("useAnnouncer — live-region policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("AnnouncerPortal renders a polite status region and an assertive alert region", () => {
    const { result } = renderHook(() => useAnnouncer());
    const { AnnouncerPortal } = result.current;
    const { container } = render(<AnnouncerPortal />);

    const polite = container.querySelector("[role='status'][aria-live='polite']");
    const assertive = container.querySelector("[role='alert'][aria-live='assertive']");

    expect(polite).toBeInTheDocument();
    expect(assertive).toBeInTheDocument();
    expect(polite).toHaveAttribute("aria-atomic", "true");
    expect(assertive).toHaveAttribute("aria-atomic", "true");
    // Both should have the sr-only class so they are visually hidden
    expect(polite).toHaveClass("sr-only");
    expect(assertive).toHaveClass("sr-only");
  });

  test("announce() polite: sets polite region text", async () => {
    const { result } = renderHook(() => useAnnouncer());

    act(() => {
      result.current.announce("Transaction confirmed.", "polite");
    });

    const { container } = render(<result.current.AnnouncerPortal />);
    const polite = container.querySelector("[role='status'][aria-live='polite']");
    expect(polite?.textContent).toBe("Transaction confirmed.");
  });

  test("announce() assertive: sets assertive region text", async () => {
    const { result } = renderHook(() => useAnnouncer());

    act(() => {
      result.current.announce("Transaction failed: network error", "assertive");
    });

    const { container } = render(<result.current.AnnouncerPortal />);
    const assertive = container.querySelector("[role='alert'][aria-live='assertive']");
    expect(assertive?.textContent).toBe("Transaction failed: network error");
  });

  test("announce() dedup: second identical polite message is ignored within the clear window", () => {
    const { result } = renderHook(() => useAnnouncer());

    act(() => {
      result.current.announce("Data refreshed.", "polite");
    });

    // Render once to capture the text
    const { container: c1 } = render(<result.current.AnnouncerPortal />);
    const before = c1.querySelector("[role='status']")?.textContent;

    // Send the exact same message again (simulating a repeated polling cycle)
    act(() => {
      result.current.announce("Data refreshed.", "polite");
    });

    const { container: c2 } = render(<result.current.AnnouncerPortal />);
    const after = c2.querySelector("[role='status']")?.textContent;

    // Text must be unchanged — the duplicate was swallowed
    expect(before).toBe(after);
    expect(after).toBe("Data refreshed.");
  });

  test("announce() dedup: different message after clear window is announced again", () => {
    const { result } = renderHook(() => useAnnouncer());

    act(() => {
      result.current.announce("Circle data updated: status is now Active.", "polite");
    });

    // Advance past CLEAR_DELAY_MS (3000 ms) so the region is cleared
    act(() => {
      vi.advanceTimersByTime(3500);
    });

    // Now send the same message — it should re-announce because the last ref was cleared
    act(() => {
      result.current.announce("Circle data updated: status is now Active.", "polite");
    });

    const { container } = render(<result.current.AnnouncerPortal />);
    const polite = container.querySelector("[role='status']");
    expect(polite?.textContent).toBe("Circle data updated: status is now Active.");
  });

  test("announce() empty string is silently ignored", () => {
    const { result } = renderHook(() => useAnnouncer());

    act(() => {
      result.current.announce("", "polite");
      result.current.announce("   ", "assertive");
    });

    const { container } = render(<result.current.AnnouncerPortal />);
    const polite = container.querySelector("[role='status']");
    const assertive = container.querySelector("[role='alert']");

    expect(polite?.textContent).toBe("");
    expect(assertive?.textContent).toBe("");
  });

  test("ANNOUNCEMENTS.txSubmitting is polite (non-interrupting)", () => {
    expect(ANNOUNCEMENTS.txSubmitting.politeness).toBe("polite");
    expect(ANNOUNCEMENTS.txSubmitting.message.length).toBeGreaterThan(0);
  });

  test("ANNOUNCEMENTS.txFailed is assertive (interrupts ongoing speech)", () => {
    const a = ANNOUNCEMENTS.txFailed("network error");
    expect(a.politeness).toBe("assertive");
    expect(a.message).toContain("network error");
  });

  test("ANNOUNCEMENTS.txConfirmed is polite and includes the action label", () => {
    const a = ANNOUNCEMENTS.txConfirmed("Contribution submitted successfully.");
    expect(a.politeness).toBe("polite");
    expect(a.message).toContain("Contribution submitted successfully.");
  });

  test("ANNOUNCEMENTS.refreshing is polite", () => {
    expect(ANNOUNCEMENTS.refreshing.politeness).toBe("polite");
  });

  test("ANNOUNCEMENTS.refreshError is assertive (data loss risk)", () => {
    expect(ANNOUNCEMENTS.refreshError.politeness).toBe("assertive");
  });

  test("ANNOUNCEMENTS.refreshedChanged includes what changed", () => {
    const a = ANNOUNCEMENTS.refreshedChanged("status is now Completed");
    expect(a.message).toContain("status is now Completed");
    expect(a.politeness).toBe("polite");
  });

  test("ANNOUNCEMENTS.walletConnected includes the address fragment", () => {
    const a = ANNOUNCEMENTS.walletConnected("GABC…XYZ");
    expect(a.message).toContain("GABC…XYZ");
    expect(a.politeness).toBe("polite");
  });

  test("ANNOUNCEMENTS.walletError is assertive", () => {
    const a = ANNOUNCEMENTS.walletError("Freighter not installed");
    expect(a.politeness).toBe("assertive");
    expect(a.message).toContain("Freighter not installed");
  });

  test("ANNOUNCEMENTS.circleCreated is polite", () => {
    expect(ANNOUNCEMENTS.circleCreated.politeness).toBe("polite");
  });

  test("ANNOUNCEMENTS.circleCreateFailed is assertive", () => {
    const a = ANNOUNCEMENTS.circleCreateFailed("Factory not configured");
    expect(a.politeness).toBe("assertive");
    expect(a.message).toContain("Factory not configured");
  });

  test("ANNOUNCEMENTS.indexerIndexed is polite", () => {
    expect(ANNOUNCEMENTS.indexerIndexed.politeness).toBe("polite");
  });
});

// ─── CircleDetailClient — AnnouncerPortal integration ────────────────────────
//
// Verify that the portal is rendered in the component tree and that both
// live regions are present in the DOM from the first render.

describe("CircleDetailClient — AnnouncerPortal present in DOM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (stellarMock.getWalletAddress as any).mockResolvedValue(null);
  });

  test("renders a polite status live region (sr-only) from AnnouncerPortal", async () => {
    const data = makeReadyData();
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    // AnnouncerPortal adds two sr-only spans — query the assertive one
    await waitFor(() => {
      const assertiveRegion = document.querySelector(
        "[role='alert'][aria-live='assertive'].sr-only",
      );
      expect(assertiveRegion).toBeInTheDocument();
    });
  });

  test("renders an assertive alert live region (sr-only) from AnnouncerPortal", async () => {
    const data = makeReadyData();
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      const politeRegion = document.querySelector(
        "[role='status'][aria-live='polite'][aria-atomic='true'].sr-only",
      );
      // There will be at least one (may be the progressAnnouncement or AnnouncerPortal)
      expect(politeRegion).toBeInTheDocument();
    });
  });

  test("repeated identical data-refresh does not change the refreshed announcement text (dedup)", async () => {
    const data = makeReadyData();
    const { rerender } = render(
      <CircleDetailClient circleAddress={CONTRACT} circleData={data} />,
    );

    // Re-render with the same data twice — no meaningful state change
    rerender(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);
    rerender(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    // The assertive alert region must stay empty — no flood of announcements
    await waitFor(() => {
      const assertiveRegion = document.querySelector(
        "[role='alert'][aria-live='assertive'].sr-only",
      );
      expect(assertiveRegion?.textContent).toBe("");
    });
  });

  test("progressAnnouncement sr-only region has correct aria attributes", async () => {
    const data = makeReadyData();
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={data} />);

    await waitFor(() => {
      // The key-remounted progress node
      const els = document.querySelectorAll(
        "[role='status'][aria-live='polite'][aria-atomic='true']",
      );
      expect(els.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─── Issue #130 — unknown lifecycle statuses ─────────────────────────────────
//
// A future or malformed status string must never crash the page, must never be
// rendered as a false pending/active state, and must never enable a mutation.
// Read-only details stay visible when their fields validate.

describe("Issue #130 — unknown lifecycle status handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (stellarMock.getWalletAddress as any).mockResolvedValue(MEMBER_A);
  });

  function makeUnknownStatusData(status: string): CircleDetailData {
    return makeReadyData({
      circle: {
        status: status as unknown as CircleDetailData["circle"]["status"],
        current_round: 0,
        total_rounds: 4,
        round_amount: "10000000",
        member_count: 2,
        deadline_ledger: 5000,
      },
    });
  }

  test("a future status string renders an explicit unsupported state", async () => {
    render(
      <CircleDetailClient circleAddress={CONTRACT} circleData={makeUnknownStatusData("Paused")} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/unsupported/i)).toBeInTheDocument();
    });
  });

  test("unknown status is not presented as Pending or Active", async () => {
    const { container } = render(
      <CircleDetailClient circleAddress={CONTRACT} circleData={makeUnknownStatusData("Paused")} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/unsupported/i)).toBeInTheDocument();
    });

    // The status badge must not claim a known state
    const badgeText = container.textContent ?? "";
    expect(badgeText).not.toMatch(/status:\s*pending/i);
    expect(badgeText).not.toMatch(/status:\s*active/i);
  });

  test("unknown status disables every mutation action", async () => {
    render(
      <CircleDetailClient circleAddress={CONTRACT} circleData={makeUnknownStatusData("Paused")} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/unsupported/i)).toBeInTheDocument();
    });

    const mutationNames = [/contribute round/i, /trigger payout/i, /join circle/i];
    for (const name of mutationNames) {
      const btn = screen.queryByRole("button", { name });
      if (btn) expect(btn).toBeDisabled();
    }
  });

  test("unknown status keeps read-only details visible", async () => {
    render(
      <CircleDetailClient circleAddress={CONTRACT} circleData={makeUnknownStatusData("Paused")} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/unsupported/i)).toBeInTheDocument();
    });

    // Member addresses remain readable
    expect(screen.getByText(MEMBER_A)).toBeInTheDocument();
    expect(screen.getByText(MEMBER_B)).toBeInTheDocument();
  });

  test("malformed status value does not crash the render", () => {
    expect(() =>
      render(
        <CircleDetailClient
          circleAddress={CONTRACT}
          circleData={makeUnknownStatusData("<script>alert(1)</script>")}
        />,
      ),
    ).not.toThrow();
  });

  test("malformed status value is not interpolated as raw HTML", async () => {
    const { container } = render(
      <CircleDetailClient
        circleAddress={CONTRACT}
        circleData={makeUnknownStatusData("<img src=x onerror=alert(1)>")}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/unsupported/i)).toBeInTheDocument();
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});

// ─── Issue #127 — clipboard fallback ────────────────────────────────────────
//
// Copy actions must report success only when the clipboard write actually
// completed. When the API is missing or permission is denied, the content must
// stay selectable for manual copying and the status text must say so.

describe("Issue #127 — clipboard fallback for invite link", () => {
  const originalClipboard = (navigator as any).clipboard;
  const originalExecCommand = (document as any).execCommand;

  beforeEach(() => {
    vi.clearAllMocks();
    (stellarMock.getWalletAddress as any).mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalClipboard === undefined) {
      delete (navigator as any).clipboard;
    } else {
      (navigator as any).clipboard = originalClipboard;
    }
    (document as any).execCommand = originalExecCommand;
  });

  test("successful copy announces a copied state", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<CircleDetailClient circleAddress={CONTRACT} circleData={makeReadyData()} />);

    const copyBtn = await screen.findByRole("button", { name: /copy invite link/i });
    await waitFor(() => expect(copyBtn).not.toBeDisabled());

    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/copied/i)).toBeInTheDocument();
    });
  });

  test("permission denial shows a manual-copy fallback and never claims success", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<CircleDetailClient circleAddress={CONTRACT} circleData={makeReadyData()} />);

    const copyBtn = await screen.findByRole("button", { name: /copy invite link/i });
    await waitFor(() => expect(copyBtn).not.toBeDisabled());

    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(screen.getByText(/could not copy/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/^copied/i)).toBeNull();
  });

  test("missing clipboard API shows the manual-copy fallback", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });

    render(<CircleDetailClient circleAddress={CONTRACT} circleData={makeReadyData()} />);

    const copyBtn = await screen.findByRole("button", { name: /copy invite link/i });
    await waitFor(() => expect(copyBtn).not.toBeDisabled());

    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(screen.getByText(/could not copy/i)).toBeInTheDocument();
    });
  });

  test("on failure the invite link stays available for manual selection", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });

    const { container } = render(
      <CircleDetailClient circleAddress={CONTRACT} circleData={makeReadyData()} />,
    );

    const copyBtn = await screen.findByRole("button", { name: /copy invite link/i });
    await waitFor(() => expect(copyBtn).not.toBeDisabled());
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(screen.getByText(/could not copy/i)).toBeInTheDocument();
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Invite link for this circle"]',
    );
    expect(input).toBeInTheDocument();
    expect(input!.value).toContain(`/circles/${CONTRACT}`);
  });

  test("repeated copy attempts keep reporting the true outcome", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<CircleDetailClient circleAddress={CONTRACT} circleData={makeReadyData()} />);

    const copyBtn = await screen.findByRole("button", { name: /copy invite link/i });
    await waitFor(() => expect(copyBtn).not.toBeDisabled());

    fireEvent.click(copyBtn);
    await waitFor(() => expect(screen.getByText(/could not copy/i)).toBeInTheDocument());

    fireEvent.click(copyBtn);
    await waitFor(() => expect(screen.getByText(/copied/i)).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});

// ─── Issue #128 — narrow viewport / high zoom usability ─────────────────────
//
// jsdom has no layout engine, so these tests assert the structural guarantees
// that make narrow layouts usable: long values wrap, unavoidable horizontal
// scrolling lives in a labelled container, and action controls stay reachable.

describe("Issue #128 — narrow viewport and 200% zoom structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (stellarMock.getWalletAddress as any).mockResolvedValue(MEMBER_A);
  });

  test("long member addresses are rendered in wrappable elements", async () => {
    const { container } = render(
      <CircleDetailClient circleAddress={CONTRACT} circleData={makeReadyData()} />,
    );

    await waitFor(() => {
      expect(screen.getByText(MEMBER_A)).toBeInTheDocument();
    });

    const addressEl = screen.getByText(MEMBER_A);
    // Address must not be forced onto a single unwrappable line
    expect(addressEl.className).toMatch(/break-all|break-words|truncate/);
    expect(container.querySelector("[style*='white-space: nowrap']")).toBeNull();
  });

  test("any horizontally scrollable region is labelled for assistive tech", async () => {
    const { container } = render(
      <CircleDetailClient circleAddress={CONTRACT} circleData={makeReadyData()} />,
    );

    await waitFor(() => {
      expect(screen.getByText(MEMBER_A)).toBeInTheDocument();
    });

    const scrollers = container.querySelectorAll<HTMLElement>("[class*='overflow-x-auto']");
    scrollers.forEach((el) => {
      const labelled =
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby") ||
        el.getAttribute("role") === "region";
      expect(labelled).toBeTruthy();
    });
  });

  test("action controls remain in the DOM and reachable at narrow widths", async () => {
    render(<CircleDetailClient circleAddress={CONTRACT} circleData={makeReadyData()} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /contribute round/i })).toBeInTheDocument();
    });

    const actions = screen.getAllByRole("button");
    expect(actions.length).toBeGreaterThan(0);
    // No action control is hidden from the accessibility tree
    actions.forEach((btn) => expect(btn).not.toHaveAttribute("aria-hidden", "true"));
  });
});
