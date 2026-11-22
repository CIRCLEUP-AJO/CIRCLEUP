// --- sdk/src/errors.ts --------------------------------------------------------
//
// Public SDK error taxonomy (issue #901). The SDK crosses wallet, RPC,
// simulation, submission, polling, and indexer boundaries, each of which used
// to fail with its own shape (TxFailure, WalletFailure, IndexerError,
// RpcReadCancelledError, plain Error). `classifySdkError` maps every one of
// them onto a single stable shape:
//
//   { stage, code, retry, retryable, txHash?, message }
//
// Branch on `code` (and `stage`) — never on message text. `message` is an
// SDK-authored, log-safe sentence: provider/RPC/wallet text is NOT copied into
// it, so it can be shown to users and attached to support tickets. The raw
// source stays available on `SdkError.cause` for local debugging only.
//
// Unknown inputs always classify as `code: "unknown"` — never as a more
// specific category the SDK cannot prove.

import type { TxErrorCode, TxFailure } from "./types";
import type { WalletFailure } from "./walletAdapter";
import { RpcReadCancelledError, classifyRpcFailure } from "./rpcRetry";

/** Where in an SDK operation an error happened. */
export type SdkErrorStage =
  | "validation"
  | "config"
  | "wallet"
  | "account"
  | "simulation"
  | "submission"
  | "polling"
  | "read"
  | "indexer"
  | "unknown";

/**
 * Stable, machine-readable error category.
 *
 * | Code                  | Meaning |
 * |-----------------------|---------|
 * | `invalid_input`       | SDK-side validation rejected the call; nothing was sent. |
 * | `network_mismatch`    | Wallet or client is on a different network than configured. |
 * | `wallet_rejected`     | The user declined the wallet prompt. Nothing was signed. |
 * | `wallet_unavailable`  | No wallet, not connected, or a required capability is missing. |
 * | `wallet_error`        | The wallet failed or returned an unusable value. |
 * | `account_not_found`   | The source account does not exist on the network. |
 * | `contract_error`      | Simulation returned a numeric contract error (see `TxFailure.contractError`). |
 * | `simulation_failed`   | Simulation rejected the call without a contract error code. |
 * | `stale_state`         | On-chain state moved past the caller's expectations. |
 * | `transport`           | A network-level failure; the request did not complete. |
 * | `throttled`           | Rate-limited or congested; try again later. |
 * | `cancelled`           | Stopped locally by a deadline or AbortSignal. |
 * | `tx_rejected`         | The RPC rejected the transaction; it was not applied. |
 * | `tx_expired`          | The transaction expired unincluded; it was not applied. |
 * | `send_ambiguous`      | The write may or may not have been applied — look `txHash` up. |
 * | `poll_timeout`        | The SDK stopped waiting for confirmation; the tx may still confirm. |
 * | `rpc_stale`           | The RPC stopped advancing; check the hash elsewhere. |
 * | `on_chain_failed`     | The transaction was included and failed. |
 * | `indexer_response`    | The indexer answered with an error or an unexpected payload. |
 * | `indexer_unavailable` | The indexer could not be reached or timed out. |
 * | `unknown`             | Unclassified. Treated as not retryable. |
 */
export type SdkErrorCode =
  | "invalid_input"
  | "network_mismatch"
  | "wallet_rejected"
  | "wallet_unavailable"
  | "wallet_error"
  | "account_not_found"
  | "contract_error"
  | "simulation_failed"
  | "stale_state"
  | "transport"
  | "throttled"
  | "cancelled"
  | "tx_rejected"
  | "tx_expired"
  | "send_ambiguous"
  | "poll_timeout"
  | "rpc_stale"
  | "on_chain_failed"
  | "indexer_response"
  | "indexer_unavailable"
  | "unknown";

/**
 * What a caller may do next:
 * - `"safe"` — repeating the operation cannot duplicate a write.
 * - `"after_lookup"` — a write may be in flight; look `txHash` up first.
 * - `"never"` — repeating will fail the same way (or needs a user decision).
 */
export type SdkRetryAdvice = "safe" | "after_lookup" | "never";

/** The stable, log-safe classification of any SDK failure. */
export interface SdkErrorInfo {
  readonly stage: SdkErrorStage;
  readonly code: SdkErrorCode;
  readonly retry: SdkRetryAdvice;
  /** Shorthand for `retry === "safe"`. */
  readonly retryable: boolean;
  /** Present whenever a signed transaction exists that the network may have seen. */
  readonly txHash?: string;
  /** SDK-authored, log-safe message. Never contains provider text. */
  readonly message: string;
}

const MESSAGES: Record<SdkErrorCode, string> = {
  invalid_input: "The request was rejected by SDK validation before anything was sent.",
  network_mismatch: "The wallet or client is configured for a different network.",
  wallet_rejected: "The wallet request was declined. Nothing was signed.",
  wallet_unavailable: "No usable wallet connection is available for this operation.",
  wallet_error: "The wallet failed to complete the request.",
  account_not_found: "The source account does not exist on this network.",
  contract_error: "The contract rejected this call.",
  simulation_failed: "The call could not be simulated against current on-chain state.",
  stale_state: "On-chain state changed. Refresh and review the action.",
  transport: "The network request did not complete.",
  throttled: "The service is busy. Try again shortly.",
  cancelled: "The operation was stopped before it completed. No on-chain state was changed by stopping it.",
  tx_rejected: "The network rejected the transaction. It was not applied.",
  tx_expired: "The transaction expired without being included. It was not applied.",
  send_ambiguous: "The transaction may or may not have been applied. Look up the hash before resubmitting.",
  poll_timeout: "Stopped waiting for confirmation. The transaction may still confirm — look up the hash.",
  rpc_stale: "The RPC is behind the network. Check the transaction hash later or on another RPC.",
  on_chain_failed: "The transaction was included in a ledger and failed.",
  indexer_response: "The indexer returned an error or an unexpected response.",
  indexer_unavailable: "The indexer could not be reached.",
  unknown: "An unexpected error occurred.",
};

const TX_HASH_RE = /^[0-9a-f]{64}$/i;

function info(
  stage: SdkErrorStage,
  code: SdkErrorCode,
  retry: SdkRetryAdvice,
  txHash?: unknown,
): SdkErrorInfo {
  return {
    stage,
    code,
    retry,
    retryable: retry === "safe",
    ...(typeof txHash === "string" && TX_HASH_RE.test(txHash) ? { txHash: txHash.toLowerCase() } : {}),
    message: MESSAGES[code],
  };
}

/** Stage, code, and retry advice for every {@link TxErrorCode}. Exhaustive by type. */
const TX_CODE_MAP: Record<TxErrorCode, readonly [SdkErrorStage, SdkErrorCode, SdkRetryAdvice]> = {
  invalid_argument: ["validation", "invalid_input", "never"],
  network_mismatch: ["config", "network_mismatch", "never"],
  account_not_found: ["account", "account_not_found", "never"],
  simulation_failed: ["simulation", "simulation_failed", "never"],
  stale_state: ["validation", "stale_state", "never"],
  network_error: ["submission", "transport", "safe"],
  try_again_later: ["submission", "throttled", "safe"],
  tx_rejected: ["submission", "tx_rejected", "safe"],
  tx_expired: ["polling", "tx_expired", "safe"],
  outcome_unknown: ["submission", "send_ambiguous", "after_lookup"],
  timeout: ["polling", "poll_timeout", "after_lookup"],
  stale_rpc: ["polling", "rpc_stale", "after_lookup"],
  tx_failed: ["polling", "on_chain_failed", "never"],
  unknown: ["unknown", "unknown", "never"],
};

/**
 * Classify a {@link TxFailure}. Unknown `errorCode` values (e.g. from a newer
 * SDK or a hand-built object) fall back to `"unknown"`; a failure that carries
 * a hash but an unknown code is advised `"after_lookup"`, never `"safe"`.
 */
export function classifyTxFailure(failure: TxFailure): SdkErrorInfo {
  const hash = failure.txHash || failure.diagnostics?.txHash;
  const entry = Object.prototype.hasOwnProperty.call(TX_CODE_MAP, failure.errorCode)
    ? TX_CODE_MAP[failure.errorCode]
    : undefined;
  if (!entry) return info("unknown", "unknown", hash ? "after_lookup" : "never", hash);
  const [stage, code, retry] = entry;
  // A numeric contract error is more specific than a generic simulation failure.
  if (failure.errorCode === "simulation_failed" && failure.contractError) {
    return info("simulation", "contract_error", "never");
  }
  if (failure.errorCode === "unknown" && hash) return info(stage, code, "after_lookup", hash);
  // Expired / rejected / never-sent writes are safe to rebuild; keep the hash
  // for support even then.
  return info(stage, code, retry, hash);
}

/** Classify a {@link WalletFailure}. Wallet rejections are never retried automatically. */
export function classifyWalletFailure(failure: WalletFailure): SdkErrorInfo {
  switch (failure.reason) {
    case "user_rejected":
      return info("wallet", "wallet_rejected", "never");
    case "network_mismatch":
      return info("wallet", "network_mismatch", "never");
    case "not_available":
    case "not_connected":
    case "unsupported_capability":
    case "account_mismatch":
      return info("wallet", "wallet_unavailable", "never");
    case "provider_error":
      return info("wallet", "wallet_error", "never");
    default:
      return info("wallet", "unknown", "never");
  }
}

function isTxFailureShape(v: unknown): v is TxFailure {
  return typeof v === "object" && v !== null && (v as { success?: unknown }).success === false &&
    typeof (v as { errorCode?: unknown }).errorCode === "string";
}

function isWalletFailureShape(v: unknown): v is WalletFailure {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false &&
    typeof (v as { reason?: unknown }).reason === "string";
}

/**
 * Classify any SDK failure — a `TxFailure`, `WalletFailure`, `IndexerError`,
 * `RpcReadCancelledError`, `SdkError`, or an arbitrary thrown provider error —
 * into a stable {@link SdkErrorInfo}.
 *
 * `stage` is used for thrown provider errors, whose shape does not say where
 * they came from (default `"read"`). Provider text is only *matched* to pick
 * a category; it is never copied into the result.
 */
export function classifySdkError(err: unknown, stage: SdkErrorStage = "read"): SdkErrorInfo {
  if (err instanceof SdkError) return err.info;
  if (isTxFailureShape(err)) return classifyTxFailure(err);
  if (isWalletFailureShape(err)) return classifyWalletFailure(err);
  if (err instanceof RpcReadCancelledError) return info(stage, "cancelled", "never");
  if (err instanceof Error && err.name === "IndexerError") {
    const kind = (err as { kind?: unknown }).kind;
    const status = Number((err as { status?: unknown }).status);
    if (kind === "aborted") return info("indexer", "cancelled", "never");
    if (kind === "network" || kind === "timeout") return info("indexer", "indexer_unavailable", "safe");
    if (kind === "http" && status === 429) return info("indexer", "throttled", "safe");
    if (kind === "http" && status >= 500) return info("indexer", "indexer_unavailable", "safe");
    if (kind === "http" || kind === "json" || kind === "schema") return info("indexer", "indexer_response", "never");
    return info("indexer", "unknown", "never");
  }
  if (err instanceof RangeError) {
    // The SDK throws RangeError for invalid caller input (options, encoders).
    // TypeError is not mapped here: `fetch` reports network failures with it.
    return info("validation", "invalid_input", "never");
  }
  if (err == null) return info("unknown", "unknown", "never");

  // Only read stages are safe to retry on a transient transport error; a
  // write stage that failed this way may have reached the server.
  const readStage = stage === "read" || stage === "account" || stage === "simulation" || stage === "polling";
  switch (classifyRpcFailure(err)) {
    case "cancelled":
      return info(stage, "cancelled", "never");
    case "throttled":
      return info(stage, "throttled", readStage ? "safe" : "after_lookup");
    case "transient":
      return info(stage, "transport", readStage ? "safe" : "after_lookup");
    case "permanent":
    default:
      return info(stage, "unknown", "never");
  }
}

/**
 * A thrown SDK error carrying a stable {@link SdkErrorInfo}. `message` is the
 * log-safe SDK message; the original value, when any, is kept on `cause` for
 * local debugging and is non-enumerable so it is not serialised by
 * `JSON.stringify`.
 */
export class SdkError extends Error {
  readonly info: SdkErrorInfo;
  readonly stage: SdkErrorStage;
  readonly code: SdkErrorCode;
  readonly retry: SdkRetryAdvice;
  readonly retryable: boolean;
  readonly txHash?: string;

  constructor(info: SdkErrorInfo, cause?: unknown) {
    super(info.message);
    this.name = "SdkError";
    this.info = info;
    this.stage = info.stage;
    this.code = info.code;
    this.retry = info.retry;
    this.retryable = info.retryable;
    if (info.txHash !== undefined) this.txHash = info.txHash;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, enumerable: false, writable: false });
    }
  }

  /** Wrap any failure in an `SdkError` (returns `err` unchanged when it already is one). */
  static from(err: unknown, stage?: SdkErrorStage): SdkError {
    return err instanceof SdkError ? err : new SdkError(classifySdkError(err, stage), err);
  }

  /** The log-safe fields only — what to attach to telemetry or a support ticket. */
  toJSON(): SdkErrorInfo {
    return this.info;
  }
}

/** `true` when `err` is an {@link SdkError}. */
export function isSdkError(err: unknown): err is SdkError {
  return err instanceof SdkError;
}
