/**
 * Public API usage fixture for @circleup/sdk (issue #348).
 *
 * Every import below comes from the package root ("@circleup/sdk") — there are
 * no deep "@circleup/sdk/dist/..." or "../src/..." paths. If this file
 * type-checks, the documented public surface is reachable from the root exactly
 * as a consumer would use it, and the declaration output exposes those symbols.
 *
 * Compiled by examples/tsconfig.json (which maps "@circleup/sdk" to the package
 * entry point). Excluded from the published build. Side-effect free — nothing
 * runs at import time, so it is safe to include in a type-check step.
 */
import {
  // Clients
  CircleUpClient,
  // Errors
  GateError,
  IndexerError,
  // Config & network
  getNetworkConfig,
  TESTNET_RPC_URL,
  TESTNET_PASSPHRASE,
  // Units
  usdcToStroops,
  stroopsToUsdc,
  formatUsdc,
  STROOPS_PER_USDC,
  // Gating
  computeActionEligibility,
  isGateBlocked,
  // Types (type-only imports also resolve from the root)
  type CircleUpConfig,
  type NetworkConfig,
  type StateSnapshot,
} from "@circleup/sdk";

/** Construct the top-level client from the documented config shape. */
export function makeClient(): CircleUpClient {
  const config: CircleUpConfig = {
    rpcUrl: TESTNET_RPC_URL,
    networkPassphrase: TESTNET_PASSPHRASE,
    contracts: {
      circleFactory: "C".padEnd(56, "A"),
      reputation: "C".padEnd(56, "B"),
      usdc: "C".padEnd(56, "D"),
    },
    indexerUrl: "http://localhost:3001",
  };
  return new CircleUpClient(config);
}

/** Resolve a network's RPC + passphrase via the documented helper. */
export function testnetConfig(): NetworkConfig {
  return getNetworkConfig("testnet");
}

/** Round-trip an amount through the documented unit helpers. */
export function money(): { stroops: bigint; usdc: string; display: string } {
  const stroops = usdcToStroops(100);
  return {
    stroops,
    usdc: stroopsToUsdc(stroops),
    display: `${formatUsdc(stroops)} (1 USDC = ${STROOPS_PER_USDC} stroops)`,
  };
}

/** Gate an action against a snapshot the caller already holds. */
export function contributeBlockReason(snapshot: StateSnapshot): string | null {
  const result = computeActionEligibility("contribute", snapshot, {
    hasContributedCurrentRound: false,
  });
  return isGateBlocked(result) ? result.message : null;
}

/** Distinguish the SDK's public error types. */
export function describeError(err: unknown): string {
  if (err instanceof GateError) return `gate blocked (${err.reason}): ${err.message}`;
  if (err instanceof IndexerError) return `indexer ${err.status} at ${err.url}: ${err.message}`;
  return "unknown error";
}
