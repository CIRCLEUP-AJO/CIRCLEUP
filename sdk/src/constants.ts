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
