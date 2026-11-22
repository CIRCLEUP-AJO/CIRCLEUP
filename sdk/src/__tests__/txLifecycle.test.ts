/**
 * Transaction lifecycle and retry policy (issues #900, #902).
 *
 * - A local polling timeout is `pending`, never an on-chain failure.
 * - A missing RPC record is never a cancellation.
 * - A transaction that becomes visible after the polling budget can be picked
 *   up by hash with `waitForTransaction`, without resubmitting.
 * - Reads retry with bounded attempts; writes never rebuild.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { CircleUpClient } from "../client";
import { RETRY_POLICY, classifyRpcFailure, RpcReadCancelledError } from "../rpcRetry";
import { txLifecycleFromLookup, txLifecycleFromResult, isTxLifecycleSettled } from "../lifecycle";
import type { TxErrorCode, TxFailure } from "../types";
import { CIRCLE_ADDR, FAST_POLL, MEMBER_A, MOCK_ACCOUNT, SDK_CONFIG, simulationSuccess } from "./fixtures";

const HASH = "ef".repeat(32);

class TestClient extends CircleUpClient {
  call() {
    return this.buildAndSend(MEMBER_A, CIRCLE_ADDR, "join", []);
  }
}

const fail = (errorCode: TxErrorCode, extra: Partial<TxFailure> = {}): TxFailure => ({
  success: false,
  txHash: HASH,
  errorMessage: "x",
  errorCode,
  ...extra,
});

const notFound = () => ({ status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND }) as any;
const found = (ledger = 77) => ({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS, ledger }) as any;

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => vi.restoreAllMocks());

// ─── Retry policy (#900) ──────────────────────────────────────────────────────

describe("RETRY_POLICY", () => {
  it("bounds read retries and never retries wallet prompts", () => {
    for (const stage of ["account", "simulation", "lookup", "read"] as const) {
      expect(RETRY_POLICY[stage].kind).toBe("read");
      expect(Number.isFinite(RETRY_POLICY[stage].maxAttempts)).toBe(true);
      expect(RETRY_POLICY[stage].baseDelayMs).toBeGreaterThan(0);
    }
    expect(RETRY_POLICY.wallet).toMatchObject({ maxAttempts: 1, retries: "none" });
  });

  it("only ever resends the identical envelope for submission", () => {
    expect(RETRY_POLICY.submission).toMatchObject({ kind: "write", retries: "same_envelope" });
    expect(Object.isFrozen(RETRY_POLICY)).toBe(true);
  });

  it("classifies provider errors", () => {
    expect(classifyRpcFailure(Object.assign(new Error("slow down"), { status: 429 }))).toBe("throttled");
    expect(classifyRpcFailure(new Error("socket hang up"))).toBe("transient");
    expect(classifyRpcFailure(new RpcReadCancelledError("x", "aborted"))).toBe("cancelled");
    expect(classifyRpcFailure(new Error("invalid params"))).toBe("permanent");
  });
});

describe("buildAndSend stage behaviour", () => {
  it("retries a transient account read within the bounded attempt budget", async () => {
    const getAccount = vi
      .spyOn(SorobanRpc.Server.prototype, "getAccount")
      .mockRejectedValue(new Error("fetch failed"));
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(getAccount).toHaveBeenCalledTimes(RETRY_POLICY.account.maxAttempts);
    expect(result.success === false && result.errorCode).toBe("network_error");
  });

  it("retries throttled simulation, then proceeds", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    const simulate = vi
      .spyOn(SorobanRpc.Server.prototype, "simulateTransaction")
      .mockRejectedValueOnce(Object.assign(new Error("Too Many Requests"), { status: 429 }))
      .mockResolvedValue(simulationSuccess());
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "PENDING",
      hash: HASH,
    } as any);
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(found());
    const result = await new TestClient(SDK_CONFIG, FAST_POLL).call();
    expect(simulate).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it("reports a timeout after submission as pending with its hash, without resending", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(simulationSuccess());
    const send = vi
      .spyOn(SorobanRpc.Server.prototype, "sendTransaction")
      .mockResolvedValue({ status: "PENDING", hash: HASH } as any);
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(notFound());

    const result = await new TestClient(SDK_CONFIG, { ...FAST_POLL, timeoutMs: 20 }).call();

    expect(send).toHaveBeenCalledTimes(1);
    const state = txLifecycleFromResult(result);
    expect(state).toMatchObject({ state: "pending", txHash: HASH, reason: "poll_timeout" });
    expect(isTxLifecycleSettled(state)).toBe(false);
  });
});

// ─── Resume by hash (#902) ────────────────────────────────────────────────────

describe("waitForTransaction", () => {
  it("picks up a transaction that becomes visible after the original polling budget", async () => {
    const send = vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction");
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction")
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(notFound())
      .mockResolvedValue(found(123));

    const result = await new CircleUpClient(SDK_CONFIG, FAST_POLL).waitForTransaction(HASH, { accepted: true });

    expect(result).toMatchObject({ success: true, txHash: HASH, ledger: 123 });
    expect(txLifecycleFromResult(result)).toMatchObject({ state: "confirmed", source: "rpc" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a malformed hash without any RPC call", async () => {
    const poll = vi.spyOn(SorobanRpc.Server.prototype, "getTransaction");
    const result = await new CircleUpClient(SDK_CONFIG, FAST_POLL).waitForTransaction("nope");
    expect(result.success === false && result.errorCode).toBe("invalid_argument");
    expect(poll).not.toHaveBeenCalled();
  });
});

// ─── Lifecycle mapping (#902) ─────────────────────────────────────────────────

describe("txLifecycleFromResult", () => {
  it("maps success to confirmed", () => {
    expect(
      txLifecycleFromResult({ success: true, txHash: HASH, ledger: 5 }),
    ).toEqual({ state: "confirmed", txHash: HASH, ledger: 5, source: "rpc", resumable: false });
  });

  it("only maps tx_failed to failed", () => {
    expect(txLifecycleFromResult(fail("tx_failed")).state).toBe("failed");
    expect(txLifecycleFromResult(fail("timeout")).state).toBe("pending");
  });

  it.each([
    "invalid_argument",
    "network_mismatch",
    "account_not_found",
    "simulation_failed",
    "network_error",
    "try_again_later",
    "tx_rejected",
    "tx_expired",
    "stale_state",
  ] as TxErrorCode[])("maps %s to not_applied", (code) => {
    expect(txLifecycleFromResult(fail(code)).state).toBe("not_applied");
  });

  it("maps outcome_unknown by what its diagnostics know", () => {
    const d = { txHash: HASH, sendAttempts: 1 } as const;
    expect(
      txLifecycleFromResult(fail("outcome_unknown", { diagnostics: { ...d, submission: "accepted", lookup: "failed" } })).state,
    ).toBe("submitted");
    expect(
      txLifecycleFromResult(fail("outcome_unknown", { diagnostics: { ...d, submission: "unknown", lookup: "not_found" } })),
    ).toMatchObject({ state: "pending", reason: "not_found", submissionAccepted: false });
    expect(
      txLifecycleFromResult(fail("outcome_unknown", { diagnostics: { ...d, submission: "unknown", lookup: "failed" } })),
    ).toMatchObject({ state: "unavailable", reason: "rpc_unreachable", txHash: HASH });
  });

  it("maps stale_rpc to unavailable, and unknown with/without a hash", () => {
    expect(txLifecycleFromResult(fail("stale_rpc"))).toMatchObject({ state: "unavailable", reason: "rpc_stale" });
    expect(txLifecycleFromResult(fail("unknown")).state).toBe("unavailable");
    expect(txLifecycleFromResult(fail("unknown", { txHash: "" })).state).toBe("not_applied");
  });
});

describe("txLifecycleFromLookup", () => {
  it("treats a missing record as pending, never as cancellation or failure", () => {
    const state = txLifecycleFromLookup({ ok: true, value: { status: "not_found", txHash: HASH } });
    expect(state).toMatchObject({ state: "pending", reason: "not_found", resumable: true });
  });

  it("resolves not_found to not_applied only once the time bound has passed", () => {
    const value = { status: "not_found", txHash: HASH, latestLedgerCloseTime: 2_000 } as const;
    expect(txLifecycleFromLookup({ ok: true, value }, { validUntil: 1_000 }).state).toBe("not_applied");
    expect(txLifecycleFromLookup({ ok: true, value }, { validUntil: 3_000 }).state).toBe("pending");
  });

  it("maps an RPC outage or a cancelled lookup to unavailable", () => {
    expect(txLifecycleFromLookup({ ok: false, error: "down" }, { txHash: HASH })).toMatchObject({
      state: "unavailable",
      reason: "rpc_unreachable",
      txHash: HASH,
    });
    expect(txLifecycleFromLookup({ ok: false, error: "x", cancelled: "timeout" }).state).toBe("unavailable");
  });

  it("maps success and failed records", () => {
    expect(txLifecycleFromLookup({ ok: true, value: { status: "success", txHash: HASH, ledger: 9 } }).state).toBe(
      "confirmed",
    );
    expect(txLifecycleFromLookup({ ok: true, value: { status: "failed", txHash: HASH, ledger: 9 } })).toMatchObject({
      state: "failed",
      ledger: 9,
    });
  });
});
