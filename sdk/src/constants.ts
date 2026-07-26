// ─── Network constants shared across all CircleUp packages ───────────────────

export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const MAINNET_RPC_URL = "https://soroban-mainnet.stellar.org";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Stellar Friendbot endpoint (testnet only) */
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

/** 1 USDC = 10,000,000 stroops (7 decimal places) */
export const USDC_DECIMALS = 7;
export const STROOPS_PER_USDC = 10_000_000;

/** Approximate ledgers per day at ~5 seconds per ledger */
export const LEDGERS_PER_DAY = 17_280;
export const LEDGERS_PER_WEEK = LEDGERS_PER_DAY * 7;
export const LEDGERS_PER_MONTH = LEDGERS_PER_DAY * 30;

/** Default penalty for a missed contribution: 20% of collateral */
export const DEFAULT_PENALTY_BPS = 2_000; // 20%
export const BPS_DENOM = 10_000;

// ─── Network config helpers ───────────────────────────────────────────────────

/** Identifies which Stellar network to target. */
export type NetworkName = "testnet" | "mainnet";

/**
 * All the network-level constants needed to initialise an RPC client or build
 * a `CircleUpConfig`.  Prefer using `getNetworkConfig` over hard-coding these
 * values directly so callers get a clear error when an unsupported network is
 * requested.
 */
export interface NetworkConfig {
  network: NetworkName;
  rpcUrl: string;
  passphrase: string;
  /**
   * Friendbot URL for funding accounts.  Only available on testnet; `null` on
   * mainnet so callers can branch without an extra network check.
   */
  friendbotUrl: string | null;
}

const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    network: "testnet",
    rpcUrl: TESTNET_RPC_URL,
    passphrase: TESTNET_PASSPHRASE,
    friendbotUrl: FRIENDBOT_URL,
  },
  mainnet: {
    network: "mainnet",
    rpcUrl: MAINNET_RPC_URL,
    passphrase: MAINNET_PASSPHRASE,
    friendbotUrl: null,
  },
};

/**
 * Return the `NetworkConfig` for the requested network.
 *
 * Throws a descriptive `Error` when an unrecognised network name is passed so
 * misconfigured callers get an explicit message rather than a silent `undefined`
 * access downstream.
 *
 * @example
 * const cfg = getNetworkConfig("testnet");
 * const rpc = new SorobanRpc.Server(cfg.rpcUrl);
 */
export function getNetworkConfig(network: NetworkName): NetworkConfig {
  const cfg = NETWORK_CONFIGS[network];
  if (!cfg) {
    const valid = Object.keys(NETWORK_CONFIGS).join(", ");
    throw new Error(
      `Unknown network "${network}". Valid options are: ${valid}.`,
    );
  }
  return cfg;
}

/**
 * Return `true` when the given string is a recognised `NetworkName`.
 * Useful for validating user input or environment variable values before
 * calling `getNetworkConfig`.
 *
 * @example
 * const raw = process.env.NETWORK ?? "";
 * if (!isValidNetwork(raw)) throw new Error(`Invalid NETWORK env var: "${raw}"`);
 * const cfg = getNetworkConfig(raw);
 */
export function isValidNetwork(value: string): value is NetworkName {
  return value === "testnet" || value === "mainnet";
}
