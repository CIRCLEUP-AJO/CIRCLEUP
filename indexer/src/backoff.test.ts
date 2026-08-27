/**
 * Tests for Issue 29: Exponential backoff with shutdown support
 *
 * The polling service must handle temporary RPC failures without entering a
 * hot loop or exiting immediately. This test suite verifies:
 *
 * - Initial backoff interval is applied after first failure
 * - Interval increases exponentially on consecutive failures
 * - Interval is capped at the maximum
 * - Jitter spreads retry attempts across time
 * - Successful poll resets backoff state
 * - Warning thresholds trigger at appropriate failure counts
 */

import { describe, it, expect } from "vitest";

// ─── Backoff policy (mirrored from indexer.ts for testing) ────────────────────

interface BackoffState {
  consecutiveFailures: number;
  currentIntervalMs: number;
}

const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const BACKOFF_MULTIPLIER = 2.0;

function createBackoffState(): BackoffState {
  return {
    consecutiveFailures: 0,
    currentIntervalMs: BACKOFF_INITIAL_MS,
  };
}

function resetBackoff(state: BackoffState): void {
  state.consecutiveFailures = 0;
  state.currentIntervalMs = BACKOFF_INITIAL_MS;
}

function incrementBackoff(state: BackoffState): void {
  state.consecutiveFailures++;
  state.currentIntervalMs = Math.min(
    BACKOFF_MAX_MS,
    state.currentIntervalMs * BACKOFF_MULTIPLIER,
  );
}

function computeJitteredWait(state: BackoffState): number {
  return Math.floor(Math.random() * state.currentIntervalMs);
}

function shouldWarnBackoff(state: BackoffState): boolean {
  const n = state.consecutiveFailures;
  return n >= 3 && (n & (n - 1)) === 0;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("Exponential backoff policy", () => {
  it("starts with initial interval and zero failures", () => {
    const state = createBackoffState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.currentIntervalMs).toBe(BACKOFF_INITIAL_MS);
  });

  it("increments failure count and doubles interval on first failure", () => {
    const state = createBackoffState();
    incrementBackoff(state);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.currentIntervalMs).toBe(BACKOFF_INITIAL_MS * BACKOFF_MULTIPLIER);
  });

  it("continues doubling interval on consecutive failures", () => {
    const state = createBackoffState();
    incrementBackoff(state); // 1000 → 2000
    incrementBackoff(state); // 2000 → 4000
    incrementBackoff(state); // 4000 → 8000
    expect(state.consecutiveFailures).toBe(3);
    expect(state.currentIntervalMs).toBe(8000);
  });

  it("caps interval at maximum", () => {
    const state = createBackoffState();
    // Simulate many failures until we exceed the cap
    for (let i = 0; i < 10; i++) {
      incrementBackoff(state);
    }
    expect(state.currentIntervalMs).toBe(BACKOFF_MAX_MS);
    expect(state.consecutiveFailures).toBe(10);
  });

  it("resets to initial state after successful poll", () => {
    const state = createBackoffState();
    incrementBackoff(state);
    incrementBackoff(state);
    incrementBackoff(state);
    expect(state.consecutiveFailures).toBe(3);
    expect(state.currentIntervalMs).toBe(8000);

    resetBackoff(state);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.currentIntervalMs).toBe(BACKOFF_INITIAL_MS);
  });

  it("jittered wait is within [0, currentInterval]", () => {
    const state = createBackoffState();
    incrementBackoff(state);
    const currentInterval = state.currentIntervalMs;

    for (let i = 0; i < 100; i++) {
      const jittered = computeJitteredWait(state);
      expect(jittered).toBeGreaterThanOrEqual(0);
      expect(jittered).toBeLessThanOrEqual(currentInterval);
    }
  });

  it("jittered wait produces varied values (not constant)", () => {
    const state = createBackoffState();
    incrementBackoff(state);
    
    const samples = new Set<number>();
    for (let i = 0; i < 20; i++) {
      samples.add(computeJitteredWait(state));
    }
    
    // With 20 samples in [0, 2000], we should see at least 10 distinct values
    expect(samples.size).toBeGreaterThan(10);
  });
});

describe("Backoff warning thresholds", () => {
  it("does not warn before 3 failures", () => {
    const state = createBackoffState();
    expect(shouldWarnBackoff(state)).toBe(false);
    
    incrementBackoff(state);
    expect(shouldWarnBackoff(state)).toBe(false);
    
    incrementBackoff(state);
    expect(shouldWarnBackoff(state)).toBe(false);
  });

  it("warns at 3 failures (first power of 2 >= 3)", () => {
    const state = createBackoffState();
    incrementBackoff(state);
    incrementBackoff(state);
    incrementBackoff(state);
    expect(shouldWarnBackoff(state)).toBe(true);
  });

  it("warns at 4 failures", () => {
    const state = createBackoffState();
    for (let i = 0; i < 4; i++) incrementBackoff(state);
    expect(shouldWarnBackoff(state)).toBe(true);
  });

  it("does not warn at 5 failures (not a power of 2)", () => {
    const state = createBackoffState();
    for (let i = 0; i < 5; i++) incrementBackoff(state);
    expect(shouldWarnBackoff(state)).toBe(false);
  });

  it("warns at 8 failures", () => {
    const state = createBackoffState();
    for (let i = 0; i < 8; i++) incrementBackoff(state);
    expect(shouldWarnBackoff(state)).toBe(true);
  });

  it("warns at powers of 2: 3, 4, 8, 16, 32", () => {
    const warnPoints = [3, 4, 8, 16, 32];
    const noWarnPoints = [5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 17, 18];

    for (const n of warnPoints) {
      const state = createBackoffState();
      for (let i = 0; i < n; i++) incrementBackoff(state);
      expect(shouldWarnBackoff(state)).toBe(true);
    }

    for (const n of noWarnPoints) {
      const state = createBackoffState();
      for (let i = 0; i < n; i++) incrementBackoff(state);
      expect(shouldWarnBackoff(state)).toBe(false);
    }
  });
});

describe("Backoff progression", () => {
  it("follows expected sequence: 1s → 2s → 4s → 8s → 16s → 32s → 60s (cap)", () => {
    const state = createBackoffState();
    const expected = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];

    for (const expectedInterval of expected) {
      incrementBackoff(state);
      expect(state.currentIntervalMs).toBe(expectedInterval);
    }
  });

  it("remains at cap after many failures", () => {
    const state = createBackoffState();
    for (let i = 0; i < 20; i++) {
      incrementBackoff(state);
    }
    expect(state.currentIntervalMs).toBe(BACKOFF_MAX_MS);
    expect(state.consecutiveFailures).toBe(20);
  });
});
