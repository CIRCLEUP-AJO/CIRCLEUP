import { describe, it, expect } from "vitest";
import {
  validateCircleUpConfig,
  isValidContractAddress,
} from "./types";
import { TESTNET_PASSPHRASE, MAINNET_PASSPHRASE } from "./constants";

// A valid config used as a baseline across tests
const VALID_CONFIG = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: TESTNET_PASSPHRASE,
  contracts: {
    circleFactory: "CCIRCLEUPFACTORYADDRESSPLACEHOLDERAAAAAAAAAAAAAAAAAAAAAA",
    reputation:    "CREPUTATIONADDRESSPLACEHOLDERAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    usdc:          "CUSDCADDRESSPLACEHOLDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
} as const;

// ─── isValidContractAddress ───────────────────────────────────────────────────

describe("isValidContractAddress", () => {
  it("accepts a well-formed 56-char C-address", () => {
    expect(isValidContractAddress("CCIRCLEUPFACTORYADDRESSPLACEHOLDERAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
  });

  it("rejects addresses that don't start with C", () => {
    expect(isValidContractAddress("GCIRCLEUPFACTORYADDRESSPLACEHOLDERAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });

  it("rejects addresses that are too short or too long", () => {
    expect(isValidContractAddress("CSHORT")).toBe(false);
    expect(isValidContractAddress("C" + "A".repeat(56))).toBe(false); // 57 chars
  });

  it("rejects empty string", () => {
    expect(isValidContractAddress("")).toBe(false);
  });
});

// ─── validateCircleUpConfig ───────────────────────────────────────────────────

describe("validateCircleUpConfig", () => {
  it("accepts a fully valid config", () => {
    expect(() => validateCircleUpConfig(VALID_CONFIG)).not.toThrow();
  });

  it("accepts mainnet passphrase", () => {
    expect(() =>
      validateCircleUpConfig({ ...VALID_CONFIG, networkPassphrase: MAINNET_PASSPHRASE }),
    ).not.toThrow();
  });

  it("throws for null / non-object input", () => {
    expect(() => validateCircleUpConfig(null)).toThrow("non-null object");
    expect(() => validateCircleUpConfig("string")).toThrow("non-null object");
  });

  it("reports missing rpcUrl", () => {
    const cfg = { ...VALID_CONFIG, rpcUrl: "" };
    expect(() => validateCircleUpConfig(cfg)).toThrow("config.rpcUrl");
  });

  it("reports malformed rpcUrl", () => {
    const cfg = { ...VALID_CONFIG, rpcUrl: "not-a-url" };
    expect(() => validateCircleUpConfig(cfg)).toThrow("config.rpcUrl");
  });

  it("reports missing networkPassphrase", () => {
    const { networkPassphrase: _, ...rest } = VALID_CONFIG;
    expect(() => validateCircleUpConfig(rest)).toThrow("config.networkPassphrase");
  });

  it("reports unrecognised networkPassphrase", () => {
    const cfg = { ...VALID_CONFIG, networkPassphrase: "Bad Passphrase" };
    expect(() => validateCircleUpConfig(cfg)).toThrow("networkPassphrase");
  });

  it("reports missing contracts block", () => {
    const { contracts: _, ...rest } = VALID_CONFIG;
    expect(() => validateCircleUpConfig(rest)).toThrow("config.contracts");
  });

  it("reports invalid contract addresses", () => {
    const cfg = {
      ...VALID_CONFIG,
      contracts: { ...VALID_CONFIG.contracts, circleFactory: "INVALID" },
    };
    const err = expect(() => validateCircleUpConfig(cfg));
    err.toThrow("config.contracts.circleFactory");
  });

  it("collects multiple errors in one throw", () => {
    const cfg = { rpcUrl: "bad", networkPassphrase: "bad", contracts: {} };
    let message = "";
    try {
      validateCircleUpConfig(cfg);
    } catch (e) {
      message = (e as Error).message;
    }
    // Should list rpcUrl, networkPassphrase, and all three contract keys
    expect(message).toMatch("config.rpcUrl");
    expect(message).toMatch("config.networkPassphrase");
    expect(message).toMatch("config.contracts.circleFactory");
    expect(message).toMatch("config.contracts.reputation");
    expect(message).toMatch("config.contracts.usdc");
  });
});
