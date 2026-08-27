// ─── @circleup/sdk — public API surface ──────────────────────────────────────
//
// This file is the *only* supported entry point for the package. Everything a
// consumer needs is re-exported here; importing from deep paths such as
// "@circleup/sdk/dist/client" is NOT part of the stable contract and may break
// between releases.
//
// The public API, by group:
//
//   Clients        CircleUpClient (top-level facade), FactoryClient,
//                  CircleClient, ReputationClient, IndexerClient
//   Errors         GateError, IndexerError
//   Config & types CircleUpConfig, NetworkConfig, NetworkName, CircleStatus,
//                  CircleConfig, RoundState, CircleFullState, and the indexer
//                  response types (ApiCircleRow, ApiCircleDetailResponse, …)
//   Gating         computeActionEligibility, buildSnapshot, isGateAllowed,
//                  isGateBlocked, StateSnapshot, GateResult, GateOptions
//   Utilities      usdcToStroops, stroopsToUsdc, formatUsdc, formatPot,
//                  daysToLedgers, ledgersToDays, shortAddress, sleep
//   Constants      TESTNET_/MAINNET_ RPC URLs + passphrases, getNetworkConfig,
//                  isValidNetwork, USDC_DECIMALS, STROOPS_PER_USDC, LEDGERS_PER_*
//   Low-level      scAddress, scU32, scI128, scBool, scAddressVec — ScVal
//                  encoders for advanced callers building raw contract args.
//
// Internal modules (test files, and any module not re-exported below) are
// private: they are excluded from the published build and carry no stability
// guarantee. See examples/public-api.ts for a root-only usage sample.
//
// Re-export order is deliberate — constants → types → utils → gating → client —
// so every symbol has a single canonical source (e.g. `NetworkConfig` comes
// from constants, not transitively through another module).

export * from "./constants"; // network URLs/passphrases, getNetworkConfig, unit + ledger constants
export * from "./types";     // CircleUpConfig, CircleStatus, CircleConfig, RoundState, indexer read models, …
export * from "./utils";     // usdcToStroops, stroopsToUsdc, formatUsdc, shortAddress, …
export * from "./gating";    // StateSnapshot, GateResult, computeActionEligibility, buildSnapshot, …
export * from "./client";    // CircleUpClient, FactoryClient, CircleClient, ReputationClient, IndexerClient, GateError, IndexerError, ScVal encoders
