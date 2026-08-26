/**
 * Tests for transaction correlation metadata and structured tx logging
 * (issue #345).
 *
 * Two concerns are covered:
 *
 *   1. `sanitizeTxMetadata` — the security boundary that strips secrets and
 *      signed payloads. Pure function, tested directly.
 *
 *   2. The write path (`buildAndSend`) — that sanitised metadata is echoed onto
 *      both success and failure results, that the opt-in `TxLogger` receives the
 *      lifecycle events (`simulated` → `submitted` → `confirmed` | `failed`)
 *      carrying only log-safe fields, and that correlation survives across
 *      retried attempts.
 *
 * No real RPC calls are made — every network method is stubbed via vi.spyOn on
 * the prototype, mirroring buildAndSend.test.ts.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { SorobanRpc, xdr } from "@stellar/stellar-sdk";
import {
  CircleUpClient,
  CircleClient,
  type PollConfig,
  type WriteOptions,
  type TxLogEvent,
} from "../client";
import { sanitizeTxMetadata, isTxSuccess, isTxFailure } from "../types";
import {
  CIRCLE_ADDR,
  FAST_POLL,
  MEMBER_A,
  MOCK_ACCOUNT,
  SDK_CONFIG,
  simulationError,
  simulationSuccess,
  testKeypair,
} from "./fixtures";

// ─── sanitizeTxMetadata ─────────────────────────────────────────────────────

describe("sanitizeTxMetadata", () => {
  it("keeps flat scalar values (string, number, boolean, null)", () => {
    const out = sanitizeTxMetadata({
      operation: "join-circle",
      attempt: 2,
      retried: true,
      note: null,
    });
    expect(out).toEqual({
      operation: "join-circle",
      attempt: 2,
      retried: true,
      note: null,
    });
  });

  it("drops keys that name a secret or signed payload", () => {
    const out = sanitizeTxMetadata({
      operation: "contribute",
      sourceSecret: "should-be-dropped",
      seed: "nope",
      signedXdr: "AAAA...",
      apiKey: "k",
      api_key: "k",
      signature: "sig",
      privateNote: "x",
      passphrase: "p",
    });
    expect(out).toEqual({ operation: "contribute" });
  });

  it("drops a Stellar secret seed even under an innocuous key name", () => {
    // A real S... secret strkey stored under a harmless-looking key must still
    // be stripped by value.
    const secret = testKeypair(11).secret();
    expect(secret).toMatch(/^S[A-Z2-7]{55}$/);
    const out = sanitizeTxMetadata({ ref: secret, operation: "payout" });
    expect(out).toEqual({ operation: "payout" });
  });

  it("drops over-long strings (likely signed XDR / base64 blobs)", () => {
    const out = sanitizeTxMetadata({
      operation: "close",
      blob: "x".repeat(513),
    });
    expect(out).toEqual({ operation: "close" });
  });

  it("drops non-scalar values (object, array, function, bigint, symbol, undefined)", () => {
    const out = sanitizeTxMetadata({
      operation: "join",
      nested: { a: 1 },
      list: [1, 2, 3],
      fn: () => 0,
      big: 10n,
      sym: Symbol("s"),
      missing: undefined,
    });
    expect(out).toEqual({ operation: "join" });
  });

  it("drops non-finite numbers", () => {
    const out = sanitizeTxMetadata({ a: NaN, b: Infinity, c: -Infinity, d: 1 });
    expect(out).toEqual({ d: 1 });
  });

  it("returns undefined for non-object input", () => {
    expect(sanitizeTxMetadata(undefined)).toBeUndefined();
    expect(sanitizeTxMetadata(null)).toBeUndefined();
    expect(sanitizeTxMetadata("str")).toBeUndefined();
    expect(sanitizeTxMetadata(42)).toBeUndefined();
    expect(sanitizeTxMetadata([1, 2])).toBeUndefined();
  });

  it("returns undefined when nothing survives (never an empty object)", () => {
    expect(sanitizeTxMetadata({})).toBeUndefined();
    expect(sanitizeTxMetadata({ secret: "x", nested: {} })).toBeUndefined();
  });

  it("caps the number of retained keys at 32", () => {
    const input: Record<string, number> = {};
    for (let i = 0; i < 50; i++) input[`k${i}`] = i;
    const out = sanitizeTxMetadata(input)!;
    expect(Object.keys(out)).toHaveLength(32);
  });

  it("does not mutate its input and returns a frozen object", () => {
    const input = { operation: "join", secret: "drop-me" };
    const out = sanitizeTxMetadata(input)!;
    expect(input).toEqual({ operation: "join", secret: "drop-me" }); // untouched
    expect(Object.isFrozen(out)).toBe(true);
  });
});

// ─── Write-path harness ─────────────────────────────────────────────────────

const CONTRACT_ID = CIRCLE_ADDR;
const METHOD = "join";

/** Subclass exposing the protected write path with a metadata option. */
class TestClient extends CircleUpClient {
  callBuildAndSend(options?: WriteOptions, method: string = METHOD) {
    return this.buildAndSend(MEMBER_A, CONTRACT_ID, method, [], options);
  }
}

function makeClient(poll: PollConfig = FAST_POLL) {
  return new TestClient(SDK_CONFIG, poll);
}

function mockSendOk(hash = "TX_META") {
  return { status: "PENDING", hash } as any;
}

function mockGetTxSuccess(ledger = 77, returnValue?: xdr.ScVal) {
  return {
    status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    ledger,
    returnValue,
  } as any;
}

function mockGetTxFailed() {
  return { status: SorobanRpc.Api.GetTransactionStatus.FAILED } as any;
}

/** Stub every network method for a transaction that confirms successfully. */
function stubHappyPath(hash = "TX_META", ledger = 77) {
  vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(
    MOCK_ACCOUNT,
  );
  vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
    simulationSuccess(),
  );
  vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue(
    mockSendOk(hash),
  );
  vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
    mockGetTxSuccess(ledger),
  );
}

afterEach(() => vi.restoreAllMocks());

// ─── Metadata echoed onto results ───────────────────────────────────────────

describe("buildAndSend — metadata on results", () => {
  it("echoes sanitised metadata onto a successful result", async () => {
    stubHappyPath();
    const result = await makeClient().callBuildAndSend({
      metadata: { operation: "join-circle", uiRequestId: "req_8a1f" },
    });

    expect(isTxSuccess(result)).toBe(true);
    expect(result.metadata).toEqual({
      operation: "join-circle",
      uiRequestId: "req_8a1f",
    });
  });

  it("echoes metadata onto a failure result too, so failed attempts still correlate", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("404 not found"),
    );

    const result = await makeClient().callBuildAndSend({
      metadata: { operation: "join-circle" },
    });

    expect(isTxFailure(result)).toBe(true);
    expect(result.metadata).toEqual({ operation: "join-circle" });
  });

  it("strips secrets from the metadata it echoes back", async () => {
    stubHappyPath();
    const secret = testKeypair(12).secret();
    const result = await makeClient().callBuildAndSend({
      metadata: { operation: "payout", sourceSecret: secret, ref: secret },
    });

    // Dropped by key name (sourceSecret) and by value (ref = S... seed).
    expect(result.metadata).toEqual({ operation: "payout" });
  });

  it("attaches no metadata field when none is supplied", async () => {
    stubHappyPath();
    const result = await makeClient().callBuildAndSend();
    expect(result.metadata).toBeUndefined();
    expect("metadata" in result).toBe(false);
  });

  it("attaches no metadata field when everything is stripped", async () => {
    stubHappyPath();
    const result = await makeClient().callBuildAndSend({
      metadata: { secret: "x" },
    });
    expect(result.metadata).toBeUndefined();
  });
});

// ─── Structured tx logging ──────────────────────────────────────────────────

describe("buildAndSend — structured logging", () => {
  it("emits simulated → submitted → confirmed in order on success", async () => {
    stubHappyPath("TX_LOG", 88);
    const events: TxLogEvent[] = [];
    const client = makeClient().setTxLogger((e) => events.push(e));

    await (client as TestClient).callBuildAndSend({
      metadata: { operation: "join-circle" },
    });

    expect(events.map((e) => e.phase)).toEqual([
      "simulated",
      "submitted",
      "confirmed",
    ]);
    // The hash appears from `submitted` onward; the ledger only on `confirmed`.
    expect(events[0].txHash).toBeUndefined();
    expect(events[1].txHash).toBe("TX_LOG");
    expect(events[2].txHash).toBe("TX_LOG");
    expect(events[2].ledger).toBe(88);
    // Every event carries the contract/method context and the metadata.
    for (const e of events) {
      expect(e.contractId).toBe(CONTRACT_ID);
      expect(e.method).toBe(METHOD);
      expect(e.ctx).toBe(`${CONTRACT_ID}.${METHOD}`);
      expect(e.metadata).toEqual({ operation: "join-circle" });
    }
  });

  it("emits simulated → submitted → failed when the tx confirms as FAILED", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockResolvedValue(
      MOCK_ACCOUNT,
    );
    vi.spyOn(SorobanRpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      simulationSuccess(),
    );
    vi.spyOn(SorobanRpc.Server.prototype, "sendTransaction").mockResolvedValue(
      mockSendOk("TX_FAIL"),
    );
    vi.spyOn(SorobanRpc.Server.prototype, "getTransaction").mockResolvedValue(
      mockGetTxFailed(),
    );

    const events: TxLogEvent[] = [];
    const client = makeClient().setTxLogger((e) => events.push(e));
    await (client as TestClient).callBuildAndSend();

    expect(events.map((e) => e.phase)).toEqual([
      "simulated",
      "submitted",
      "failed",
    ]);
    const failed = events[2];
    expect(failed.errorCode).toBe("tx_failed");
    expect(failed.txHash).toBe("TX_FAIL");
  });

  it("emits only a terminal 'failed' event when the failure precedes submission", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(
      new Error("404 not found"),
    );

    const events: TxLogEvent[] = [];
    const client = makeClient().setTxLogger((e) => events.push(e));
    await (client as TestClient).callBuildAndSend();

    expect(events.map((e) => e.phase)).toEqual(["failed"]);
    expect(events[0].errorCode).toBe("account_not_found");
    // No hash exists for a pre-submission failure.
    expect(events[0].txHash).toBeUndefined();
  });

  it("never hands a secret to the logger", async () => {
    stubHappyPath();
    const secret = testKeypair(11).secret();
    const events: TxLogEvent[] = [];
    const client = makeClient().setTxLogger((e) => events.push(e));

    await (client as TestClient).callBuildAndSend({
      metadata: { operation: "join", sourceSecret: secret },
    });

    for (const e of events) {
      expect(e.metadata).toEqual({ operation: "join" });
      // The raw event object must not contain the secret anywhere.
      expect(JSON.stringify(e)).not.toContain(secret);
    }
  });

  it("does not emit anything when no logger is registered", async () => {
    stubHappyPath();
    // No setTxLogger call — the default path must be silent and must not throw.
    const result = await makeClient().callBuildAndSend();
    expect(isTxSuccess(result)).toBe(true);
  });

  it("a throwing logger never changes the transaction result", async () => {
    stubHappyPath("TX_SAFE", 99);
    const client = makeClient().setTxLogger(() => {
      throw new Error("logger blew up");
    });

    const result = await (client as TestClient).callBuildAndSend();

    expect(isTxSuccess(result)).toBe(true);
    if (isTxSuccess(result)) {
      expect(result.txHash).toBe("TX_SAFE");
      expect(result.ledger).toBe(99);
    }
  });

  it("setTxLogger(undefined) detaches a previously registered logger", async () => {
    stubHappyPath();
    const events: TxLogEvent[] = [];
    const client = makeClient().setTxLogger((e) => events.push(e));
    client.setTxLogger(undefined);

    await (client as TestClient).callBuildAndSend();
    expect(events).toHaveLength(0);
  });
});

// ─── Retry correlation ──────────────────────────────────────────────────────

describe("correlation across retried attempts", () => {
  it("preserves the same operation id verbatim on each attempt's result", async () => {
    stubHappyPath();
    const client = makeClient();
    const metadata = { operation: "join-circle", uiRequestId: "req_c0ffee" };

    // Two independent submission attempts of the same logical UI action.
    const first = await client.callBuildAndSend({ metadata });
    const second = await client.callBuildAndSend({ metadata });

    // Correlation is a label, not an idempotency key: reusing it is exactly how
    // both attempts are tied back to the one UI action in a log aggregator.
    expect(first.metadata).toEqual(metadata);
    expect(second.metadata).toEqual(metadata);
  });
});

// ─── End-to-end threading through a mutation method ─────────────────────────

describe("mutation methods forward WriteOptions", () => {
  it("CircleClient.join echoes metadata and drives the logger", async () => {
    stubHappyPath("TX_JOIN", 55);
    const events: TxLogEvent[] = [];
    const client = new CircleClient(SDK_CONFIG, CIRCLE_ADDR, 0, FAST_POLL);
    client.setTxLogger((e) => events.push(e));

    const result = await client.join(MEMBER_A, {
      metadata: { operation: "ui-join", secret: "should-be-dropped" },
    });

    expect(isTxSuccess(result)).toBe(true);
    expect(result.metadata).toEqual({ operation: "ui-join" });
    expect(events.map((e) => e.phase)).toEqual([
      "simulated",
      "submitted",
      "confirmed",
    ]);
    expect(events[2].method).toBe("join");
  });
});
