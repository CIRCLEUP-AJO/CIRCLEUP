import { describe, it, expect, vi } from "vitest";
import { CircleUpClient } from "../circleUpClient";
import { CircleClient, IndexerClient } from "../client";
import { DEFAULT_POLL_CONFIG } from "../polling";
import type { CircleUpConfig, TxLogEvent } from "../types";

describe("Independent SDK Clients Without Shared Mutable State (Issue #913)", () => {
  const baseTestnetConfig: CircleUpConfig = {
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    indexerUrl: "http://localhost:3001",
    contracts: {
      circleFactory: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      reputation: "CA3D5KRYMCMCZNUM7GIHIPDA3EQNDWT5C7XNWNXMQWJHQ7TVNNAOT7TQ",
      usdc: "CCGNAJ34WZNOQ22RNY3R4T7NQ4N7LMR6K52445E5HCSH7Q2EQUS2O234",
    },
  };

  const baseCustomConfig: CircleUpConfig = {
    network: "custom",
    networkPassphrase: "Standalone Local Security Network ; February 2024",
    rpcUrl: "http://localhost:8000/soroban/rpc",
    indexerUrl: "http://localhost:4000",
    contracts: {
      circleFactory: "CCGNAJ34WZNOQ22RNY3R4T7NQ4N7LMR6K52445E5HCSH7Q2EQUS2O234",
      reputation: "CCGNAJ34WZNOQ22RNY3R4T7NQ4N7LMR6K52445E5HCSH7Q2EQUS2O234",
      usdc: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    },
  };

  it("ensures DEFAULT_POLL_CONFIG is frozen and cannot be modified globally", () => {
    expect(Object.isFrozen(DEFAULT_POLL_CONFIG)).toBe(true);
    expect(() => {
      // @ts-expect-error mutating frozen object
      DEFAULT_POLL_CONFIG.timeoutMs = 999999;
    }).toThrow();
  });

  it("constructs independent clients with distinct network, RPC, indexer, and poll settings", () => {
    const clientA = new CircleUpClient(baseTestnetConfig, {
      timeoutMs: 15_000,
      initialIntervalMs: 500,
    });

    const clientB = new CircleUpClient(baseCustomConfig, {
      timeoutMs: 45_000,
      initialIntervalMs: 2_500,
    });

    // Verify network identity is independent
    expect(clientA.getNetworkIdentity().network).toBe("testnet");
    expect(clientB.getNetworkIdentity().network).toBe("custom");
    expect(clientA.getNetworkIdentity().rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(clientB.getNetworkIdentity().rpcUrl).toBe("http://localhost:8000/soroban/rpc");

    // Verify polling configs are distinct and frozen
    const pollA = clientA.getPollConfig();
    const pollB = clientB.getPollConfig();
    expect(pollA.timeoutMs).toBe(15_000);
    expect(pollA.initialIntervalMs).toBe(500);
    expect(pollB.timeoutMs).toBe(45_000);
    expect(pollB.initialIntervalMs).toBe(2_500);

    expect(Object.isFrozen(pollA)).toBe(true);
    expect(Object.isFrozen(pollB)).toBe(true);
  });

  it("defensively clones and freezes input configuration so caller mutations do not leak", () => {
    const mutableConfig: CircleUpConfig = {
      network: "testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      indexerUrl: "http://localhost:3001",
      contracts: {
        circleFactory: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        reputation: "CA3D5KRYMCMCZNUM7GIHIPDA3EQNDWT5C7XNWNXMQWJHQ7TVNNAOT7TQ",
        usdc: "CCGNAJ34WZNOQ22RNY3R4T7NQ4N7LMR6K52445E5HCSH7Q2EQUS2O234",
      },
    };

    const client = new CircleUpClient(mutableConfig);

    // Mutate the caller's config object after client construction
    mutableConfig.rpcUrl = "https://mutated-rpc.example.com";
    mutableConfig.indexerUrl = "http://mutated-indexer.example.com";
    mutableConfig.contracts.circleFactory = "CCGNAJ34WZNOQ22RNY3R4T7NQ4N7LMR6K52445E5HCSH7Q2EQUS2O234";

    // Verify the client retained its frozen original values
    const resolved = client.getResolvedConfig();
    expect(resolved.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(resolved.indexerUrl).toBe("http://localhost:3001");
    expect(resolved.contracts.circleFactory).toBe(
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    );
  });

  it("maintains isolated transaction logger callbacks per client instance", () => {
    const clientA = new CircleUpClient(baseTestnetConfig);
    const clientB = new CircleUpClient(baseCustomConfig);

    const loggerA = vi.fn<[TxLogEvent], void>();
    const loggerB = vi.fn<[TxLogEvent], void>();

    clientA.setTxLogger(loggerA);
    clientB.setTxLogger(loggerB);

    // Trigger an emit via internal buildAndSend failure on Client A
    // (e.g. invalid arguments before submission)
    const dummyKeypair = { publicKey: () => "GBZXN7PIRZGNMHGA72ODKDFDA5QQUODQUMF2PDG2HMN45HSZAAAABBBB" } as any;

    // Emitting on clientA must only call loggerA
    // @ts-expect-error accessing protected emitTxLog for test assertion
    clientA["emitTxLog"]({
      phase: "simulated",
      ctx: "test.method",
      contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      method: "test",
    });

    expect(loggerA).toHaveBeenCalledTimes(1);
    expect(loggerB).toHaveBeenCalledTimes(0);

    // Emitting on clientB must only call loggerB
    // @ts-expect-error accessing protected emitTxLog for test assertion
    clientB["emitTxLog"]({
      phase: "simulated",
      ctx: "test.method",
      contractId: "CCGNAJ34WZNOQ22RNY3R4T7NQ4N7LMR6K52445E5HCSH7Q2EQUS2O234",
      method: "test",
    });

    expect(loggerA).toHaveBeenCalledTimes(1);
    expect(loggerB).toHaveBeenCalledTimes(1);
  });

  it("isolates CircleClient state cache across distinct client instances", () => {
    const circleAddr = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const client1 = new CircleClient(baseTestnetConfig, circleAddr, 5000);
    const client2 = new CircleClient(baseTestnetConfig, circleAddr, 5000);

    // Initially neither has cached state
    expect(client1.getCachedState()).toBeNull();
    expect(client2.getCachedState()).toBeNull();

    // Populate cache on client1 directly via internal _stateCache
    const dummyState: any = {
      circleAddress: circleAddr,
      admin: "GBZXN7PIRZGNMHGA72ODKDFDA5QQUODQUMF2PDG2HMN45HSZAAAABBBB",
      members: [],
      roundAmountStroops: 10000000n,
      roundDeadlineLedgers: 100,
      status: "open",
    };

    // @ts-expect-error accessing internal cache for test
    client1["_stateCache"] = { state: dummyState, fetchedAt: Date.now() };

    expect(client1.getCachedState()).toEqual(dummyState);
    // client2 MUST remain null
    expect(client2.getCachedState()).toBeNull();

    // Invalidation on client1 does not affect client2
    client1.invalidateCache();
    expect(client1.getCachedState()).toBeNull();
  });

  it("keeps IndexerClient base URLs and timeout configurations isolated", () => {
    const indexer1 = new IndexerClient(baseTestnetConfig, { timeoutMs: 3000 });
    const indexer2 = new IndexerClient(baseCustomConfig, { timeoutMs: 8000 });

    // Verify baseUrl is isolated
    // @ts-expect-error accessing private property for assertion
    expect(indexer1["baseUrl"]).toBe("http://localhost:3001");
    // @ts-expect-error accessing private property for assertion
    expect(indexer2["baseUrl"]).toBe("http://localhost:4000");

    // @ts-expect-error accessing private property for assertion
    expect(indexer1["timeoutMs"]).toBe(3000);
    // @ts-expect-error accessing private property for assertion
    expect(indexer2["timeoutMs"]).toBe(8000);
  });
});
