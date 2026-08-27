import { describe, it, expect } from "vitest";
import {
  getNetworkConfig,
  isValidNetwork,
  getExplorerLink,
  EXPLORER_BASE_URL,
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

describe("getExplorerLink", () => {
  // A representative testnet transaction hash (64 hex chars).
  const TX_HASH =
    "3389e9f0f1a8c8e6b0f0f0a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566";
  const ACCOUNT = "GABC2XYZ3ABC2XYZ3ABC2XYZ3ABC2XYZ3ABC2XYZ3ABC2XYZ3ABC2XYZ";
  const CONTRACT = "CABC2XYZ3ABC2XYZ3ABC2XYZ3ABC2XYZ3ABC2XYZ3ABC2XYZ3ABC2XYZ";

  it("builds a testnet transaction link", () => {
    expect(getExplorerLink("testnet", "tx", TX_HASH)).toBe(
      `${EXPLORER_BASE_URL}/testnet/tx/${TX_HASH}`,
    );
  });

  it("maps mainnet to Stellar Expert's `public` segment", () => {
    // The whole point of centralising this: mainnet is "public" on the explorer.
    expect(getExplorerLink("mainnet", "tx", TX_HASH)).toBe(
      `${EXPLORER_BASE_URL}/public/tx/${TX_HASH}`,
    );
    expect(getExplorerLink("mainnet", "tx", TX_HASH)).not.toContain("/mainnet/");
  });

  it("supports account and contract entity types on both networks", () => {
    expect(getExplorerLink("testnet", "account", ACCOUNT)).toBe(
      `${EXPLORER_BASE_URL}/testnet/account/${ACCOUNT}`,
    );
    expect(getExplorerLink("mainnet", "contract", CONTRACT)).toBe(
      `${EXPLORER_BASE_URL}/public/contract/${CONTRACT}`,
    );
  });

  it("returns null for unsupported / custom networks (safe non-link)", () => {
    expect(getExplorerLink("standalone", "tx", TX_HASH)).toBeNull();
    expect(getExplorerLink("futurenet", "tx", TX_HASH)).toBeNull();
    expect(getExplorerLink("", "tx", TX_HASH)).toBeNull();
    // Case-sensitive: the explorer segment must match exactly.
    expect(getExplorerLink("Testnet", "tx", TX_HASH)).toBeNull();
  });

  it("returns null for empty or whitespace-only identifiers", () => {
    expect(getExplorerLink("testnet", "tx", "")).toBeNull();
    expect(getExplorerLink("testnet", "tx", "   ")).toBeNull();
    expect(getExplorerLink("testnet", "account", "\t\n")).toBeNull();
  });

  it("trims surrounding whitespace from the identifier", () => {
    expect(getExplorerLink("testnet", "tx", `  ${TX_HASH}  `)).toBe(
      `${EXPLORER_BASE_URL}/testnet/tx/${TX_HASH}`,
    );
  });

  it("URL-encodes identifiers so malformed values cannot break the path", () => {
    // A slash would otherwise inject an extra path segment; encoding neutralises it.
    expect(getExplorerLink("testnet", "tx", "abc/def")).toBe(
      `${EXPLORER_BASE_URL}/testnet/tx/abc%2Fdef`,
    );
    // Spaces, query and fragment characters are all percent-encoded.
    expect(getExplorerLink("mainnet", "account", "a b?c#d")).toBe(
      `${EXPLORER_BASE_URL}/public/account/a%20b%3Fc%23d`,
    );
    // A path-traversal attempt is encoded rather than resolved.
    expect(getExplorerLink("testnet", "tx", "../../evil")).toBe(
      `${EXPLORER_BASE_URL}/testnet/tx/..%2F..%2Fevil`,
    );
  });
});
