/**
 * Tests for the TxResult discriminated union and its type-guards.
 *
 * These are pure unit tests — no RPC or Stellar SDK calls required.
 */

import { describe, it, expect } from "vitest";
import {
  isTxSuccess,
  isTxFailure,
  type TxResult,
  type TxSuccess,
  type TxFailure,
  type TxErrorCode,
} from "../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSuccess(txHash = "DEADBEEF", ledger = 1234): TxSuccess {
  return { success: true, txHash, ledger };
}

function makeFailure(
  errorMessage = "something went wrong",
  txHash = "",
  errorCode: TxErrorCode = "unknown",
): TxFailure {
  return { success: false, txHash, errorMessage, errorCode };
}

// ─── isTxSuccess ──────────────────────────────────────────────────────────────

describe("isTxSuccess", () => {
  it("returns true for a TxSuccess", () => {
    expect(isTxSuccess(makeSuccess())).toBe(true);
  });

  it("returns false for a TxFailure", () => {
    expect(isTxSuccess(makeFailure())).toBe(false);
  });

  it("narrows type so ledger is accessible without casting", () => {
    const result: TxResult = makeSuccess("abc123", 42);
    if (isTxSuccess(result)) {
      // TypeScript would error here if narrowing didn't work
      expect(result.ledger).toBe(42);
      expect(result.txHash).toBe("abc123");
    } else {
      throw new Error("Should have been a success");
    }
  });

  it("success result carries the exact txHash provided", () => {
    const hash = "STELLAR_TX_HASH_XYZ";
    expect(makeSuccess(hash).txHash).toBe(hash);
  });

  it("success result carries the exact ledger provided", () => {
    expect(makeSuccess("x", 9999).ledger).toBe(9999);
  });
});

// ─── isTxFailure ─────────────────────────────────────────────────────────────

describe("isTxFailure", () => {
  it("returns true for a TxFailure", () => {
    expect(isTxFailure(makeFailure())).toBe(true);
  });

  it("returns false for a TxSuccess", () => {
    expect(isTxFailure(makeSuccess())).toBe(false);
  });

  it("narrows type so errorMessage is accessible without casting", () => {
    const result: TxResult = makeFailure("round deadline passed");
    if (isTxFailure(result)) {
      expect(result.errorMessage).toBe("round deadline passed");
    } else {
      throw new Error("Should have been a failure");
    }
  });

  it("failure with pre-submission error has empty txHash", () => {
    const result = makeFailure("simulation error", "");
    expect(result.txHash).toBe("");
    expect(result.errorMessage).toBe("simulation error");
  });

  it("failure with on-chain rejection carries the hash", () => {
    const hash = "CONFIRMED_BUT_FAILED_HASH";
    const result = makeFailure("Transaction was included in a ledger but marked as failed.", hash);
    expect(result.txHash).toBe(hash);
  });
});

// ─── errorCode field ─────────────────────────────────────────────────────────

describe("TxFailure.errorCode", () => {
  it("carries the errorCode provided at construction", () => {
    const codes: TxErrorCode[] = [
      "account_not_found",
      "simulation_failed",
      "network_error",
      "tx_rejected",
      "tx_failed",
      "timeout",
      "unknown",
    ];
    for (const code of codes) {
      const f = makeFailure("msg", "", code);
      expect(f.errorCode).toBe(code);
    }
  });

  it("narrows to errorCode when isTxFailure returns true", () => {
    const result: TxResult = makeFailure("account not found", "", "account_not_found");
    if (isTxFailure(result)) {
      // TypeScript knows errorCode is TxErrorCode here without casting
      const code: TxErrorCode = result.errorCode;
      expect(code).toBe("account_not_found");
    } else {
      throw new Error("Should have been a failure");
    }
  });

  it("TxSuccess does NOT expose errorCode", () => {
    const result = makeSuccess();
    expect((result as any).errorCode).toBeUndefined();
  });

  it("defaults to 'unknown' for generic failures", () => {
    expect(makeFailure().errorCode).toBe("unknown");
  });
});

// ─── Exhaustive discrimination ────────────────────────────────────────────────

describe("TxResult discriminated union", () => {
  it("can be fully discriminated in a switch/if without a default fallthrough", () => {
    function describe(r: TxResult): string {
      if (r.success) {
        return `ok:${r.ledger}`;
      } else {
        return `err:${r.errorCode}:${r.errorMessage}`;
      }
    }

    expect(describe(makeSuccess("h", 100))).toBe("ok:100");
    expect(describe(makeFailure("timeout", "", "timeout"))).toBe("err:timeout:timeout");
  });

  it("TxSuccess does NOT expose an errorMessage property", () => {
    const result = makeSuccess();
    expect((result as any).errorMessage).toBeUndefined();
  });

  it("TxFailure does NOT expose a ledger property", () => {
    const result = makeFailure();
    expect((result as any).ledger).toBeUndefined();
  });

  it("both variants carry txHash", () => {
    const success = makeSuccess("hash_a");
    const failure = makeFailure("oops", "hash_b");
    expect(success.txHash).toBe("hash_a");
    expect(failure.txHash).toBe("hash_b");
  });
});
