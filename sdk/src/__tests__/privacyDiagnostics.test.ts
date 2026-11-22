import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  redactAddresses,
  sanitizeEndpointUrl,
  isSafeTxHash,
  sanitizeDiagnosticsRecord,
  ALLOWLISTED_DIAGNOSTIC_FIELDS,
  MAX_SAFE_DIAGNOSTIC_LENGTH,
} from "../redact";
import { IndexerError } from "../client";
import { formatRpcError } from "../simulationHelpers";
import { SdkError, classifySdkError } from "../errors";
import { transactionSupport } from "../support";

describe("Privacy-Safe Diagnostics & Error Sanitization (Issue #912)", () => {
  const SYNTHETIC_S_KEY = "SB6XQYZZ5QZNVG7U5YQ3E2I2Z4X3B5P7Q9R1S2T3U4V5W6X7Y8Z9A1B2";
  const SYNTHETIC_G_ADDR = "GBZXN7PIRZGNMHGA72ODKDFDA5QQUODQUMF2PDG2HMN45HSZAAAABBBB";
  const SYNTHETIC_SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const SYNTHETIC_XDR =
    "AAAAAgAAAAA3m5v1Q1...AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" +
    "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==";

  describe("redactSecrets", () => {
    it("redacts Stellar secret keys (S-keys)", () => {
      const input = `Failed transaction with secret key ${SYNTHETIC_S_KEY} during signing.`;
      const result = redactSecrets(input);
      expect(result).not.toContain(SYNTHETIC_S_KEY);
      expect(result).toContain("[redacted:secret-key]");
    });

    it("redacts mnemonic seed phrases", () => {
      const input = `Wallet error for mnemonic: ${SYNTHETIC_SEED} rejected`;
      const result = redactSecrets(input);
      expect(result).not.toContain(SYNTHETIC_SEED);
      expect(result).toContain("[redacted:seed]");
    });

    it("redacts raw signed XDR envelopes", () => {
      const input = `RPC rejected envelope ${SYNTHETIC_XDR} with code -32600`;
      const result = redactSecrets(input);
      expect(result).not.toContain(SYNTHETIC_XDR);
      expect(result).toContain("[redacted:xdr]");
    });

    it("redacts basic auth credentials in embedded URLs", () => {
      const input = `Failed to connect to https://admin:supersecret123@rpc.stellar.org/api`;
      const result = redactSecrets(input);
      expect(result).not.toContain("supersecret123");
      expect(result).toContain("https://[redacted:auth]@rpc.stellar.org/api");
    });

    it("bounds error detail length to MAX_SAFE_DIAGNOSTIC_LENGTH", () => {
      const hugeInput = "ConnectionException: DatabaseTimeoutError code 500. ".repeat(10);
      const result = redactSecrets(hugeInput);
      expect(result.length).toBeLessThanOrEqual(MAX_SAFE_DIAGNOSTIC_LENGTH);
      expect(result.endsWith("...")).toBe(true);
    });
  });

  describe("redactAddresses", () => {
    it("redacts public keys and contract addresses when strict privacy is requested", () => {
      const input = `Account ${SYNTHETIC_G_ADDR} joined circle CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`;
      const result = redactAddresses(input);
      expect(result).not.toContain(SYNTHETIC_G_ADDR);
      expect(result).not.toContain("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
      expect(result).toContain("[redacted:address]");
    });
  });

  describe("sanitizeEndpointUrl", () => {
    it("strips user credentials from HTTP and HTTPS URLs", () => {
      expect(sanitizeEndpointUrl("https://user:password@testnet.stellar.org:8000/rpc")).toBe(
        "https://testnet.stellar.org:8000/rpc",
      );
      expect(sanitizeEndpointUrl("http://apikey:token123@localhost:3001/api/v1/")).toBe(
        "http://localhost:3001/api/v1",
      );
    });

    it("strips trailing slashes cleanly", () => {
      expect(sanitizeEndpointUrl("https://soroban-testnet.stellar.org///")).toBe(
        "https://soroban-testnet.stellar.org",
      );
    });
  });

  describe("isSafeTxHash", () => {
    it("accepts valid 64-character hex transaction hashes", () => {
      expect(isSafeTxHash("a".repeat(64))).toBe(true);
      expect(isSafeTxHash("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(true);
    });

    it("rejects non-hex or invalid length strings", () => {
      expect(isSafeTxHash("a".repeat(63))).toBe(false);
      expect(isSafeTxHash("a".repeat(65))).toBe(false);
      expect(isSafeTxHash("g".repeat(64))).toBe(false);
      expect(isSafeTxHash(null)).toBe(false);
      expect(isSafeTxHash(12345)).toBe(false);
    });
  });

  describe("sanitizeDiagnosticsRecord", () => {
    it("preserves allowlisted fields while scrubbing non-allowlisted fields", () => {
      const unsafeRecord: Record<string, unknown> = {
        stage: "submission",
        code: "tx_rejected",
        txHash: "A".repeat(64),
        message: `Rejected with key ${SYNTHETIC_S_KEY}`,
        privateKey: SYNTHETIC_S_KEY,
        rawEnvelope: SYNTHETIC_XDR,
        internalDbId: 42,
      };

      const safe = sanitizeDiagnosticsRecord(unsafeRecord);

      expect(safe).toHaveProperty("stage", "submission");
      expect(safe).toHaveProperty("code", "tx_rejected");
      expect(safe).toHaveProperty("txHash", "a".repeat(64)); // Normalized to lowercase
      expect(safe).toHaveProperty("message");
      expect(safe.message).not.toContain(SYNTHETIC_S_KEY);
      expect(safe.message).toContain("[redacted:secret-key]");

      // Forbidden sensitive fields must NOT be present
      expect(safe).not.toHaveProperty("privateKey");
      expect(safe).not.toHaveProperty("rawEnvelope");
      expect(safe).not.toHaveProperty("internalDbId");
    });
  });

  describe("IndexerError Sanitization", () => {
    it("automatically redacts secrets in error messages and credentials in requested URLs", () => {
      const sensitiveUrl = `http://authuser:superpass@indexer.circleup.org/api/v1/circles?key=${SYNTHETIC_S_KEY}`;
      const sensitiveMsg = `Error processing request for key ${SYNTHETIC_S_KEY}`;

      const err = new IndexerError(sensitiveMsg, 400, sensitiveUrl, "http");

      expect(err.message).not.toContain(SYNTHETIC_S_KEY);
      expect(err.message).toContain("[redacted:secret-key]");
      expect(err.url).not.toContain("superpass");
      expect(err.url).not.toContain("authuser");
    });
  });

  describe("formatRpcError Sanitization", () => {
    it("sanitizes RPC URLs containing credentials and redacts sensitive error messages", () => {
      const rpcUrl = "https://user:rpcpass@rpc.stellar.org";
      const rawError = `Transaction failed: envelope ${SYNTHETIC_XDR} connection refused`;

      const formatted = formatRpcError(rawError, rpcUrl);

      expect(formatted).not.toContain("rpcpass");
      expect(formatted).not.toContain(SYNTHETIC_XDR);
      expect(formatted).toContain("https://rpc.stellar.org");
    });
  });

  describe("SdkError Privacy & Non-enumerable Cause", () => {
    it("does not leak raw exceptions or secrets through JSON serialization", () => {
      const rawCause = new Error(`Provider failure with secret ${SYNTHETIC_S_KEY}`);
      const sdkError = SdkError.from(rawCause, "wallet");

      // Verify log-safe message
      expect(sdkError.message).not.toContain(SYNTHETIC_S_KEY);

      // Verify cause is non-enumerable
      const descriptor = Object.getOwnPropertyDescriptor(sdkError, "cause");
      expect(descriptor?.enumerable).toBe(false);

      // Verify JSON serialization contains only allowlisted log-safe fields
      const serialized = JSON.stringify(sdkError);
      expect(serialized).not.toContain(SYNTHETIC_S_KEY);
      expect(serialized).not.toContain("Provider failure");

      const json = JSON.parse(serialized);
      expect(json).toHaveProperty("stage");
      expect(json).toHaveProperty("code");
      expect(json).toHaveProperty("retry");
      expect(json).toHaveProperty("retryable");
      expect(json).toHaveProperty("message");
    });
  });

  describe("transactionSupport Diagnostics Panel", () => {
    it("produces privacy-safe diagnostics for copyable support panels", () => {
      const failure = {
        success: false as const,
        txHash: "B".repeat(64),
        errorMessage: `Private failure with secret ${SYNTHETIC_S_KEY}`,
        errorCode: "network_error" as const,
      };

      const support = transactionSupport(failure, "contribute", "testnet");

      expect(support.diagnostics.txHash).toBe("b".repeat(64));
      expect(support.diagnostics.operation).toBe("contribute");
      expect(support.diagnostics.network).toBe("testnet");
      expect(support.diagnostics.category).toBe("network_error");
      expect(JSON.stringify(support.diagnostics)).not.toContain(SYNTHETIC_S_KEY);
    });
  });
});
