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
//   Errors         GateError, IndexerError (invalid indexer query options
//                  reject locally with a RangeError before any request),
//                  RpcReadCancelledError (an RPC read stopped by its deadline
//                  or the caller's AbortSignal — see ReadOptions)
//   Wallets        WalletAdapter, signWithWalletAdapter — optional provider
//                  boundary for SDK-assisted signing (no browser globals)
//   Recovery       isRetryable, CircleUpClient.lookupTransaction,
//                  CircleUpClient.waitForTransaction, SubmissionDiagnostics,
//                  TxLookup, RETRY_POLICY (stage-by-stage retry rules)
//   Lifecycle      txLifecycleFromResult, txLifecycleFromLookup, TxLifecycle —
//                  submitted / pending / confirmed / failed / unavailable
//   Error taxonomy SdkError, classifySdkError, classifyTxFailure,
//                  classifyWalletFailure, SdkErrorCode, SdkErrorStage
//   Network        resolveNetworkIdentity, NetworkIdentity,
//                  CircleUpClient.getNetworkIdentity / getResolvedConfig
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
//   Diagnostics    summarizeSimulation, SimulationEstimate — log-safe
//                  resource/fee estimates, plus ContractErrorDiagnostic on
//                  TxFailure for stable contract/method/code classification.
//
// Internal modules (test files, and any module not re-exported below) are
// private: they are excluded from the published build and carry no stability
// guarantee. See examples/public-api.ts for a root-only usage sample.
//
// Re-export order is deliberate — constants → types → utils → gating → client —
// so every symbol has a single canonical source (e.g. `NetworkConfig` comes
// from constants, not transitively through another module).
//
// client.ts is re-exported by name rather than with `export *`: it also holds
// helpers exported only for its unit tests (isTransientRpcError, withRpcRetry,
// mayHaveReachedServer), and a wildcard would publish them as stable API.
// scripts/check-public-api.cjs fails the release check if they reappear here.

export * from "./constants"; // network URLs/passphrases, getNetworkConfig, unit + ledger + indexer paging constants
export * from "./types";     // CircleUpConfig, CircleStatus, CircleConfig, RoundState, decoders, indexer read models, …
export * from "./utils";     // usdcToStroops, stroopsToUsdc, formatUsdc, shortAddress, …
export * from "./gating";    // StateSnapshot, GateResult, computeActionEligibility, buildSnapshot, …
export * from "./penalty";   // computeDefaultPenalty, projectCollateralAfterDefaults, PENALTY_ROUNDING (#874)
export * from "./rotation";  // payoutSchedule, recipientForRound, payoutSlotOf (#873)

export {
  // Base client (from circleUpClient.ts)
  CircleUpClient,
  // Read-error classifiers
  isConfigAbsent,
  isCircleNotActive,
  // Defaults
  DEFAULT_POLL_CONFIG,
  DEFAULT_FULL_STATE_CACHE_TTL_MS,
  DEFAULT_RPC_READ_TIMEOUT_MS,
  // Read deadlines & cancellation (issue #899)
  RpcReadCancelledError,
  isRpcReadCancelled,
  // Stage-by-stage retry policy (issue #900)
  RETRY_POLICY,
  classifyRpcFailure,
  // Low-level ScVal encoders
  scAddress,
  scU32,
  scI128,
  scBool,
  scAddressVec,
} from "./circleUpClient";

export type {
  PollConfig,
  ReadOptions,
  RpcReadCancelReason,
  RetryStage,
  RetryPolicy,
  RpcFailureClass,
  WriteOptions,
  TxLogPhase,
  TxLogEvent,
  TxLogger,
  CircleFullState,
  DeploymentCheck,
  DeploymentCheckName,
  DeploymentCheckStatus,
  DeploymentVerification,
  VerifyDeploymentOptions,
} from "./circleUpClient";

export {
  // Sub-clients (from client.ts)
  FactoryClient,
  CircleClient,
  ReputationClient,
  IndexerClient,
  // Errors
  GateError,
  IndexerError,
} from "./client";

export type {
  PreflightOptions,
  PreflightResult,
  PreflightFresh,
  PreflightStale,
} from "./client";

// Optional wallet-provider boundary (issue #904) — types and pre-sign checks
// only; no browser globals or wallet dependency, so server imports stay safe.
export { signWithWalletAdapter, requireWalletCapability, walletFailure } from "./walletAdapter";
export type {
  WalletAdapter,
  WalletCapability,
  WalletCapabilityReport,
  WalletFailure,
  WalletFailureReason,
  WalletResult,
  WalletSignOptions,
  SignWithWalletOptions,
} from "./walletAdapter";

// bigint serialization helpers (Issue #908)
export {
  bigintToDecimalString,
  decimalStringToBigInt,
  bigintReplacer,
  bigintReviver,
  serializeWithBigInt,
  deserializeWithBigInt,
} from "./serialization";
export type { BigIntWireString } from "./serialization";

export { transactionSupport } from "./support";
export type { SupportSummary } from "./support";

// Stable error taxonomy (issue #901).
export {
  SdkError,
  isSdkError,
  classifySdkError,
  classifyTxFailure,
  classifyWalletFailure,
} from "./errors";
export type { SdkErrorCode, SdkErrorStage, SdkErrorInfo, SdkRetryAdvice } from "./errors";

// Transaction lifecycle and finality (issue #902).
export { txLifecycleFromResult, txLifecycleFromLookup, isTxLifecycleSettled } from "./lifecycle";
export type {
  TxLifecycle,
  TxLifecycleState,
  TxNotApplied,
  TxSubmitted,
  TxPending,
  TxConfirmed,
  TxChainFailed,
  TxUnavailable,
} from "./lifecycle";

// Privacy-safe diagnostics and redaction (issue #912).
export {
  redactSecrets,
  redactAddresses,
  sanitizeEndpointUrl,
  isSafeTxHash,
  sanitizeDiagnosticsRecord,
  ALLOWLISTED_DIAGNOSTIC_FIELDS,
  MAX_SAFE_DIAGNOSTIC_LENGTH,
} from "./redact";
export type { AllowlistedDiagnosticField } from "./redact";

// ── Deprecated — planned removal in 0.4.0 (issue #909) ───────────────────────
export type { CircleDetailResponse } from "./types";

