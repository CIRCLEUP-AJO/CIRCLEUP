import { describe, it, expect, vi } from "vitest";
import {
  runDeployPreflight,
  resolveNetwork,
  CANONICAL_PASSPHRASES,
  CANONICAL_RPC_URLS,
  runDeployDryRun,
  buildResumePlan,
  DEPLOY_STAGES,
  type DeployStage,
  type DeploymentStateRecord,
} from "./deploy-preflight";

// Valid testnet addresses for testing
const VALID_CONTRACT_1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const VALID_CONTRACT_2 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const VALID_DEPLOYER   = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("deployPreflight", () => {
  it("resolveNetwork: resolves explicit network argument first", () => {
    const net = resolveNetwork("futurenet", { NETWORK: "testnet" } as any);
    expect(net).toBe("futurenet");
  });

  it("resolveNetwork: enforces no silent fallback to testnet in production", () => {
    expect(() => resolveNetwork(undefined, { NODE_ENV: "production" } as any)).toThrow(
      /Silent testnet defaults are disabled in production/
    );
  });

  it("missing values: rejects when production mainnet configuration lacks passphrase or RPC", async () => {
    const report = await runDeployPreflight(
      {
        network: "mainnet",
        // omitting rpcUrl and networkPassphrase
        rpcClient: { getNetwork: async () => ({ passphrase: CANONICAL_PASSPHRASES.mainnet }) },
      },
      { NODE_ENV: "production" } as any
    );

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("NETWORK_PASSPHRASE is required for mainnet"))).toBe(true);
    expect(report.errors.some((e) => e.includes("STELLAR_RPC_URL is required for mainnet"))).toBe(true);
  });

  it("malformed addresses: rejects invalid contract ID and deployer key", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      deployerPublicKey: "G_INVALID_ACCOUNT_KEY",
      contractAddresses: {
        circleFactory: "C_MALFORMED_CONTRACT_ID",
        reputation: VALID_CONTRACT_1,
      },
      rpcClient: { getNetwork: async () => ({ passphrase: CANONICAL_PASSPHRASES.testnet }) },
    });

    expect(report.ok).toBe(false);
    expect(report.verifiedFacts.addressTypesValid).toBe(false);
    expect(report.errors.some((e) => e.includes("Invalid deployer public key"))).toBe(true);
    expect(report.errors.some((e) => e.includes("Invalid contract address for circleFactory"))).toBe(true);
  });

  it("passphrase mismatch: rejects testnet passphrase when network is mainnet", async () => {
    const report = await runDeployPreflight({
      network: "mainnet",
      rpcUrl: "https://soroban.stellar.org",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet, // WRONG!
      rpcClient: { getNetwork: async () => ({ passphrase: CANONICAL_PASSPHRASES.mainnet }) },
    });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("Passphrase mismatch"))).toBe(true);
  });

  it("passphrase mismatch: detects live RPC network mismatch", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet,
      rpcUrl: CANONICAL_RPC_URLS.testnet,
      rpcClient: {
        getNetwork: async () => ({ passphrase: "Different Network Passphrase ; 2026" }),
      },
    });

    expect(report.ok).toBe(false);
    expect(report.verifiedFacts.remoteRpcStatus).toBe("mismatch");
    expect(report.errors.some((e) => e.includes("Remote RPC passphrase mismatch"))).toBe(true);
  });

  it("RPC outage: reported separately as unavailable without altering requested network", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet,
      rpcUrl: CANONICAL_RPC_URLS.testnet,
      strict: false,
      rpcClient: {
        getNetwork: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
        },
      },
    });

    // Non-strict: local config is valid, outage reported separately as unavailable
    expect(report.ok).toBe(true);
    expect(report.configuredFacts.resolvedNetwork).toBe("testnet"); // requested network preserved
    expect(report.verifiedFacts.remoteRpcStatus).toBe("unavailable");
    expect(report.verifiedFacts.remoteRpcError?.includes("ECONNREFUSED")).toBe(true);
    expect(report.warnings.some((w) => w.includes("Remote RPC check unavailable"))).toBe(true);
  });

  it("RPC outage: strict mode rejects when live check is unavailable", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet,
      rpcUrl: CANONICAL_RPC_URLS.testnet,
      strict: true,
      rpcClient: {
        getNetwork: async () => {
          throw new Error("Network timeout after 5000ms");
        },
      },
    });

    expect(report.ok).toBe(false);
    expect(report.verifiedFacts.remoteRpcStatus).toBe("unavailable");
    expect(report.errors.some((e) => e.includes("Strict preflight failed: Live RPC check"))).toBe(true);
  });

  it("fully consistent profile: passes all validations and verifies remote RPC", async () => {
    const report = await runDeployPreflight({
      network: "testnet",
      networkPassphrase: CANONICAL_PASSPHRASES.testnet,
      rpcUrl: CANONICAL_RPC_URLS.testnet,
      deployerPublicKey: VALID_DEPLOYER,
      contractAddresses: {
        reputation: VALID_CONTRACT_1,
        circleFactory: VALID_CONTRACT_2,
      },
      rpcClient: {
        getNetwork: async () => ({
          passphrase: CANONICAL_PASSPHRASES.testnet,
          protocolVersion: 21,
        }),
      },
    });

    expect(report.ok).toBe(true);
    expect(report.errors.length).toBe(0);
    expect(report.configuredFacts.resolvedNetwork).toBe("testnet");
    expect(report.verifiedFacts.addressTypesValid).toBe(true);
    expect(report.verifiedFacts.remoteRpcStatus).toBe("verified");
    expect(report.verifiedFacts.remoteRpcProtocolVersion).toBe(21);
  });

  it("validates token assumptions when USDC address is configured", async () => {
    const report = await runDeployPreflight({
      network: "mainnet",
      networkPassphrase: CANONICAL_PASSPHRASES.mainnet,
      rpcUrl: "https://soroban.stellar.org",
      contractAddresses: {
        usdc: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM", // Not canonical mainnet
      },
      rpcClient: {
        getNetwork: async () => ({
          passphrase: CANONICAL_PASSPHRASES.mainnet,
          protocolVersion: 21,
        }),
      },
    });

    expect(report.ok).toBe(false);
    expect(report.verifiedFacts.tokenStatus).toBe("mismatch");
    expect(report.errors.some((e) => e.includes("canonical Mainnet USDC SAC address"))).toBe(true);
  });
});

describe("deployDryRun", () => {
  const validInputs = () => ({
    network: "testnet" as const,
    networkPassphrase: CANONICAL_PASSPHRASES.testnet,
    rpcUrl: CANONICAL_RPC_URLS.testnet,
    deployerPublicKey: VALID_DEPLOYER,
    contractAddresses: {
      reputation: VALID_CONTRACT_1,
      circleFactory: VALID_CONTRACT_2,
    },
    artifacts: {
      reputation: { exists: true, path: "target/wasm32/reputation.wasm" },
      circleFactory: { exists: true, path: "target/wasm32/circle_factory.wasm" },
    },
    rpcClient: {
      getNetwork: async () => ({
        passphrase: CANONICAL_PASSPHRASES.testnet,
        protocolVersion: 21,
      }),
    },
  });

  it("reports target network and intended operations without signing", async () => {
    const signer = vi.fn();
    const result = await runDeployDryRun(validInputs(), { signer });

    expect(result.ok).toBe(true);
    expect(result.targetNetwork).toBe("testnet");
    expect(result.intendedOperations.length).toBeGreaterThan(0);
    expect(result.intendedOperations.some((op) => op.includes("reputation"))).toBe(true);
    expect(signer).not.toHaveBeenCalled();
    expect(result.signerInvoked).toBe(false);
  });

  it("missing artifacts: reports every missing artifact before any write", async () => {
    const signer = vi.fn();
    const inputs = validInputs();
    inputs.artifacts = {
      reputation: { exists: false, path: "target/wasm32/reputation.wasm" },
      circleFactory: { exists: false, path: "target/wasm32/circle_factory.wasm" },
    };

    const result = await runDeployDryRun(inputs, { signer });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Missing artifact for reputation"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Missing artifact for circleFactory"))).toBe(true);
    expect(result.intendedOperations.length).toBe(0);
    expect(signer).not.toHaveBeenCalled();
  });

  it("invalid network: reports before any write", async () => {
    const signer = vi.fn();
    const inputs = validInputs();
    (inputs as any).network = "not-a-network";

    const result = await runDeployDryRun(inputs, { signer });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Unknown network"))).toBe(true);
    expect(signer).not.toHaveBeenCalled();
  });

  it("wrong token: reports token mismatch before any write", async () => {
    const signer = vi.fn();
    const inputs = validInputs();
    (inputs as any).network = "mainnet";
    (inputs as any).networkPassphrase = CANONICAL_PASSPHRASES.mainnet;
    (inputs as any).rpcUrl = "https://soroban.stellar.org";
    inputs.contractAddresses = {
      ...inputs.contractAddresses,
      usdc: VALID_CONTRACT_1, // not canonical mainnet
    };
    inputs.rpcClient = {
      getNetwork: async () => ({
        passphrase: CANONICAL_PASSPHRASES.mainnet,
        protocolVersion: 21,
      }),
    };

    const result = await runDeployDryRun(inputs, { signer });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("canonical Mainnet USDC SAC address"))).toBe(true);
    expect(signer).not.toHaveBeenCalled();
  });

  it("existing manifest: reports inconsistent manifest state before any write", async () => {
    const signer = vi.fn();
    const inputs = validInputs();
    (inputs as any).existingManifest = {
      network: "testnet",
      contracts: {
        reputation: VALID_CONTRACT_1,
        circleFactory: VALID_CONTRACT_2,
      },
      complete: false,
    };

    const result = await runDeployDryRun(inputs, { signer });

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Existing manifest is incomplete"))).toBe(true);
    expect(result.errors.some((e) => e.includes("--resume"))).toBe(true);
    expect(signer).not.toHaveBeenCalled();
  });

  it("RPC unavailability: reported without signing", async () => {
    const signer = vi.fn();
    const inputs = validInputs();
    inputs.rpcClient = {
      getNetwork: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
      },
    };

    const result = await runDeployDryRun(inputs, { signer });

    expect(result.verifiedFacts.remoteRpcStatus).toBe("unavailable");
    expect(result.warnings.some((w) => w.includes("Remote RPC check unavailable"))).toBe(true);
    expect(signer).not.toHaveBeenCalled();
  });

  it("reports every locally detectable failure at once", async () => {
    const signer = vi.fn();
    const inputs = validInputs();
    (inputs as any).network = "not-a-network";
    inputs.deployerPublicKey = "G_INVALID_ACCOUNT_KEY";
    inputs.artifacts = {
      reputation: { exists: false, path: "target/wasm32/reputation.wasm" },
      circleFactory: { exists: false, path: "target/wasm32/circle_factory.wasm" },
    };

    const result = await runDeployDryRun(inputs, { signer });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(signer).not.toHaveBeenCalled();
  });
});

describe("buildResumePlan", () => {
  const baseState = (): DeploymentStateRecord => ({
    network: "testnet",
    operations: DEPLOY_STAGES.map((stage) => ({
      stage,
      status: "pending" as const,
    })),
  });

  const markThrough = (
    state: DeploymentStateRecord,
    lastCompleted: DeployStage | null
  ): DeploymentStateRecord => {
    const idx = lastCompleted ? DEPLOY_STAGES.indexOf(lastCompleted) : -1;
    return {
      ...state,
      operations: state.operations.map((op, i) => ({
        ...op,
        status: i <= idx ? "complete" : "pending",
        txHash: i <= idx ? `tx-${op.stage}` : undefined,
      })),
    };
  };

  it("fresh state: plans all stages as mutating steps", () => {
    const plan = buildResumePlan(baseState());
    expect(plan.isResumable).toBe(true);
    expect(plan.steps.length).toBe(DEPLOY_STAGES.length);
    expect(plan.steps.every((s) => s.action === "execute")).toBe(true);
    expect(plan.requiresConfirmation).toBe(true);
  });

  it.each(DEPLOY_STAGES)(
    "interruption after %s: plan resumes remaining stages without duplication",
    (stage) => {
      const state = markThrough(baseState(), stage);
      const plan = buildResumePlan(state);

      expect(plan.isResumable).toBe(true);
      const completedIdx = DEPLOY_STAGES.indexOf(stage);
      plan.steps.forEach((step, i) => {
        if (i <= completedIdx) {
          expect(step.action).toBe("skip");
        } else {
          expect(step.action).toBe("execute");
        }
      });
      expect(plan.requiresConfirmation).toBe(true);
    }
  );

  it("interruption after upload: reuses existing uploaded artifact rather than redeploying", () => {
    const state = markThrough(baseState(), "upload");
    const plan = buildResumePlan(state);
    const deployStep = plan.steps.find((s) => s.stage === "deploy");
    expect(deployStep?.action).toBe("execute");
    expect(plan.steps.find((s) => s.stage === "upload")?.action).toBe("skip");
  });

  it("address exists but no tx hash: never infers safe reuse", () => {
    const state = baseState();
    state.operations = state.operations.map((op) =>
      op.stage === "deploy"
        ? { ...op, status: "started" as const, address: VALID_CONTRACT_1 }
        : op
    );
    const plan = buildResumePlan(state);

    expect(plan.isResumable).toBe(false);
    expect(plan.errors.some((e) => e.includes("address exists without transaction evidence"))).toBe(true);
  });

  it("partial state never yields a complete manifest", () => {
    const state = markThrough(baseState(), "deploy");
    const plan = buildResumePlan(state);
    expect(plan.resultingManifestComplete).toBe(false);
  });

  it("all stages complete: resulting manifest is complete", () => {
    const state = markThrough(baseState(), DEPLOY_STAGES[DEPLOY_STAGES.length - 1]);
    const plan = buildResumePlan(state);
    expect(plan.isResumable).toBe(true);
    expect(plan.steps.every((s) => s.action === "skip")).toBe(true);
    expect(plan.resultingManifestComplete).toBe(true);
  });
});
