import { describe, it, expect } from "vitest";
import {
  getNetworkConfig,
  isValidNetwork,
  TESTNET_RPC_URL,
  MAINNET_RPC_URL,
  TESTNET_PASSPHRASE,
  MAINNET_PASSPHRASE,
  FRIENDBOT_URL,
} from "./constants";

describe("getNetworkConfig", () => {
  it("returns correct testnet config", () => {
    const cfg = getNetworkConfig("testnet");
    expect(cfg.network).toBe("testnet");
    expect(cfg.rpcUrl).toBe(TESTNET_RPC_URL);
    expect(cfg.passphrase).toBe(TESTNET_PASSPHRASE);
    expect(cfg.friendbotUrl).toBe(FRIENDBOT_URL);
  });

  it("returns correct mainnet config", () => {
    const cfg = getNetworkConfig("mainnet");
    expect(cfg.network).toBe("mainnet");
    expect(cfg.rpcUrl).toBe(MAINNET_RPC_URL);
    expect(cfg.passphrase).toBe(MAINNET_PASSPHRASE);
    expect(cfg.friendbotUrl).toBeNull();
  });

  it("throws a descriptive error for unknown network names", () => {
    // @ts-expect-error intentional invalid input
    expect(() => getNetworkConfig("devnet")).toThrow(/Unknown network "devnet"/);
    // @ts-expect-error intentional invalid input
    expect(() => getNetworkConfig("")).toThrow(/Unknown network ""/);
  });
});

describe("isValidNetwork", () => {
  it("returns true for valid network names", () => {
    expect(isValidNetwork("testnet")).toBe(true);
    expect(isValidNetwork("mainnet")).toBe(true);
  });

  it("returns false for invalid values", () => {
    expect(isValidNetwork("devnet")).toBe(false);
    expect(isValidNetwork("")).toBe(false);
    expect(isValidNetwork("TESTNET")).toBe(false);
    expect(isValidNetwork("Mainnet")).toBe(false);
  });
});
