/**
 * Network identity binding (issue #903): name, passphrase, and RPC URL must be
 * consistent, custom networks need URL + passphrase together, and a URL alone
 * never decides identity.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { CircleUpClient } from "../client";
import {
  MAINNET_PASSPHRASE,
  MAINNET_RPC_URL,
  TESTNET_PASSPHRASE,
  TESTNET_RPC_URL,
  resolveNetworkIdentity,
} from "../constants";
import { validateCircleUpConfig } from "../types";
import type { CircleUpConfig } from "../types";
import { CIRCLE_ADDR, MEMBER_A, SDK_CONFIG } from "./fixtures";

const STANDALONE = "Standalone Network ; February 2017";
const LOCAL_RPC = "http://localhost:8000/soroban/rpc";

class TestClient extends CircleUpClient {
  call() {
    return this.buildAndSend(MEMBER_A, CIRCLE_ADDR, "join", []);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("resolveNetworkIdentity — presets", () => {
  it("resolves testnet from its passphrase when network is omitted", () => {
    const id = resolveNetworkIdentity({ rpcUrl: TESTNET_RPC_URL, networkPassphrase: TESTNET_PASSPHRASE });
    expect(id).toEqual({
      network: "testnet",
      passphrase: TESTNET_PASSPHRASE,
      rpcUrl: TESTNET_RPC_URL,
      preset: true,
      explorerNetwork: "testnet",
    });
    expect(Object.isFrozen(id)).toBe(true);
  });

  it("accepts an explicit matching name", () => {
    const id = resolveNetworkIdentity({
      network: "mainnet",
      rpcUrl: MAINNET_RPC_URL,
      networkPassphrase: MAINNET_PASSPHRASE,
    });
    expect(id.network).toBe("mainnet");
  });

  it("accepts a private RPC URL for a preset — identity comes from the passphrase", () => {
    const id = resolveNetworkIdentity({
      rpcUrl: "https://rpc.example.com",
      networkPassphrase: MAINNET_PASSPHRASE,
    });
    expect(id.network).toBe("mainnet");
  });

  it("rejects a name that contradicts the passphrase", () => {
    expect(() =>
      resolveNetworkIdentity({ network: "mainnet", rpcUrl: MAINNET_RPC_URL, networkPassphrase: TESTNET_PASSPHRASE }),
    ).toThrow('does not match config.network "mainnet"');
  });

  it("rejects a preset public endpoint paired with another network's passphrase", () => {
    expect(() =>
      resolveNetworkIdentity({ rpcUrl: `${TESTNET_RPC_URL}/`, networkPassphrase: MAINNET_PASSPHRASE }),
    ).toThrow("public testnet endpoint");
  });

  it("rejects an unknown network name", () => {
    expect(() =>
      resolveNetworkIdentity({ network: "futurenet", rpcUrl: LOCAL_RPC, networkPassphrase: STANDALONE }),
    ).toThrow("not supported");
  });
});

describe("resolveNetworkIdentity — custom networks", () => {
  it("accepts an explicit custom tuple and gives it no explorer", () => {
    const id = resolveNetworkIdentity({ network: "custom", rpcUrl: LOCAL_RPC, networkPassphrase: STANDALONE });
    expect(id).toMatchObject({ network: "custom", preset: false, explorerNetwork: null, passphrase: STANDALONE });
  });

  it("rejects a custom passphrase without network: \"custom\"", () => {
    expect(() => resolveNetworkIdentity({ rpcUrl: LOCAL_RPC, networkPassphrase: STANDALONE })).toThrow(
      'set config.network to "custom"',
    );
  });

  it("rejects network: \"custom\" with a preset passphrase", () => {
    expect(() =>
      resolveNetworkIdentity({ network: "custom", rpcUrl: LOCAL_RPC, networkPassphrase: TESTNET_PASSPHRASE }),
    ).toThrow('Use network: "testnet"');
  });

  it("rejects incomplete custom settings", () => {
    expect(() => resolveNetworkIdentity({ network: "custom", networkPassphrase: STANDALONE })).toThrow(
      "supplied together",
    );
    expect(() => resolveNetworkIdentity({ network: "custom", rpcUrl: LOCAL_RPC })).toThrow(
      "config.networkPassphrase is required",
    );
  });

  it("rejects a custom network pointed at a public preset endpoint", () => {
    expect(() =>
      resolveNetworkIdentity({ network: "custom", rpcUrl: MAINNET_RPC_URL, networkPassphrase: STANDALONE }),
    ).toThrow("public mainnet endpoint");
  });

  it("validateCircleUpConfig accepts a complete custom config", () => {
    expect(() =>
      validateCircleUpConfig({ ...SDK_CONFIG, network: "custom", rpcUrl: LOCAL_RPC, networkPassphrase: STANDALONE }),
    ).not.toThrow();
  });
});

describe("CircleUpClient network binding", () => {
  it("rejects an inconsistent config at construction", () => {
    expect(
      () => new CircleUpClient({ ...SDK_CONFIG, network: "mainnet" } as CircleUpConfig),
    ).toThrow("does not match");
  });

  it("exposes the resolved identity and a frozen config copy", () => {
    const client = new CircleUpClient(SDK_CONFIG);
    expect(client.getNetworkIdentity().network).toBe("testnet");
    const resolved = client.getResolvedConfig();
    expect(resolved.network).toBe("testnet");
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.contracts)).toBe(true);
  });

  it("builds explorer links only for presets", () => {
    const hash = "ab".repeat(32);
    expect(new CircleUpClient(SDK_CONFIG).explorerLink("tx", hash)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${hash}`,
    );
    const custom = new CircleUpClient({ ...SDK_CONFIG, network: "custom", rpcUrl: LOCAL_RPC, networkPassphrase: STANDALONE });
    expect(custom.explorerLink("tx", hash)).toBeNull();
  });

  it("refuses to build a write after the config object is mutated to another network", async () => {
    const getAccount = vi.spyOn(SorobanRpc.Server.prototype, "getAccount");
    const config = { ...SDK_CONFIG };
    const client = new TestClient(config);
    config.networkPassphrase = MAINNET_PASSPHRASE;

    const result = await client.call();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe("network_mismatch");
      expect(result.txHash).toBe("");
    }
    expect(getAccount).not.toHaveBeenCalled();
  });

  it("tags structured log events with the network name only", async () => {
    vi.spyOn(SorobanRpc.Server.prototype, "getAccount").mockRejectedValue(new Error("404 not found"));
    const events: unknown[] = [];
    const client = new TestClient(SDK_CONFIG).setTxLogger((e) => events.push(e));
    await client.call();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ network: "testnet" });
    expect(JSON.stringify(events)).not.toContain(TESTNET_PASSPHRASE);
  });
});
