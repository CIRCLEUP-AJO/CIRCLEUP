/**
 * Continuous Integration Execution Suite for Public SDK Examples (Issue #916 / Issue 80).
 *
 * Verifies that:
 * 1. Every offline public API code sample exported from sdk/examples/public-api.ts
 *    compiles and executes deterministically in continuous integration.
 * 2. Removed or renamed public exports cause actionable build and test failures.
 * 3. Network-bound operations are deterministically tested via mocks/stubs.
 * 4. Live testnet operations are strictly isolated behind explicit environment variables
 *    (RUN_LIVE_TESTNET_EXAMPLES=1) so ordinary CI never signs or submits live transactions.
 */

import { describe, it, expect, vi } from "vitest";
import {
  makeClient,
  testnetConfig,
  money,
  contributeBlockReason,
  describeError,
  decodeReads,
  recover,
  pendingDeprecations,
  circleName,
  standaloneIdentity,
  errorBanner,
  settle,
  sendRetries,
  activeCircles,
} from "../../examples/public-api";
import {
  CircleUpClient,
  GateError,
  IndexerError,
  SdkError,
  TESTNET_PASSPHRASE,
  TESTNET_RPC_URL,
  STROOPS_PER_USDC,
  buildSnapshot,
  type StateSnapshot,
  type TxResult,
  type IndexerPagination,
  type ApiCircleRow,
  type CircleConfig,
  type RoundState,
} from "@circleup/sdk";

const MOCK_MEMBER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MOCK_TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const MOCK_REP = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const MOCK_CONFIG: CircleConfig = {
  members: [MOCK_MEMBER],
  roundAmount: 100_000_000n,
  roundDeadlineLedgers: 100,
  usdcToken: MOCK_TOKEN,
  reputationContract: MOCK_REP,
};

const MOCK_ROUND: RoundState = {
  round: 0,
  deadlineLedger: 1000,
  contributionsReceived: 0,
  hasContributed: false,
};

describe("Public SDK Examples Execution in CI (Issue 80 / #916)", () => {
  describe("Client construction and network resolution", () => {
    it("executes makeClient deterministically without network calls", () => {
      const client = makeClient();
      expect(client).toBeInstanceOf(CircleUpClient);
      const resolved = client.getResolvedConfig();
      expect(resolved.rpcUrl).toBe(TESTNET_RPC_URL);
      expect(resolved.networkPassphrase).toBe(TESTNET_PASSPHRASE);
      expect(resolved.contracts.reputation).toBe(MOCK_REP);
      expect(resolved.indexerUrl).toBe("http://localhost:3001");
    });

    it("executes testnetConfig and resolves standard network parameters", () => {
      const config = testnetConfig();
      expect(config.network).toBe("testnet");
      expect(config.rpcUrl).toBe(TESTNET_RPC_URL);
      expect(config.passphrase).toBe(TESTNET_PASSPHRASE);
    });

    it("executes standaloneIdentity with custom network parameters", () => {
      const identity = standaloneIdentity();
      expect(identity.network).toBe("custom");
      expect(identity.rpcUrl).toBe("http://localhost:8000/soroban/rpc");
      expect(identity.passphrase).toBe("Standalone Network ; February 2017");
      expect(identity.preset).toBe(false);
      expect(identity.explorerNetwork).toBeNull();
    });
  });

  describe("Amount and unit math", () => {
    it("executes money helper to convert amounts and stroops correctly", () => {
      const m = money();
      expect(m.stroops).toBe(100n * BigInt(STROOPS_PER_USDC));
      expect(m.usdc).toBe("100");
      expect(m.display).toContain("100.00");
      expect(m.display).toContain(`1 USDC = ${STROOPS_PER_USDC} stroops`);
    });
  });

  describe("Action gating and state snapshots", () => {
    it("executes contributeBlockReason on valid and blocked snapshots", () => {
      const allowedSnapshot: StateSnapshot = buildSnapshot("Active", MOCK_ROUND, MOCK_CONFIG, 500);
      expect(contributeBlockReason(allowedSnapshot)).toBeNull();

      const blockedSnapshot: StateSnapshot = buildSnapshot("Completed", MOCK_ROUND, MOCK_CONFIG, 500);
      const reason = contributeBlockReason(blockedSnapshot);
      expect(reason).toBeTruthy();
      expect(reason).toContain("current status is Completed");
    });
  });

  describe("Error classification and description", () => {
    it("executes describeError across GateError, IndexerError, and generic errors", () => {
      const gateErr = new GateError("round_closed", "Round is expired");
      expect(describeError(gateErr)).toBe("gate blocked (round_closed): Round is expired");

      const idxErr = new IndexerError("Circle not found", 404, "http://localhost:3001/v1/circles/123");
      expect(describeError(idxErr)).toBe(
        "indexer 404 at http://localhost:3001/v1/circles/123: Circle not found",
      );

      const generic = new Error("Connection failed");
      expect(describeError(generic)).toBe("unknown error");
    });

    it("executes errorBanner and classifies errors stably", () => {
      const walletErr = { ok: false, reason: "user_rejected" };
      const banner = errorBanner(walletErr);
      expect(banner.text).toBe("You declined the signature.");
      expect(banner.info.code).toBe("wallet_rejected");

      const mismatchErr = { success: false, errorCode: "network_mismatch" };
      const bannerMismatch = errorBanner(mismatchErr);
      expect(bannerMismatch.text).toBe("Switch your wallet to the configured network.");
      expect(bannerMismatch.info.code).toBe("network_mismatch");

      const genericErr = new Error("Unexpected database issue");
      const bannerGeneric = errorBanner(genericErr);
      expect(bannerGeneric.text).toBe(bannerGeneric.info.message);
    });
  });

  describe("Decoding and read models", () => {
    it("executes decodeReads with typed contract wire structures", () => {
      const wireConfig = {
        members: [MOCK_MEMBER],
        round_amount: 100_000_000n,
        round_deadline_ledgers: 17280,
        usdc_token: MOCK_TOKEN,
        reputation_contract: MOCK_REP,
      };
      const decoded = decodeReads(wireConfig, "Active", 500_000_000n);
      expect(decoded.config.roundAmount).toBe(100_000_000n);
      expect(decoded.config.members).toEqual([MOCK_MEMBER]);
      expect(decoded.status).toBe("Active");
      expect(decoded.collateral).toBe(500_000_000n);
    });
  });

  describe("Write recovery, transaction lifecycle, and retry policy", () => {
    it("executes recover returning 'done' on successful transactions", async () => {
      const client = makeClient();
      const successResult: TxResult = {
        success: true,
        txHash: "1111111111111111111111111111111111111111111111111111111111111111",
        stage: "poll",
      };
      const outcome = await recover(client, successResult);
      expect(outcome).toBe("done");
    });

    it("executes recover returning 'resubmit' when failure is retryable", async () => {
      const client = makeClient();
      const retryableFailure: TxResult = {
        success: false,
        errorCode: "tx_rejected",
        stage: "send",
        errorMessage: "Transaction rejected by RPC",
      };
      const outcome = await recover(client, retryableFailure);
      expect(outcome).toBe("resubmit");
    });

    it("executes recover looking up status on non-retryable failure with txHash", async () => {
      const client = makeClient();
      const hash = "3333333333333333333333333333333333333333333333333333333333333333";
      vi.spyOn(client, "lookupTransaction").mockResolvedValue({
        ok: true,
        value: {
          txHash: hash,
          status: "confirmed",
          ledger: 12345,
          createdAt: new Date().toISOString(),
          applicationOrder: 1,
          feeCharged: 100n,
        },
      });

      const failedResult: TxResult = {
        success: false,
        errorCode: "unknown",
        errorMessage: "Unexpected failure",
        txHash: hash,
        stage: "poll",
      };
      const outcome = await recover(client, failedResult);
      expect(outcome).toBe("confirmed");
    });

    it("executes settle returning settled lifecycle", async () => {
      const client = makeClient();
      const confirmedResult: TxResult = {
        success: true,
        txHash: "4444444444444444444444444444444444444444444444444444444444444444",
        stage: "poll",
        ledger: 100,
      };
      const lifecycle = await settle(client, confirmedResult);
      expect(lifecycle.state).toBe("confirmed");
      expect(lifecycle.txHash).toBe("4444444444444444444444444444444444444444444444444444444444444444");
    });

    it("verifies sendRetries constant matches RETRY_POLICY", () => {
      expect(sendRetries).toBe("same_envelope");
    });
  });

  describe("Indexer iterateCircles async pagination", () => {
    it("executes activeCircles with mocked indexer client", async () => {
      const mockRows: ApiCircleRow[] = [
        {
          circle_id: "test-circle-1",
          address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC1",
          name: "Circle 1",
          status: "Active",
          round_amount: "100000000",
          round_deadline_ledgers: 100,
          current_round: 0,
          members: [MOCK_MEMBER],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
      const mockPagination: IndexerPagination = {
        limit: 10,
        offset: 0,
        total: 1,
      };

      const mockIndexer = {
        iterateCircles: async function* () {
          yield { circles: mockRows, pagination: mockPagination };
        },
      } as any;

      const result = await activeCircles(mockIndexer);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].circle_id).toBe("test-circle-1");
      expect(result.last).toEqual(mockPagination);
    });
  });

  describe("API deprecation policy inspection", () => {
    it("executes pendingDeprecations on response headers and body", () => {
      const headers = {
        deprecation: "@1735689600",
        sunset: "2026-06-01",
      };
      const body = {
        deprecations: [
          {
            field: "round_amount",
            replacement: "roundAmount",
            sunset: "2026-06-01",
          },
        ],
      };
      const result = pendingDeprecations(headers, body);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("round_amount is deprecated in favor of roundAmount");
      expect(result.sunsetAt).toBeInstanceOf(Date);
    });

    it("executes circleName with transitional fallback", () => {
      const name = circleName({ name: "Old Name", title: "New Title" });
      expect(name).toBe("New Title");

      const legacyOnly = circleName({ name: "Legacy Name" });
      expect(legacyOnly).toBe("Legacy Name");
    });
  });

  describe("Live testnet environment isolation guard", () => {
    it("safely skips live transactions in CI unless RUN_LIVE_TESTNET_EXAMPLES is explicitly set", () => {
      const runLive = process.env.RUN_LIVE_TESTNET_EXAMPLES === "1";
      if (!runLive) {
        // Safe skip path for CI: ensures ordinary CI never signs or submits live transactions
        expect(true).toBe(true);
        return;
      }

      // If explicitly enabled by a developer with live testnet funds:
      const secret = process.env.STELLAR_SECRET_KEY;
      expect(secret, "STELLAR_SECRET_KEY required when RUN_LIVE_TESTNET_EXAMPLES=1").toBeDefined();
    });
  });
});
