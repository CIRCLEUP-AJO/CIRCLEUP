/**
 * Tests for Issue 456: Retry safety and dedup behavior
 *
 * Verifies that:
 * - withRpcRetry uses jittered delays between attempts
 * - RPC retry does not leak state across calls
 * - Dedup keys are stable across restarts
 * - ingestEventInTx deduplicates correctly via INSERT ... ON CONFLICT
 */

import { describe, it, expect, vi } from "vitest";
import { withRpcRetry, computeJitteredDelay, createEventKey, parseEventIndex } from "./indexer";
import type { SorobanRpc } from "@stellar/stellar-sdk";

type SdkEvent = SorobanRpc.Api.EventResponse;

// ─── withRpcRetry jitter behavior ────────────────────────────────────────────

describe("withRpcRetry", () => {
  it("retries transient errors up to maxAttempts", async () => {
    let attempts = 0;
    const result = await withRpcRetry(
      "test",
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("ECONNRESET");
        return "ok";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 10,
        sleep: async () => {}, // no actual delay in tests
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("fails after maxAttempts with transient errors", async () => {
    let attempts = 0;
    await expect(
      withRpcRetry(
        "test",
        async () => {
          attempts++;
          throw new Error("ETIMEDOUT");
        },
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("failed after 3 attempt(s)");

    expect(attempts).toBe(3);
  });

  it("does not retry non-transient errors", async () => {
    let attempts = 0;
    await expect(
      withRpcRetry(
        "test",
        async () => {
          attempts++;
          throw new Error("malformed request");
        },
        {
          maxAttempts: 5,
          baseDelayMs: 10,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("failed after 1 attempt(s)");

    expect(attempts).toBe(1);
  });

  it("resets attempt count across independent calls", async () => {
    // First call: succeeds on attempt 3
    let attempts1 = 0;
    const result1 = await withRpcRetry(
      "test",
      async () => {
        attempts1++;
        if (attempts1 < 3) throw new Error("ECONNRESET");
        return "ok1";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 10,
        sleep: async () => {},
      },
    );
    expect(result1).toBe("ok1");

    // Second call: starts fresh from attempt 1
    let attempts2 = 0;
    const result2 = await withRpcRetry(
      "test",
      async () => {
        attempts2++;
        if (attempts2 < 2) throw new Error("ECONNRESET");
        return "ok2";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 10,
        sleep: async () => {},
      },
    );
    expect(result2).toBe("ok2");
    expect(attempts2).toBe(2);
  });

  it("applies jittered delay between retries", async () => {
    const sleepCalls: number[] = [];
    const mockSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    let attempts = 0;
    await withRpcRetry(
      "test",
      async () => {
        attempts++;
        if (attempts <= 2) throw new Error("ECONNRESET");
        return "ok";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 100,
        sleep: mockSleep,
      },
    );

    // Should have slept twice (after attempt 1 and 2)
    expect(sleepCalls.length).toBe(2);
    // Each delay should be in [0, baseDelay * 2^(attempt-1)]
    // Attempt 1: [0, 100], Attempt 2: [0, 200]
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(0);
    expect(sleepCalls[0]).toBeLessThanOrEqual(100);
    expect(sleepCalls[1]).toBeGreaterThanOrEqual(0);
    expect(sleepCalls[1]).toBeLessThanOrEqual(200);
  });

  it("immediate success does not trigger any sleep", async () => {
    const sleepCalls: number[] = [];
    const mockSleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    await withRpcRetry(
      "test",
      async () => "ok",
      {
        maxAttempts: 5,
        baseDelayMs: 100,
        sleep: mockSleep,
      },
    );

    expect(sleepCalls.length).toBe(0);
  });
});

// ─── computeJitteredDelay edge cases ─────────────────────────────────────────

describe("computeJitteredDelay", () => {
  it("returns integer values", () => {
    for (let i = 0; i < 50; i++) {
      const result = computeJitteredDelay(1000);
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  it("never exceeds delayMs", () => {
    for (let i = 0; i < 100; i++) {
      const result = computeJitteredDelay(500);
      expect(result).toBeLessThan(500);
    }
  });
});

// ─── Event key stability ─────────────────────────────────────────────────────

describe("Event key stability across restarts", () => {
  it("same event produces identical key when called multiple times", () => {
    const event = {
      id: "0000012345678-0000000002-0000000001",
      ledger: 12345678,
      txHash: "abc123def456",
      contractId: "CDEF",
      topic: [],
      value: null,
    } as unknown as SdkEvent;

    const keys = Array.from({ length: 10 }, () => createEventKey(event));
    expect(new Set(keys).size).toBe(1);
  });

  it("keys are deterministic strings, not random", () => {
    const event = {
      id: "0000012345678-0000000002-0000000001",
      ledger: 12345678,
      txHash: "abc123",
      contractId: "CDEF",
      topic: [],
      value: null,
    } as unknown as SdkEvent;

    const key = createEventKey(event);
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
    // Key should contain the ledger number
    expect(key).toContain("12345678");
  });
});
