/**
 * Tests for the opt-in stale-write preflight (issue #347).
 *
 * The preflight is a *content-based* complement to the *age-based* gating in
 * `gating.ts` / `staleState.integration.test.ts`.  A caller who believes their
 * data is fresh can still be wrong — another member may have acted in between,
 * advancing the round or completing the pot.  `detectStateMismatches` compares
 * the specific values the caller declares they expected against the values
 * freshly read from chain, so a *predictable* stale submission is caught before
 * it is ever sent.
 *
 * Coverage maps to the three acceptance criteria:
 *   (a) Callers can detect predictable stale submissions — `preflight()` returns
 *       typed mismatches; a stale mutation returns `errorCode: "stale_state"`.
 *   (b) The contract remains the final authority — a preflight *read* failure
 *       does not block the write; a passing preflight still submits.
 *   (c) Preflight does not alter transaction arguments — the args reaching the
 *       write path are byte-identical whether or not a preflight ran.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { detectStateMismatches } from "../gating";
import type { ActualState } from "../gating";
import { CircleClient, DEFAULT_FULL_STATE_CACHE_TTL_MS } from "../client";
import type { CircleConfig, RoundState } from "../types";
import {
  SDK_CONFIG,
  CIRCLE_ADDR,
  CREATOR,
  MEMBER_A,
  MEMBER_A_ADDR,
  MEMBER_B_ADDR,
  REPUTATION_ADDR,
  USDC_ADDR,
  FAST_POLL,
} from "./fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── detectStateMismatches (pure comparator) ────────────────────────────────────

/** Build a fully-known ActualState; override individual fields per test. */
function actual(overrides: Partial<ActualState> = {}): ActualState {
  return {
    status: "Active",
    roundIndex: 2,
    contributionsReceived: 3,
    hasContributed: false,
    paidOut: false,
    ...overrides,
  };
}

describe("detectStateMismatches", () => {
  it("returns no mismatches when the caller pinned nothing", () => {
    expect(detectStateMismatches({}, actual())).toEqual([]);
  });

  it("returns no mismatches when every pinned field matches", () => {
    const mismatches = detectStateMismatches(
      {
        status: "Active",
        roundIndex: 2,
        contributionsReceived: 3,
        hasContributed: false,
        paidOut: false,
      },
      actual(),
    );
    expect(mismatches).toEqual([]);
  });

  it("detects a status divergence", () => {
    expect(
      detectStateMismatches({ status: "Active" }, actual({ status: "Completed" })),
    ).toEqual([{ field: "status", expected: "Active", actual: "Completed" }]);
  });

  it("detects a round-index divergence (another member advanced the round)", () => {
    expect(
      detectStateMismatches({ roundIndex: 2 }, actual({ roundIndex: 3 })),
    ).toEqual([{ field: "roundIndex", expected: 2, actual: 3 }]);
  });

  it("detects a contributions-received divergence", () => {
    expect(
      detectStateMismatches(
        { contributionsReceived: 2 },
        actual({ contributionsReceived: 3 }),
      ),
    ).toEqual([{ field: "contributionsReceived", expected: 2, actual: 3 }]);
  });

  it("detects a hasContributed divergence", () => {
    expect(
      detectStateMismatches({ hasContributed: false }, actual({ hasContributed: true })),
    ).toEqual([{ field: "hasContributed", expected: false, actual: true }]);
  });

  it("detects a paidOut divergence", () => {
    expect(
      detectStateMismatches({ paidOut: false }, actual({ paidOut: true })),
    ).toEqual([{ field: "paidOut", expected: false, actual: true }]);
  });

  it("reports multiple divergences in a stable field order", () => {
    const mismatches = detectStateMismatches(
      {
        status: "Active",
        roundIndex: 2,
        contributionsReceived: 2,
        hasContributed: false,
        paidOut: false,
      },
      actual({
        status: "Completed",
        roundIndex: 3,
        contributionsReceived: 3,
        hasContributed: true,
        paidOut: true,
      }),
    );
    expect(mismatches.map((m) => m.field)).toEqual([
      "status",
      "roundIndex",
      "contributionsReceived",
      "hasContributed",
      "paidOut",
    ]);
  });

  it("only compares fields the caller pinned (ignores the rest)", () => {
    // roundIndex matches; status differs but was not pinned → no mismatch.
    expect(
      detectStateMismatches({ roundIndex: 2 }, actual({ status: "Completed" })),
    ).toEqual([]);
  });

  it("skips a pinned field whose actual value is unknown (null)", () => {
    // The circle has no current round, so roundIndex is unknown. The comparator
    // must not invent a mismatch it cannot substantiate — the contract stays the
    // final authority.
    expect(
      detectStateMismatches({ roundIndex: 2 }, actual({ roundIndex: null })),
    ).toEqual([]);
  });

  it("skips hasContributed when it was not read (null)", () => {
    expect(
      detectStateMismatches({ hasContributed: false }, actual({ hasContributed: null })),
    ).toEqual([]);
  });
});

// ─── CircleClient integration ───────────────────────────────────────────────────

const CONFIG: CircleConfig = {
  members: [MEMBER_A_ADDR, MEMBER_B_ADDR],
  roundAmount: 100_000_000n,
  usdcToken: USDC_ADDR,
  reputationContract: REPUTATION_ADDR,
  roundDeadlineLedgers: 120_960,
};

const ROUND: RoundState = {
  roundIndex: 2,
  recipient: MEMBER_A_ADDR,
  contributionsReceived: 3,
  deadlineLedger: 5_000_000n,
  paidOut: false,
};

const CANNED_SUCCESS = {
  success: true as const,
  txHash: "txhash123",
  ledger: 100,
  returnValue: undefined,
};

/**
 * Build a CircleClient with its reads stubbed to a known state and its write
 * funnel (`buildAndSend`) stubbed to a canned success.  `encodeAndSend` runs for
 * real, so argument encoding is genuinely exercised on the way to `buildAndSend`.
 */
function makeClient(opts: {
  status: CircleCfgStatus;
  round: RoundState | null;
  hasContributed?: boolean;
  ttlMs?: number;
}) {
  const client = new CircleClient(
    SDK_CONFIG,
    CIRCLE_ADDR,
    opts.ttlMs ?? DEFAULT_FULL_STATE_CACHE_TTL_MS,
    FAST_POLL,
  );

  const getConfig = vi.spyOn(client as any, "getConfig").mockResolvedValue(CONFIG);
  const getStatus = vi.spyOn(client as any, "getStatus").mockResolvedValue(opts.status);
  const getCurrentRoundResult = vi
    .spyOn(client as any, "getCurrentRoundResult")
    .mockResolvedValue(
      opts.round ? { ok: true, value: opts.round } : { ok: false, error: "no active round" },
    );
  const hasContributed = vi
    .spyOn(client as any, "hasContributed")
    .mockResolvedValue(opts.hasContributed ?? false);
  const buildAndSend = vi
    .spyOn(client as any, "buildAndSend")
    .mockResolvedValue(CANNED_SUCCESS);

  return {
    client,
    spies: { getConfig, getStatus, getCurrentRoundResult, hasContributed, buildAndSend },
  };
}

// A local alias so the helper signature reads clearly without importing the
// union name (it is re-exported through the SDK's own barrel).
type CircleCfgStatus = "Pending" | "Active" | "Completed" | "Cancelled";

describe("CircleClient.preflight", () => {
  it("returns { stale: false } when the pinned state still matches chain", async () => {
    const { client } = makeClient({ status: "Active", round: ROUND });
    const r = await client.preflight({ expected: { status: "Active", roundIndex: 2 } });
    expect(r.stale).toBe(false);
  });

  it("returns typed mismatches when the round advanced under the caller", async () => {
    const { client } = makeClient({ status: "Active", round: { ...ROUND, roundIndex: 3 } });
    const r = await client.preflight({ expected: { roundIndex: 2 } });

    expect(r.stale).toBe(true);
    if (r.stale) {
      expect(r.mismatches).toEqual([{ field: "roundIndex", expected: 2, actual: 3 }]);
      expect(r.message).toContain("roundIndex");
    }
  });

  it("force-refreshes: it bypasses a still-valid cache", async () => {
    const { client, spies } = makeClient({ status: "Active", round: ROUND, ttlMs: 60_000 });
    await client.getFullState(); // populate cache (getStatus called once)
    expect(spies.getStatus).toHaveBeenCalledTimes(1);

    await client.preflight({ expected: { roundIndex: 2 } });
    // A fresh read happened despite the cache being valid.
    expect(spies.getStatus).toHaveBeenCalledTimes(2);
  });

  it("resolves hasContributed only when pinned AND a member address is supplied", async () => {
    const { client, spies } = makeClient({
      status: "Active",
      round: ROUND,
      hasContributed: true,
    });

    const r = await client.preflight({
      expected: { hasContributed: false },
      memberAddress: MEMBER_A_ADDR,
    });

    expect(spies.hasContributed).toHaveBeenCalledWith(MEMBER_A_ADDR, ROUND.roundIndex);
    expect(r.stale).toBe(true);
    if (r.stale) {
      expect(r.mismatches).toEqual([{ field: "hasContributed", expected: false, actual: true }]);
    }
  });

  it("does NOT read hasContributed when no member address is supplied", async () => {
    const { client, spies } = makeClient({
      status: "Active",
      round: ROUND,
      hasContributed: true,
    });

    // hasContributed is pinned but no memberAddress → cannot resolve → skipped,
    // and nothing else diverges, so the preflight passes.
    const r = await client.preflight({ expected: { hasContributed: false } });

    expect(spies.hasContributed).not.toHaveBeenCalled();
    expect(r.stale).toBe(false);
  });

  it("does NOT read hasContributed when the field was not pinned", async () => {
    const { client, spies } = makeClient({ status: "Active", round: ROUND });
    await client.preflight({ expected: { roundIndex: 2 }, memberAddress: MEMBER_A_ADDR });
    expect(spies.hasContributed).not.toHaveBeenCalled();
  });
});

describe("mutation preflight guard", () => {
  it("blocks a contribute against a stale round with errorCode 'stale_state'", async () => {
    const { client, spies } = makeClient({
      status: "Active",
      round: { ...ROUND, roundIndex: 3 },
    });

    const r = await client.contribute(MEMBER_A, { expected: { roundIndex: 2 } });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.errorCode).toBe("stale_state");
      expect(r.txHash).toBe("");
      expect(r.mismatches).toEqual([{ field: "roundIndex", expected: 2, actual: 3 }]);
    }
    // The stale write was never submitted.
    expect(spies.buildAndSend).not.toHaveBeenCalled();
  });

  it("proceeds to submit when the preflight passes", async () => {
    const { client, spies } = makeClient({ status: "Active", round: ROUND });
    const r = await client.contribute(MEMBER_A, { expected: { roundIndex: 2 } });

    expect(r.success).toBe(true);
    expect(spies.buildAndSend).toHaveBeenCalledTimes(1);
  });

  it("fast path: with no preflight option it never force-refreshes", async () => {
    const { client, spies } = makeClient({ status: "Active", round: ROUND });
    const r = await client.contribute(MEMBER_A);

    expect(r.success).toBe(true);
    expect(spies.buildAndSend).toHaveBeenCalledTimes(1);
    // No preflight ran → no state read was triggered by the mutation.
    expect(spies.getStatus).not.toHaveBeenCalled();
  });

  it("proceeds when the preflight READ fails (contract stays the authority)", async () => {
    const { client, spies } = makeClient({ status: "Active", round: ROUND });
    spies.getStatus.mockRejectedValue(new Error("RPC unreachable"));

    const r = await client.contribute(MEMBER_A, { expected: { roundIndex: 2 } });

    // A read failure must not manufacture a stale_state block; the write goes
    // through and the contract will reject it if it is genuinely stale.
    expect(r.success).toBe(true);
    expect(spies.buildAndSend).toHaveBeenCalledTimes(1);
  });

  it("does not alter transaction arguments (identical args with/without preflight)", async () => {
    const encode = (v: xdr.ScVal) => v.toXDR("base64");

    const { client: c1, spies: s1 } = makeClient({ status: "Active", round: ROUND });
    await c1.contribute(MEMBER_A); // no preflight
    const [, contractNoPre, methodNoPre, argsNoPre] = s1.buildAndSend.mock.calls[0] as [
      unknown,
      string,
      string,
      xdr.ScVal[],
    ];

    const { client: c2, spies: s2 } = makeClient({ status: "Active", round: ROUND });
    await c2.contribute(MEMBER_A, { expected: { roundIndex: 2 } }); // passing preflight
    const [, contractWithPre, methodWithPre, argsWithPre] = s2.buildAndSend.mock.calls[0] as [
      unknown,
      string,
      string,
      xdr.ScVal[],
    ];

    expect(contractWithPre).toBe(contractNoPre);
    expect(methodWithPre).toBe(methodNoPre);
    expect(argsWithPre.map(encode)).toEqual(argsNoPre.map(encode));
  });

  it("blocks payout when the round already paid out", async () => {
    const { client, spies } = makeClient({
      status: "Active",
      round: { ...ROUND, paidOut: true },
    });

    const r = await client.payout(CREATOR, { expected: { paidOut: false } });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.errorCode).toBe("stale_state");
      expect(r.mismatches).toEqual([{ field: "paidOut", expected: false, actual: true }]);
    }
    expect(spies.buildAndSend).not.toHaveBeenCalled();
  });

  it("blocks close when the status moved away from what the caller expected", async () => {
    const { client, spies } = makeClient({ status: "Completed", round: null });

    const r = await client.close(CREATOR, { expected: { status: "Active" } });

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.errorCode).toBe("stale_state");
      expect(r.mismatches).toEqual([
        { field: "status", expected: "Active", actual: "Completed" },
      ]);
    }
    expect(spies.buildAndSend).not.toHaveBeenCalled();
  });

  it("validates markDefault arguments BEFORE running the preflight", async () => {
    const { client, spies } = makeClient({
      status: "Active",
      round: { ...ROUND, roundIndex: 3 }, // would be stale if preflight ran
    });

    const r = await client.markDefault(CREATOR, "not-an-address", {
      expected: { roundIndex: 2 },
    });

    expect(r.success).toBe(false);
    if (!r.success) expect(r.errorCode).toBe("invalid_argument");
    // The argument error short-circuits before any preflight read.
    expect(spies.getStatus).not.toHaveBeenCalled();
  });

  it("blocks markDefault with a valid member against stale state", async () => {
    const { client, spies } = makeClient({
      status: "Active",
      round: { ...ROUND, roundIndex: 3 },
    });

    const r = await client.markDefault(CREATOR, MEMBER_B_ADDR, {
      expected: { roundIndex: 2 },
    });

    expect(r.success).toBe(false);
    if (!r.success) expect(r.errorCode).toBe("stale_state");
    expect(spies.buildAndSend).not.toHaveBeenCalled();
  });

  it("join proceeds when the preflight passes", async () => {
    const { client, spies } = makeClient({ status: "Pending", round: ROUND });
    const r = await client.join(MEMBER_A, { expected: { status: "Pending" } });

    expect(r.success).toBe(true);
    expect(spies.buildAndSend).toHaveBeenCalledTimes(1);
  });
});
