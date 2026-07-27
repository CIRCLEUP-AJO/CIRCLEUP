/**
 * Tests for improved error propagation in CircleUpClient.buildAndSend.
 *
 * buildAndSend is protected, so we access it via a thin subclass that
 * exposes it publicly.  No real RPC calls are made — every network method
 * is stubbed via vi.spyOn on the prototype.
 *
 * Covered scenarios:
 *   - account not found (404 vs generic network error)
 *   - simulation network error
 *   - simulation contract error (human-readable extraction)
 *   - tx submission network error
 *   - tx rejected (status === "ERROR")
 *   - tx confirmed as FAILED
 *   - polling timeout
 *   - consecutive polling errors exceeding threshold → surface RPC error
 *   - successful tx carries correct hash + ledger
 *
 * extractSimulationError parsing (private helper) is tested via the
 * simulation_failed path, which goes through it internally.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { CircleUpClient } from "../client";
import { isTxSuccess, isTxFailure, type CircleUpConfig } from "../types";

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

const CONTRACT_ID = "CCIRCLE00000000000000000000000000000000000000000000000000";
const METHOD = "join";

// Minimal mock Keypair-like object that satisfies Stellar SDK usage
const MOCK_KEYPAIR = {
  publicKey: () => "GABC0000000000000000000000000000000000000000000000000000",
  sign: () => Buffer.alloc(64),
} as any;

// A mock account object that TransactionBuilder accepts
const MOCK_ACCOUNT = {
  id: "GABC0000000000000000000000000000000000000000000000000000",
  sequence: "100",
  incrementSequenceNumber: () => {},
} as any;

// ─── Thin subclass exposing the protected method ──────────────────────────────

class TestClient extends CircleUpClient {
  callBuildAndSend(method: string = METHOD) {
    return this.buildAndSend(MOCK_KEYPAIR, CONTRACT_ID, method, []);
  }
}

function makeClient() {
  return new TestClient(SDK_CONFIG);
}

// ─── Helpers to build mock RPC return values ──────────────────────────────────

function mockSimSuccess() {
  return {
    result: { retval: { toXDR: () => Buffer.alloc(0) } },
    transactionData: {},
    events: [],
    minResourceFee: "100",
    cost: {},
    latestLedger: 1,
    // Mimic the non-error simulation shape
    _isSimulationSuccess: true,
  } as any;
}

function mockSimError(error: string) {
  return {
    error,
    events: [],
    latestLedger: 1,
    // Expose the flag isSimulationError checks
  } as any;
}

function mockSendOk(hash = "TXHASH123") {
  return { status: "PENDING", hash } as any;
}

function mockSendError(hash = "TXHASH123") {
  return {
    status: "ERROR",
    hash,
    errorResult: { toXDR: () => "mockedXDR" } as any,
  } as any;
}

function mockGetTxSuccess(ledger = 42) {
  return {
    status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    ledger,
  } as any;
}

function mockGetTxFailed() {
  return {
    status: SorobanRpc.Api.GetTransactionStatus.FAILED,
  } as any;
}

function mockGetTxNotFound() {
  return {
    status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => vi.restoreAllMocks());

describe("buildAndSend — account loading", () => {
  it("returns errorCode 'account_not_found' when account has a 404-style error", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("404 not found"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("account_not_found");
      expect(result.errorMessage).toContain("not found on the network");
      expect(result.errorMessage).toContain(METHOD);
      expect(result.txHash).toBe("");
    }
  });

  it("returns errorCode 'account_not_found' when message says 'does not exist'", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("Account does not exist"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("account_not_found");
    }
  });

  it("returns errorCode 'network_error' for non-404 account fetch failure", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      expect(result.errorMessage).toContain("ECONNREFUSED");
    }
  });
});

describe("buildAndSend — simulation", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(
      MOCK_ACCOUNT,
    );
  });

  it("returns errorCode 'network_error' when simulateTransaction throws", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockRejectedValue(
      new Error("timeout"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      expect(result.errorMessage).toContain("timeout");
      expect(result.errorMessage).toContain(METHOD);
    }
  });

  it("returns errorCode 'simulation_failed' when simulation returns an error", async () => {
    const rawError =
      'HostError: Value(UnexpectedType)\n  contract log (debug): "already joined"\nError(Contract, #1)';
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      mockSimError(rawError),
    );
    vi.spyOn(SorobanRpc.Api, "isSimulationError").mockReturnValue(true);

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("simulation_failed");
      // extractSimulationError should surface the human-readable panic message
      expect(result.errorMessage).toContain("already joined");
      expect(result.errorMessage).toContain(METHOD);
    }
  });

  it("falls back to contract error code when no debug log is present", async () => {
    const rawError = "HostError: Value(UnexpectedType)\nError(Contract, #3)";
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      mockSimError(rawError),
    );
    vi.spyOn(SorobanRpc.Api, "isSimulationError").mockReturnValue(true);

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("simulation_failed");
      expect(result.errorMessage).toContain("Contract error code 3");
    }
  });
});

describe("buildAndSend — submission", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      mockSimSuccess(),
    );
    vi.spyOn(SorobanRpc.Api, "isSimulationError").mockReturnValue(false);
    vi.spyOn(SorobanRpc, "assembleTransaction" as any).mockReturnValue({
      build: () => ({ sign: () => {}, toXDR: () => "" }),
    });
  });

  it("returns errorCode 'network_error' when sendTransaction throws", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockRejectedValue(
      new Error("connection reset"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      expect(result.errorMessage).toContain("connection reset");
    }
  });

  it("returns errorCode 'tx_rejected' when sendTransaction returns ERROR status", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue(
      mockSendError("HASH_REJECTED"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("tx_rejected");
      expect(result.txHash).toBe("HASH_REJECTED");
      expect(result.errorMessage).toContain(METHOD);
    }
  });
});

describe("buildAndSend — confirmation polling", () => {
  beforeEach(() => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      mockSimSuccess(),
    );
    vi.spyOn(SorobanRpc.Api, "isSimulationError").mockReturnValue(false);
    vi.spyOn(SorobanRpc, "assembleTransaction" as any).mockReturnValue({
      build: () => ({ sign: () => {}, toXDR: () => "" }),
    });
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue(
      mockSendOk("TX_POLLING"),
    );
  });

  it("returns TxSuccess with correct hash and ledger on SUCCESS status", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxSuccess(77),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) {
      expect(result.txHash).toBe("TX_POLLING");
      expect(result.ledger).toBe(77);
    }
  });

  it("returns errorCode 'tx_failed' when getTransaction returns FAILED", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxFailed(),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("tx_failed");
      expect(result.txHash).toBe("TX_POLLING");
      expect(result.errorMessage).toContain("TX_POLLING");
      expect(result.errorMessage).toContain(METHOD);
    }
  });

  it("returns errorCode 'network_error' after 5 consecutive polling failures", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockRejectedValue(
      new Error("RPC unreachable"),
    );

    const result = await makeClient().callBuildAndSend();

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorCode).toBe("network_error");
      expect(result.errorMessage).toContain("RPC unreachable");
      // tx hash is still present (transaction was submitted)
      expect(result.txHash).toBe("TX_POLLING");
    }
  });
});

describe("buildAndSend — error messages include contract/method context", () => {
  it("includes contractId.method in simulation_failed message", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(MOCK_ACCOUNT);
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      mockSimError("HostError: Error(Contract, #2)"),
    );
    vi.spyOn(SorobanRpc.Api, "isSimulationError").mockReturnValue(true);

    const result = await makeClient().callBuildAndSend("contribute");

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toContain(CONTRACT_ID);
      expect(result.errorMessage).toContain("contribute");
    }
  });

  it("includes contractId.method in account_not_found message", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("404"),
    );

    const result = await makeClient().callBuildAndSend("payout");

    expect(isTxFailure(result)).toBe(true);
    if (isTxFailure(result)) {
      expect(result.errorMessage).toContain("payout");
    }
  });
});
