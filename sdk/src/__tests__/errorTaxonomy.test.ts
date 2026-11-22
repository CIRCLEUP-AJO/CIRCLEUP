/**
 * Stable SDK error taxonomy (issue #901): every known failure shape maps to a
 * stable code, unknown shapes fall back to "unknown", and provider text never
 * reaches the public fields.
 */

import { describe, it, expect } from "vitest";
import {
  SdkError,
  classifySdkError,
  classifyTxFailure,
  classifyWalletFailure,
  isSdkError,
} from "../errors";
import type { SdkErrorCode } from "../errors";
import { IndexerError } from "../client";
import { RpcReadCancelledError } from "../rpcRetry";
import type { TxErrorCode, TxFailure } from "../types";
import type { WalletFailureReason } from "../walletAdapter";

const SECRET = "S" + "A".repeat(55);
const HASH = "cd".repeat(32);

const failure = (errorCode: TxErrorCode, extra: Partial<TxFailure> = {}): TxFailure => ({
  success: false,
  txHash: HASH,
  errorMessage: `provider said ${SECRET}`,
  errorCode,
  ...extra,
});

describe("classifyTxFailure", () => {
  const expected: Record<TxErrorCode, [SdkErrorCode, "safe" | "after_lookup" | "never"]> = {
    invalid_argument: ["invalid_input", "never"],
    network_mismatch: ["network_mismatch", "never"],
    account_not_found: ["account_not_found", "never"],
    simulation_failed: ["simulation_failed", "never"],
    stale_state: ["stale_state", "never"],
    network_error: ["transport", "safe"],
    try_again_later: ["throttled", "safe"],
    tx_rejected: ["tx_rejected", "safe"],
    tx_expired: ["tx_expired", "safe"],
    outcome_unknown: ["send_ambiguous", "after_lookup"],
    timeout: ["poll_timeout", "after_lookup"],
    stale_rpc: ["rpc_stale", "after_lookup"],
    tx_failed: ["on_chain_failed", "never"],
    unknown: ["unknown", "after_lookup"],
  };

  for (const [code, [sdkCode, retry]] of Object.entries(expected) as [TxErrorCode, [SdkErrorCode, string]][]) {
    it(`maps ${code} → ${sdkCode} (${retry}) without copying provider text`, () => {
      const info = classifyTxFailure(failure(code));
      expect(info.code).toBe(sdkCode);
      expect(info.retry).toBe(retry);
      expect(info.retryable).toBe(retry === "safe");
      expect(JSON.stringify(info)).not.toContain(SECRET);
    });
  }

  it("keeps the hash for ambiguous outcomes, from diagnostics when needed", () => {
    const info = classifyTxFailure(
      failure("outcome_unknown", {
        txHash: "",
        diagnostics: { txHash: HASH, submission: "unknown", sendAttempts: 1, lookup: "failed" },
      }),
    );
    expect(info.txHash).toBe(HASH);
  });

  it("prefers contract_error when a numeric contract error was decoded", () => {
    const info = classifyTxFailure(
      failure("simulation_failed", {
        txHash: "",
        contractError: { contract: "circle", method: "join", code: 3, category: "state", message: "x" },
      }),
    );
    expect(info.code).toBe("contract_error");
  });

  it("treats an unrecognised errorCode as unknown, never as a specific category", () => {
    const info = classifyTxFailure(failure("brand_new_code" as TxErrorCode, { txHash: "" }));
    expect(info).toMatchObject({ code: "unknown", stage: "unknown", retry: "never" });
  });

  it("an unknown code with a hash still advises a lookup before resubmitting", () => {
    expect(classifyTxFailure(failure("brand_new_code" as TxErrorCode)).retry).toBe("after_lookup");
  });

  it("drops a malformed hash", () => {
    expect(classifyTxFailure(failure("timeout", { txHash: SECRET })).txHash).toBeUndefined();
  });
});

describe("classifyWalletFailure", () => {
  const cases: Record<WalletFailureReason, SdkErrorCode> = {
    user_rejected: "wallet_rejected",
    network_mismatch: "network_mismatch",
    not_available: "wallet_unavailable",
    not_connected: "wallet_unavailable",
    unsupported_capability: "wallet_unavailable",
    account_mismatch: "wallet_unavailable",
    provider_error: "wallet_error",
  };
  for (const [reason, code] of Object.entries(cases) as [WalletFailureReason, SdkErrorCode][]) {
    it(`maps ${reason} → ${code}, never retried automatically`, () => {
      const info = classifyWalletFailure({ ok: false, reason, message: SECRET });
      expect(info).toMatchObject({ stage: "wallet", code, retry: "never", retryable: false });
      expect(info.message).not.toContain(SECRET);
    });
  }
});

describe("classifySdkError — thrown provider errors", () => {
  const withProps = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

  it("classifies throttling and transient transport errors on reads as safe to retry", () => {
    expect(classifySdkError(withProps("Too Many Requests", { status: 429 }))).toMatchObject({
      code: "throttled",
      retry: "safe",
    });
    expect(classifySdkError(new TypeError("fetch failed"), "simulation")).toMatchObject({
      code: "transport",
      stage: "simulation",
      retry: "safe",
    });
  });

  it("never advises a blind retry for a transport error during submission", () => {
    expect(classifySdkError(new Error("socket hang up"), "submission").retry).toBe("after_lookup");
  });

  it("classifies local cancellation", () => {
    expect(classifySdkError(new RpcReadCancelledError("getTransaction", "timeout", 10)).code).toBe("cancelled");
  });

  it("classifies indexer failures", () => {
    expect(classifySdkError(new IndexerError("x", 503, "http://i")).code).toBe("indexer_unavailable");
    expect(classifySdkError(new IndexerError("x", 404, "http://i")).code).toBe("indexer_response");
    expect(classifySdkError(new IndexerError("x", 200, "http://i", "schema")).code).toBe("indexer_response");
    expect(classifySdkError(new IndexerError("x", 0, "http://i", "aborted")).code).toBe("cancelled");
  });

  it.each([
    new Error(`unexpected ${SECRET}`),
    { weird: SECRET },
    SECRET,
    42,
    null,
    undefined,
  ])("classifies %s as unknown without copying it", (err) => {
    const info = classifySdkError(err);
    expect(info.code).toBe("unknown");
    expect(info.retryable).toBe(false);
    expect(JSON.stringify(info)).not.toContain(SECRET);
  });

  it("recognises TxFailure and WalletFailure shapes", () => {
    expect(classifySdkError(failure("tx_failed")).code).toBe("on_chain_failed");
    expect(classifySdkError({ ok: false, reason: "user_rejected", message: "no" }).code).toBe("wallet_rejected");
  });
});

describe("SdkError", () => {
  it("carries the stable fields and keeps the raw cause out of JSON", () => {
    const raw = new Error(`rpc body ${SECRET}`);
    const err = SdkError.from(raw, "simulation");
    expect(isSdkError(err)).toBe(true);
    expect(err.code).toBe("unknown");
    expect(err.message).not.toContain(SECRET);
    expect((err as { cause?: unknown }).cause).toBe(raw);
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect(SdkError.from(err)).toBe(err);
    expect(classifySdkError(err)).toBe(err.info);
  });
});
