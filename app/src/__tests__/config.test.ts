/**
 * Tests for app/src/lib/config.ts environment validation helpers.
 *
 * Covers getMissingEnvVars, getMalformedContractAddresses, and
 * getNetworkConflicts with missing, malformed, conflicting, and valid inputs.
 *
 * These are pure functions so no DOM or Next.js runtime is required.
 * The module-level assertEnvVars() call is bypassed because the jsdom
 * environment sets window, causing the server-only guard to short-circuit.
 */

import { describe, it, expect } from "vitest";
import {
  getMissingEnvVars,
  getMalformedContractAddresses,
  getNetworkConflicts,
} from "../lib/config";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const MAINNET_RPC = "https://soroban.stellar.org";

const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

const FULL_DEV_ENV: Record<string, string> = {
  NEXT_PUBLIC_STELLAR_RPC_URL: TESTNET_RPC,
  NEXT_PUBLIC_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
  NEXT_PUBLIC_INDEXER_URL: "http://localhost:3001",
};

const FULL_PROD_ENV: Record<string, string> = {
  ...FULL_DEV_ENV,
  NEXT_PUBLIC_STELLAR_RPC_URL: MAINNET_RPC,
  NEXT_PUBLIC_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
  NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS: VALID_CONTRACT_ID,
  NEXT_PUBLIC_REPUTATION_ADDRESS: VALID_CONTRACT_ID,
  NEXT_PUBLIC_USDC_ADDRESS: VALID_CONTRACT_ID,
};

// ═════════════════════════════════════════════════════════════════════════════
// getMissingEnvVars
// ═════════════════════════════════════════════════════════════════════════════

describe("getMissingEnvVars", () => {
  it("returns empty array for a complete dev env", () => {
    expect(getMissingEnvVars(FULL_DEV_ENV, false)).toEqual([]);
  });

  it("returns empty array for a complete production env", () => {
    expect(getMissingEnvVars(FULL_PROD_ENV, true)).toEqual([]);
  });

  it("flags NEXT_PUBLIC_STELLAR_RPC_URL when missing", () => {
    const env = { ...FULL_DEV_ENV };
    delete env.NEXT_PUBLIC_STELLAR_RPC_URL;
    expect(getMissingEnvVars(env, false)).toContain("NEXT_PUBLIC_STELLAR_RPC_URL");
  });

  it("flags NEXT_PUBLIC_NETWORK_PASSPHRASE when missing", () => {
    const env = { ...FULL_DEV_ENV };
    delete env.NEXT_PUBLIC_NETWORK_PASSPHRASE;
    expect(getMissingEnvVars(env, false)).toContain("NEXT_PUBLIC_NETWORK_PASSPHRASE");
  });

  it("flags NEXT_PUBLIC_INDEXER_URL when missing", () => {
    const env = { ...FULL_DEV_ENV };
    delete env.NEXT_PUBLIC_INDEXER_URL;
    expect(getMissingEnvVars(env, false)).toContain("NEXT_PUBLIC_INDEXER_URL");
  });

  it("flags whitespace-only values as missing", () => {
    const env = { ...FULL_DEV_ENV, NEXT_PUBLIC_STELLAR_RPC_URL: "   " };
    expect(getMissingEnvVars(env, false)).toContain("NEXT_PUBLIC_STELLAR_RPC_URL");
  });

  it("does not flag production addresses in dev mode", () => {
    const result = getMissingEnvVars(FULL_DEV_ENV, false);
    expect(result).not.toContain("NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS");
    expect(result).not.toContain("NEXT_PUBLIC_REPUTATION_ADDRESS");
    expect(result).not.toContain("NEXT_PUBLIC_USDC_ADDRESS");
  });

  it("flags all three production addresses when missing in production", () => {
    const env = { ...FULL_DEV_ENV };
    const result = getMissingEnvVars(env, true);
    expect(result).toContain("NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS");
    expect(result).toContain("NEXT_PUBLIC_REPUTATION_ADDRESS");
    expect(result).toContain("NEXT_PUBLIC_USDC_ADDRESS");
  });

  it("reports multiple missing variables in one call", () => {
    const result = getMissingEnvVars({}, false);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getMalformedContractAddresses
// ═════════════════════════════════════════════════════════════════════════════

describe("getMalformedContractAddresses", () => {
  it("returns empty array when no contract addresses are set", () => {
    expect(getMalformedContractAddresses(FULL_DEV_ENV)).toEqual([]);
  });

  it("returns empty array for valid Soroban contract IDs", () => {
    expect(getMalformedContractAddresses(FULL_PROD_ENV)).toEqual([]);
  });

  it("flags a G-prefixed address (not a contract ID)", () => {
    const env = {
      ...FULL_PROD_ENV,
      NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS:
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    };
    const result = getMalformedContractAddresses(env);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS");
  });

  it("flags a truncated contract ID (too short)", () => {
    const env = {
      ...FULL_PROD_ENV,
      NEXT_PUBLIC_REPUTATION_ADDRESS: "CSHORT",
    };
    const result = getMalformedContractAddresses(env);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("NEXT_PUBLIC_REPUTATION_ADDRESS");
  });

  it("flags multiple malformed addresses in one call", () => {
    const env = {
      ...FULL_PROD_ENV,
      NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS: "not-a-contract",
      NEXT_PUBLIC_REPUTATION_ADDRESS: "also-wrong",
    };
    expect(getMalformedContractAddresses(env).length).toBe(2);
  });

  it("does not flag empty values (presence is checked by getMissingEnvVars)", () => {
    const env = {
      ...FULL_PROD_ENV,
      NEXT_PUBLIC_USDC_ADDRESS: "",
    };
    const result = getMalformedContractAddresses(env);
    expect(result.every((e) => !e.includes("NEXT_PUBLIC_USDC_ADDRESS"))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getNetworkConflicts
// ═════════════════════════════════════════════════════════════════════════════

describe("getNetworkConflicts", () => {
  it("returns empty array for a consistent testnet configuration", () => {
    expect(
      getNetworkConflicts({
        NEXT_PUBLIC_STELLAR_RPC_URL: TESTNET_RPC,
        NEXT_PUBLIC_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
      }),
    ).toEqual([]);
  });

  it("returns empty array for a consistent mainnet configuration", () => {
    expect(
      getNetworkConflicts({
        NEXT_PUBLIC_STELLAR_RPC_URL: MAINNET_RPC,
        NEXT_PUBLIC_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      }),
    ).toEqual([]);
  });

  it("returns empty array when either value is absent (no comparison possible)", () => {
    expect(
      getNetworkConflicts({ NEXT_PUBLIC_STELLAR_RPC_URL: TESTNET_RPC }),
    ).toEqual([]);
    expect(
      getNetworkConflicts({ NEXT_PUBLIC_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE }),
    ).toEqual([]);
    expect(getNetworkConflicts({})).toEqual([]);
  });

  it("flags mainnet passphrase paired with testnet RPC URL", () => {
    const result = getNetworkConflicts({
      NEXT_PUBLIC_STELLAR_RPC_URL: TESTNET_RPC,
      NEXT_PUBLIC_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
    });
    expect(result.length).toBe(1);
    expect(result[0]).toContain("mainnet passphrase");
    expect(result[0]).toContain("testnet");
  });

  it("flags testnet passphrase paired with mainnet RPC URL", () => {
    const result = getNetworkConflicts({
      NEXT_PUBLIC_STELLAR_RPC_URL: MAINNET_RPC,
      NEXT_PUBLIC_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
    });
    expect(result.length).toBe(1);
    expect(result[0]).toContain("testnet passphrase");
    expect(result[0]).toContain("mainnet");
  });

  it("conflict message does not contain the passphrase value (secret-safe)", () => {
    const result = getNetworkConflicts({
      NEXT_PUBLIC_STELLAR_RPC_URL: TESTNET_RPC,
      NEXT_PUBLIC_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
    });
    for (const msg of result) {
      expect(msg).not.toContain(MAINNET_PASSPHRASE);
    }
  });

  it("does not flag a custom RPC URL that matches neither known network", () => {
    expect(
      getNetworkConflicts({
        NEXT_PUBLIC_STELLAR_RPC_URL: "https://my-private-node.example.com",
        NEXT_PUBLIC_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      }),
    ).toEqual([]);
  });
});
