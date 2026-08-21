/**
 * Tests for CircleClient.getFullState() caching behaviour.
 *
 * We mock the three underlying query methods (getConfig / getStatus /
 * getCurrentRound) so no RPC calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircleClient, DEFAULT_FULL_STATE_CACHE_TTL_MS } from "../client";
import type { CircleConfig, RoundState, CircleStatus } from "../types";
import {
  CIRCLE_ADDR,
  MEMBER_A_ADDR,
  MEMBER_B_ADDR,
  REPUTATION_ADDR,
  SDK_CONFIG,
  USDC_ADDR,
} from "./fixtures";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_CONFIG: CircleConfig = {
  members: [MEMBER_A_ADDR, MEMBER_B_ADDR],
  roundAmount: 100_000_000n,
  usdcToken: USDC_ADDR,
  reputationContract: REPUTATION_ADDR,
  roundDeadlineLedgers: 120_960,
};

const MOCK_STATUS: CircleStatus = "Active";

const MOCK_ROUND: RoundState = {
  roundIndex: 0,
  recipient: MEMBER_A_ADDR,
  contributionsReceived: 1,
  deadlineLedger: 1_000_000n,
  paidOut: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a CircleClient whose three read methods are replaced with spies. */
function makeClient(ttlMs?: number) {
  const client = new CircleClient(SDK_CONFIG, CIRCLE_ADDR, ttlMs);

  const getConfigSpy = vi
    .spyOn(client as any, "getConfig")
    .mockResolvedValue(MOCK_CONFIG);
  const getStatusSpy = vi
    .spyOn(client as any, "getStatus")
    .mockResolvedValue(MOCK_STATUS);
  // getFullState now calls getCurrentRoundResult (non-throwing wrapper) internally
  // for Active/Pending circles, so mock that instead of getCurrentRound.
  const getRoundSpy = vi
    .spyOn(client as any, "getCurrentRoundResult")
    .mockResolvedValue({ ok: true, value: MOCK_ROUND });

  return { client, getConfigSpy, getStatusSpy, getRoundSpy };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CircleClient.getFullState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns config, status, and currentRound in one call", async () => {
    const { client } = makeClient();
    const state = await client.getFullState();

    expect(state.config).toEqual(MOCK_CONFIG);
    expect(state.status).toBe("Active");
    expect(state.currentRound).toEqual(MOCK_ROUND);
  });

  it("calls each underlying method exactly once on the first fetch", async () => {
    const { client, getConfigSpy, getStatusSpy, getRoundSpy } = makeClient();
    await client.getFullState();

    expect(getConfigSpy).toHaveBeenCalledTimes(1);
    expect(getStatusSpy).toHaveBeenCalledTimes(1);
    expect(getRoundSpy).toHaveBeenCalledTimes(1);
  });

  it("returns cached result on second call within TTL (no extra RPC calls)", async () => {
    const { client, getConfigSpy, getStatusSpy, getRoundSpy } = makeClient(10_000);

    await client.getFullState();
    await client.getFullState(); // should hit cache

    expect(getConfigSpy).toHaveBeenCalledTimes(1);
    expect(getStatusSpy).toHaveBeenCalledTimes(1);
    expect(getRoundSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires", async () => {
    const TTL = 5_000;
    const { client, getConfigSpy } = makeClient(TTL);

    await client.getFullState();
    expect(getConfigSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TTL + 1);

    await client.getFullState();
    expect(getConfigSpy).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh: true bypasses the cache", async () => {
    const { client, getConfigSpy } = makeClient(60_000);

    await client.getFullState();
    expect(getConfigSpy).toHaveBeenCalledTimes(1);

    await client.getFullState({ forceRefresh: true });
    expect(getConfigSpy).toHaveBeenCalledTimes(2);
  });

  it("cacheTtlMs = 0 disables caching entirely", async () => {
    const { client, getConfigSpy } = makeClient(0);

    await client.getFullState();
    await client.getFullState();

    expect(getConfigSpy).toHaveBeenCalledTimes(2);
  });

  it("defaults to DEFAULT_FULL_STATE_CACHE_TTL_MS when no ttl is passed", async () => {
    // Verify the constant is a positive number so the default cache is on
    expect(DEFAULT_FULL_STATE_CACHE_TTL_MS).toBeGreaterThan(0);

    const { client, getConfigSpy } = makeClient();

    await client.getFullState();
    await client.getFullState();
    expect(getConfigSpy).toHaveBeenCalledTimes(1); // cache hit
  });
});

// ─── getCachedState ───────────────────────────────────────────────────────────

describe("CircleClient.getCachedState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null before any fetch", () => {
    const { client } = makeClient();
    expect(client.getCachedState()).toBeNull();
  });

  it("returns the state after a successful fetch", async () => {
    const { client } = makeClient();
    await client.getFullState();

    const cached = client.getCachedState();
    expect(cached).not.toBeNull();
    expect(cached!.status).toBe("Active");
  });

  it("returns null after the TTL expires", async () => {
    const TTL = 3_000;
    const { client } = makeClient(TTL);

    await client.getFullState();
    expect(client.getCachedState()).not.toBeNull();

    vi.advanceTimersByTime(TTL + 1);
    expect(client.getCachedState()).toBeNull();
  });

  it("returns null after invalidateCache is called", async () => {
    const { client } = makeClient();
    await client.getFullState();

    client.invalidateCache();
    expect(client.getCachedState()).toBeNull();
  });
});

// ─── invalidateCache ──────────────────────────────────────────────────────────

describe("CircleClient.invalidateCache", () => {
  it("causes next getFullState call to re-fetch", async () => {
    const { client, getConfigSpy } = makeClient(60_000);

    await client.getFullState();
    expect(getConfigSpy).toHaveBeenCalledTimes(1);

    client.invalidateCache();

    await client.getFullState();
    expect(getConfigSpy).toHaveBeenCalledTimes(2);
  });

  it("is idempotent — calling twice does not throw", () => {
    const { client } = makeClient();
    expect(() => {
      client.invalidateCache();
      client.invalidateCache();
    }).not.toThrow();
  });
});
