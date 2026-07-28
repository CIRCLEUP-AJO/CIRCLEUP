/**
 * Tests for Issue 117: typed wrappers for getConfig, getStatus, getCurrentRound.
 *
 * Covers:
 *   - mapRawConfig / mapRawRoundState pure mapping helpers (field mapping,
 *     type coercions, missing-field errors)
 *   - assertValidCircleStatus (accepts all four variants, rejects garbage)
 *   - ReadResult<T> type-guards (isReadSuccess / isReadFailure)
 *   - getConfigResult / getStatusResult / getCurrentRoundResult
 *     (ok path, error path, shape of returned value)
 *
 * No RPC calls are made — simulateAndRead is mocked at the prototype level
 * using the same pattern as the rest of the SDK test suite.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CircleClient, CircleUpClient } from "../client";
import {
  mapRawConfig,
  mapRawRoundState,
  assertValidCircleStatus,
  isReadSuccess,
  isReadFailure,
  type CircleUpConfig,
  type CircleConfig,
  type RoundState,
  type CircleStatus,
  type RawCircleConfig,
  type RawRoundState,
  type ReadResult,
} from "../types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SDK_CONFIG: CircleUpConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: {
    circleFactory: "CFACTORY000000000000000000000000000000000000000000000000",
    reputation: "CREP00000000000000000000000000000000000000000000000000000",
    usdc: "CUSDC0000000000000000000000000000000000000000000000000000",
  },
};

const CIRCLE_ADDR = "CCIRCLE00000000000000000000000000000000000000000000000000";

const WIRE_CONFIG: RawCircleConfig = {
  members: [
    "GABC0000000000000000000000000000000000000000000000000000",
    "GDEF0000000000000000000000000000000000000000000000000000",
  ],
  round_amount: 100_000_000n,
  usdc_token: "CUSDC0000000000000000000000000000000000000000000000000000",
  reputation_contract: "CREP00000000000000000000000000000000000000000000000000000",
  round_deadline_ledgers: 120_960,
};

const WIRE_ROUND: RawRoundState = {
  round_index: 2,
  recipient: "GABC0000000000000000000000000000000000000000000000000000",
  contributions_received: 3,
  deadline_ledger: 5_000_000n,
  paid_out: false,
};

function makeClient(): CircleClient {
  return new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0);
}

// ─── mapRawConfig ─────────────────────────────────────────────────────────────

describe("mapRawConfig", () => {
  it("maps all wire fields to CircleConfig shape", () => {
    const cfg: CircleConfig = mapRawConfig(WIRE_CONFIG);
    expect(cfg.members).toEqual(WIRE_CONFIG.members);
    expect(cfg.roundAmount).toBe(100_000_000n);
    expect(cfg.usdcToken).toBe(WIRE_CONFIG.usdc_token);
    expect(cfg.reputationContract).toBe(WIRE_CONFIG.reputation_contract);
    expect(cfg.roundDeadlineLedgers).toBe(120_960);
  });

  it("converts round_amount to bigint regardless of incoming type", () => {
    const cfg = mapRawConfig({ ...WIRE_CONFIG, round_amount: 50_000_000n });
    expect(typeof cfg.roundAmount).toBe("bigint");
    expect(cfg.roundAmount).toBe(50_000_000n);
  });

  it("converts round_deadline_ledgers to number", () => {
    const cfg = mapRawConfig({ ...WIRE_CONFIG, round_deadline_ledgers: 17_280 });
    expect(typeof cfg.roundDeadlineLedgers).toBe("number");
    expect(cfg.roundDeadlineLedgers).toBe(17_280);
  });

  it("throws when members field is missing", () => {
    const bad = { ...WIRE_CONFIG, members: undefined as any };
    expect(() => mapRawConfig(bad)).toThrow(/members/);
  });

  it("throws when members field is not an array", () => {
    const bad = { ...WIRE_CONFIG, members: "not-an-array" as any };
    expect(() => mapRawConfig(bad)).toThrow(/members/);
  });

  it("throws when round_amount is missing", () => {
    const bad = { ...WIRE_CONFIG, round_amount: undefined as any };
    expect(() => mapRawConfig(bad)).toThrow(/round_amount/);
  });

  it("handles an empty members array without throwing", () => {
    // Contract guarantees ≥2 members, but the mapping helper should not enforce that
    const cfg = mapRawConfig({ ...WIRE_CONFIG, members: [] });
    expect(cfg.members).toEqual([]);
  });
});

// ─── mapRawRoundState ─────────────────────────────────────────────────────────

describe("mapRawRoundState", () => {
  it("maps all wire fields to RoundState shape", () => {
    const r: RoundState = mapRawRoundState(WIRE_ROUND);
    expect(r.roundIndex).toBe(2);
    expect(r.recipient).toBe(WIRE_ROUND.recipient);
    expect(r.contributionsReceived).toBe(3);
    expect(r.deadlineLedger).toBe(5_000_000n);
    expect(r.paidOut).toBe(false);
  });

  it("converts deadline_ledger to bigint", () => {
    const r = mapRawRoundState({ ...WIRE_ROUND, deadline_ledger: 9_999n });
    expect(typeof r.deadlineLedger).toBe("bigint");
    expect(r.deadlineLedger).toBe(9_999n);
  });

  it("converts paid_out to boolean", () => {
    expect(mapRawRoundState({ ...WIRE_ROUND, paid_out: true }).paidOut).toBe(true);
    expect(mapRawRoundState({ ...WIRE_ROUND, paid_out: false }).paidOut).toBe(false);
  });

  it("converts round_index to number", () => {
    const r = mapRawRoundState({ ...WIRE_ROUND, round_index: 0 });
    expect(typeof r.roundIndex).toBe("number");
    expect(r.roundIndex).toBe(0);
  });

  it("throws when round_index is missing", () => {
    const bad = { ...WIRE_ROUND, round_index: undefined as any };
    expect(() => mapRawRoundState(bad)).toThrow(/round_index/);
  });

  it("throws when recipient is missing", () => {
    const bad = { ...WIRE_ROUND, recipient: "" };
    expect(() => mapRawRoundState(bad)).toThrow(/recipient/);
  });
});

// ─── assertValidCircleStatus ──────────────────────────────────────────────────

describe("assertValidCircleStatus", () => {
  const valid: CircleStatus[] = ["Pending", "Active", "Completed", "Cancelled"];

  it.each(valid)("accepts '%s' as a valid status", (status) => {
    expect(assertValidCircleStatus(status)).toBe(status);
  });

  it("throws for an unrecognised string", () => {
    expect(() => assertValidCircleStatus("Running")).toThrow(/Running/);
    expect(() => assertValidCircleStatus("active")).toThrow(); // wrong case
    expect(() => assertValidCircleStatus("")).toThrow();
  });

  it("throws for non-string input", () => {
    expect(() => assertValidCircleStatus(null)).toThrow();
    expect(() => assertValidCircleStatus(undefined)).toThrow();
    expect(() => assertValidCircleStatus(1)).toThrow();
  });

  it("error message lists the valid options", () => {
    try {
      assertValidCircleStatus("Bogus");
      expect.fail("should have thrown");
    } catch (e: any) {
      for (const v of valid) {
        expect(e.message).toContain(v);
      }
    }
  });
});

// ─── ReadResult type-guards ───────────────────────────────────────────────────

describe("isReadSuccess / isReadFailure", () => {
  it("isReadSuccess returns true for ok:true", () => {
    const r: ReadResult<number> = { ok: true, value: 42 };
    expect(isReadSuccess(r)).toBe(true);
  });

  it("isReadSuccess returns false for ok:false", () => {
    const r: ReadResult<number> = { ok: false, error: "oops" };
    expect(isReadSuccess(r)).toBe(false);
  });

  it("isReadFailure returns true for ok:false", () => {
    const r: ReadResult<string> = { ok: false, error: "failed" };
    expect(isReadFailure(r)).toBe(true);
  });

  it("isReadFailure returns false for ok:true", () => {
    const r: ReadResult<string> = { ok: true, value: "hello" };
    expect(isReadFailure(r)).toBe(false);
  });

  it("isReadSuccess narrows the type so value is accessible", () => {
    const r: ReadResult<CircleConfig> = { ok: true, value: mapRawConfig(WIRE_CONFIG) };
    if (isReadSuccess(r)) {
      // TypeScript would error here if narrowing didn't work
      expect(r.value.roundAmount).toBe(100_000_000n);
    } else {
      expect.fail("should have been a success");
    }
  });

  it("isReadFailure narrows the type so error is accessible", () => {
    const r: ReadResult<CircleStatus> = { ok: false, error: "simulation failed" };
    if (isReadFailure(r)) {
      expect(r.error).toBe("simulation failed");
    } else {
      expect.fail("should have been a failure");
    }
  });
});

// ─── CircleClient.getConfigResult ────────────────────────────────────────────

describe("CircleClient.getConfigResult", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns ok:true with a CircleConfig on success", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue(
      WIRE_CONFIG,
    );
    const result = await makeClient().getConfigResult();

    expect(result.ok).toBe(true);
    if (isReadSuccess(result)) {
      expect(result.value.roundAmount).toBe(100_000_000n);
      expect(result.value.members).toEqual(WIRE_CONFIG.members);
    }
  });

  it("returns ok:false with an error string when simulation fails", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockRejectedValue(
      new Error("RPC unavailable"),
    );
    const result = await makeClient().getConfigResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(result.error).toContain("RPC unavailable");
    }
  });

  it("returns ok:false when the raw wire data has missing fields", async () => {
    // Simulate a decode error by returning a wire object missing round_amount
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue(
      { ...WIRE_CONFIG, round_amount: undefined },
    );
    const result = await makeClient().getConfigResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(result.error).toMatch(/round_amount/i);
    }
  });

  it("never throws — always returns a ReadResult", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockRejectedValue(
      new Error("catastrophic failure"),
    );
    await expect(makeClient().getConfigResult()).resolves.toMatchObject({ ok: false });
  });
});

// ─── CircleClient.getStatusResult ────────────────────────────────────────────

describe("CircleClient.getStatusResult", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["Pending", "Active", "Completed", "Cancelled"] as CircleStatus[])(
    "returns ok:true with value '%s' for a valid status",
    async (status) => {
      vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue(status);
      const result = await makeClient().getStatusResult();

      expect(result.ok).toBe(true);
      if (isReadSuccess(result)) {
        expect(result.value).toBe(status);
      }
    },
  );

  it("returns ok:false when simulation throws", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockRejectedValue(
      new Error("timeout"),
    );
    const result = await makeClient().getStatusResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(result.error).toContain("timeout");
    }
  });

  it("returns ok:false when the contract returns an unrecognised status string", async () => {
    // assertValidCircleStatus will throw for an unknown variant
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue(
      "InvalidStatus",
    );
    const result = await makeClient().getStatusResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(result.error).toContain("InvalidStatus");
    }
  });

  it("never throws", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockRejectedValue(
      new Error("boom"),
    );
    await expect(makeClient().getStatusResult()).resolves.toMatchObject({ ok: false });
  });
});

// ─── CircleClient.getCurrentRoundResult ──────────────────────────────────────

describe("CircleClient.getCurrentRoundResult", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns ok:true with a RoundState on success", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue(
      WIRE_ROUND,
    );
    const result = await makeClient().getCurrentRoundResult();

    expect(result.ok).toBe(true);
    if (isReadSuccess(result)) {
      expect(result.value.roundIndex).toBe(2);
      expect(result.value.deadlineLedger).toBe(5_000_000n);
      expect(result.value.paidOut).toBe(false);
    }
  });

  it("returns ok:false when the circle is Completed or Cancelled (contract error)", async () => {
    // The contract's get_current_round returns an error for non-active circles.
    // simulateAndReadOrThrow converts this into a thrown Error.
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue({
      ok: false,
      error: "CircleNotActive",
    });
    // simulateAndReadOrThrow sees ok:false and throws — getCurrentRoundResult catches it
    const result = await makeClient().getCurrentRoundResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(result.error).toMatch(/CircleNotActive/i);
    }
  });

  it("returns ok:false when simulation throws a network error", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockRejectedValue(
      new Error("network unreachable"),
    );
    const result = await makeClient().getCurrentRoundResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(result.error).toContain("network unreachable");
    }
  });

  it("returns ok:false when wire data has a missing round_index", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue(
      { ...WIRE_ROUND, round_index: undefined },
    );
    const result = await makeClient().getCurrentRoundResult();

    expect(result.ok).toBe(false);
    if (isReadFailure(result)) {
      expect(result.error).toMatch(/round_index/i);
    }
  });

  it("never throws", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockRejectedValue(
      new Error("unexpected"),
    );
    await expect(makeClient().getCurrentRoundResult()).resolves.toMatchObject({ ok: false });
  });
});

// ─── getConfig / getStatus / getCurrentRound still throw on failure ───────────
//
// The throwing variants remain the primary API for callers that want an
// exception on failure rather than a discriminated union.  Verify they still
// propagate errors as before.

describe("throwing variants still propagate errors", () => {
  afterEach(() => vi.restoreAllMocks());

  it("getConfig throws when simulateAndRead fails", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockRejectedValue(
      new Error("get_config network error"),
    );
    await expect(makeClient().getConfig()).rejects.toThrow("get_config network error");
  });

  it("getStatus throws for an unrecognised status string", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockResolvedValue(
      "WeirdStatus",
    );
    await expect(makeClient().getStatus()).rejects.toThrow(/WeirdStatus/);
  });

  it("getCurrentRound throws when simulateAndRead fails", async () => {
    vi.spyOn(CircleUpClient.prototype as any, "simulateAndRead").mockRejectedValue(
      new Error("contract not active"),
    );
    await expect(makeClient().getCurrentRound()).rejects.toThrow("contract not active");
  });
});
