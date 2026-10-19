import { describe, it, expect } from "vitest";
import {
  parseRpcGetEventsResponse,
  parseRpcSimulateTransactionResponse,
  parseRpcSendTransactionResponse,
  parseRpcGetTransactionResponse,
  parseRpcGetLatestLedgerResponse,
  RpcParsingError,
} from "../rpcSchema";
import {
  V21_RPC_FIXTURES,
  V22_RPC_FIXTURES,
  SANITIZED_CONTRACT_ID,
  SANITIZED_ACCOUNT_ID,
  SANITIZED_TX_HASH,
} from "../fixtures/versionedRpcFixtures";
import { summarizeSimulation } from "../client";

describe("Soroban RPC versioned fixture parsing", () => {
  describe("Protocol 21 (v21)", () => {
    it("parses getEvents success response", () => {
      const parsed = parseRpcGetEventsResponse(V21_RPC_FIXTURES.getEvents.success);
      expect(parsed.latestLedger).toBe(10500);
      expect(parsed.events.length).toBe(1);
      expect(parsed.events[0].contractId).toBe(SANITIZED_CONTRACT_ID);
      expect(parsed.events[0].id).toBe("000000004509715456-0000000001");
      expect(parsed.events[0].pagingToken).toBe("000000004509715456-0000000001");
    });

    it("parses getEvents empty response", () => {
      const parsed = parseRpcGetEventsResponse(V21_RPC_FIXTURES.getEvents.empty);
      expect(parsed.latestLedger).toBe(10500);
      expect(parsed.events).toEqual([]);
    });

    it("parses simulateTransaction success response", () => {
      const parsed = parseRpcSimulateTransactionResponse(V21_RPC_FIXTURES.simulateTransaction.success);
      expect(parsed.latestLedger).toBe(10500);
      expect(parsed.minResourceFee).toBe("150000");
      expect(parsed.cost?.cpuInsns).toBe("1250000");
      expect(parsed.cost?.memBytes).toBe("524288");
      expect(parsed.results?.length).toBe(1);
    });

    it("parses simulateTransaction with restore preamble", () => {
      const parsed = parseRpcSimulateTransactionResponse(V21_RPC_FIXTURES.simulateTransaction.withRestorePreamble);
      expect(parsed.latestLedger).toBe(10500);
      expect(parsed.restorePreamble?.minResourceFee).toBe("85000");
    });

    it("parses simulateTransaction failure response", () => {
      const parsed = parseRpcSimulateTransactionResponse(V21_RPC_FIXTURES.simulateTransaction.failure);
      expect(parsed.latestLedger).toBe(10500);
      expect(parsed.error).toContain("HostError");
    });

    it("parses sendTransaction statuses", () => {
      const pending = parseRpcSendTransactionResponse(V21_RPC_FIXTURES.sendTransaction.pending);
      expect(pending.status).toBe("PENDING");
      expect(pending.hash).toBe(SANITIZED_TX_HASH);

      const dup = parseRpcSendTransactionResponse(V21_RPC_FIXTURES.sendTransaction.duplicate);
      expect(dup.status).toBe("DUPLICATE");

      const retry = parseRpcSendTransactionResponse(V21_RPC_FIXTURES.sendTransaction.tryAgainLater);
      expect(retry.status).toBe("TRY_AGAIN_LATER");

      const err = parseRpcSendTransactionResponse(V21_RPC_FIXTURES.sendTransaction.error);
      expect(err.status).toBe("ERROR");
    });

    it("parses getTransaction outcomes", () => {
      const success = parseRpcGetTransactionResponse(V21_RPC_FIXTURES.getTransaction.success);
      expect(success.status).toBe("SUCCESS");
      expect(success.ledger).toBe(10501);
      expect(success.latestLedger).toBe(10505);

      const notFound = parseRpcGetTransactionResponse(V21_RPC_FIXTURES.getTransaction.notFound);
      expect(notFound.status).toBe("NOT_FOUND");
      expect(notFound.ledger).toBeUndefined();

      const failed = parseRpcGetTransactionResponse(V21_RPC_FIXTURES.getTransaction.failed);
      expect(failed.status).toBe("FAILED");
      expect(failed.ledger).toBe(10502);
    });

    it("parses getLatestLedger response", () => {
      const ledger = parseRpcGetLatestLedgerResponse(V21_RPC_FIXTURES.getLatestLedger.success);
      expect(ledger.protocolVersion).toBe(21);
      expect(ledger.sequence).toBe(10500);
      expect(ledger.id).toBeDefined();
    });
  });

  describe("Protocol 22+ (v22)", () => {
    it("parses getEvents with v22+ extended metadata", () => {
      const parsed = parseRpcGetEventsResponse(V22_RPC_FIXTURES.getEvents.success);
      expect(parsed.latestLedger).toBe(25000);
      expect(parsed.events.length).toBe(1);
      expect(parsed.events[0].ledger).toBe(25000);
      expect(parsed.events[0].inSuccessfulContractCall).toBe(true);
    });

    it("parses simulateTransaction with v22+ state changes", () => {
      const parsed = parseRpcSimulateTransactionResponse(V22_RPC_FIXTURES.simulateTransaction.success);
      expect(parsed.latestLedger).toBe(25000);
      expect(parsed.minResourceFee).toBe("175000");
    });

    it("parses getTransaction with diagnosticEventsXdr", () => {
      const parsed = parseRpcGetTransactionResponse(V22_RPC_FIXTURES.getTransaction.success);
      expect(parsed.status).toBe("SUCCESS");
      expect(parsed.diagnosticEventsXdr).toBeDefined();
      expect(parsed.diagnosticEventsXdr?.length).toBe(1);
    });

    it("parses getLatestLedger with headerXdr", () => {
      const parsed = parseRpcGetLatestLedgerResponse(V22_RPC_FIXTURES.getLatestLedger.success);
      expect(parsed.protocolVersion).toBe(22);
      expect(parsed.sequence).toBe(25000);
    });
  });

  describe("Additive field tolerance", () => {
    it("safely tolerates unknown additive fields in getEvents without failing", () => {
      const parsed = parseRpcGetEventsResponse(V21_RPC_FIXTURES.getEvents.additiveFields);
      expect(parsed.events.length).toBe(1);
      expect(parsed.latestLedger).toBe(10500);
    });

    it("safely tolerates unknown additive fields in v22 getEvents", () => {
      const parsed = parseRpcGetEventsResponse(V22_RPC_FIXTURES.getEvents.additiveFields);
      expect(parsed.events.length).toBe(1);
      expect(parsed.latestLedger).toBe(25000);
    });

    it("safely tolerates future additive fields in sendTransaction", () => {
      const parsed = parseRpcSendTransactionResponse(V22_RPC_FIXTURES.sendTransaction.pending);
      expect(parsed.status).toBe("PENDING");
      expect(parsed.hash).toBe(SANITIZED_TX_HASH);
    });
  });

  describe("Explicit rejection of missing required fields", () => {
    it("rejects getEvents when events array is missing", () => {
      expect(() => parseRpcGetEventsResponse({ latestLedger: 1000 })).toThrow(RpcParsingError);
      expect(() => parseRpcGetEventsResponse({ latestLedger: 1000 })).toThrow(/missing required field/);
    });

    it("rejects getEvents when latestLedger is missing", () => {
      expect(() => parseRpcGetEventsResponse({ events: [] })).toThrow(RpcParsingError);
    });

    it("rejects getEvents when event items are missing required attributes", () => {
      expect(() =>
        parseRpcGetEventsResponse({
          latestLedger: 1000,
          events: [{ id: "1", type: "contract" }], // missing ledger, contractId, topic, value
        }),
      ).toThrow(RpcParsingError);
    });

    it("rejects simulateTransaction when neither minResourceFee nor error is present", () => {
      expect(() =>
        parseRpcSimulateTransactionResponse({
          latestLedger: 1000,
          events: [],
        }),
      ).toThrow(RpcParsingError);
    });

    it("rejects sendTransaction with invalid or missing status", () => {
      expect(() => parseRpcSendTransactionResponse({ hash: SANITIZED_TX_HASH })).toThrow(RpcParsingError);
      expect(() =>
        parseRpcSendTransactionResponse({
          status: "UNKNOWN_CUSTOM_STATUS",
          hash: SANITIZED_TX_HASH,
        }),
      ).toThrow(/invalid transaction status/);
    });

    it("rejects getTransaction with missing status or latestLedger", () => {
      expect(() => parseRpcGetTransactionResponse({ latestLedger: 1000 })).toThrow(RpcParsingError);
      expect(() => parseRpcGetTransactionResponse({ status: "SUCCESS" })).toThrow(RpcParsingError);
    });

    it("rejects getTransaction SUCCESS status without ledger", () => {
      expect(() =>
        parseRpcGetTransactionResponse({
          status: "SUCCESS",
          latestLedger: 1000,
        }),
      ).toThrow(/SUCCESS status requires confirmed 'ledger'/);
    });

    it("rejects getLatestLedger without sequence or id", () => {
      expect(() => parseRpcGetLatestLedgerResponse({ sequence: 1000 })).toThrow(RpcParsingError);
      expect(() => parseRpcGetLatestLedgerResponse({ id: "abc" })).toThrow(RpcParsingError);
    });
  });

  describe("Integration with SDK summarizeSimulation", () => {
    it("summarizeSimulation works with versioned v21 success fixture", () => {
      const estimate = summarizeSimulation(V21_RPC_FIXTURES.simulateTransaction.success, "100");
      expect(estimate).toBeDefined();
      expect(estimate?.minResourceFee).toBe("150000");
      expect(estimate?.inclusionFee).toBe("100");
      expect(estimate?.latestLedger).toBe(10500);
    });

    it("summarizeSimulation works with versioned restore preamble fixture", () => {
      const estimate = summarizeSimulation(V21_RPC_FIXTURES.simulateTransaction.withRestorePreamble);
      expect(estimate).toBeDefined();
      expect(estimate?.restoreRequired).toBe(true);
      expect(estimate?.restoreMinResourceFee).toBe("85000");
    });
  });
});
