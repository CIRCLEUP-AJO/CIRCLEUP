// --- sdk/src/lifecycle.ts -----------------------------------------------------
//
// Typed transaction lifecycle (issue #902). Submission and confirmation are
// separate events: a write can be accepted by the RPC and still be unobserved
// when the SDK's local polling budget runs out. These helpers turn a
// `TxResult` or a `lookupTransaction` result into one explicit state, so a
// client-side timeout is never mistaken for an on-chain failure.
//
// ── States and transitions ──
//
//   not_applied ◄── (validation, simulation, refused/rejected send, expiry)
//
//   submitted ──► pending ──► confirmed
//       │            │    └─► failed
//       │            └──────► not_applied (NOT_FOUND after validUntil)
//       └──► unavailable ──► (look the hash up again)
//
// | State         | Meaning                                                        | Fields                       | Resubmit? |
// |---------------|----------------------------------------------------------------|------------------------------|-----------|
// | `not_applied` | The SDK has evidence the write was never applied.              | `reason`, `txHash?`          | Yes, rebuild. |
// | `submitted`   | The RPC accepted the envelope; no confirmation observed since. | `txHash`                     | No — look up `txHash`. |
// | `pending`     | Looked up and not yet included (or local poll budget ran out). | `txHash`, `reason`, `submissionAccepted` | No — look up `txHash`. |
// | `confirmed`   | The configured RPC reports the transaction succeeded.          | `txHash`, `ledger`, `returnValue?` | — |
// | `failed`      | The configured RPC reports it was included and failed.         | `txHash`, `ledger?`          | Only after refreshing state. |
// | `unavailable` | The RPC could not be reached or is stale; fate is unknown.     | `txHash?`, `reason`          | No — look up `txHash` later. |
//
// ── Finality ──
//
// `confirmed` and `failed` reflect the configured RPC's `getTransaction`
// response (`source: "rpc"`). Stellar ledgers do not reorganise once closed,
// but the SDK only knows what that one endpoint reported; it makes no stronger
// claim. A missing record (NOT_FOUND) is never reported as a cancellation or a
// chain failure — it is `pending` until the transaction's time bound has
// provably passed, and only then `not_applied`.

import type { ReadResult } from "./validators";
import type { TxErrorCode, TxLookup, TxResult } from "./types";

/** Transaction lifecycle state; see the table in this module's header. */
export type TxLifecycleState =
  | "not_applied"
  | "submitted"
  | "pending"
  | "confirmed"
  | "failed"
  | "unavailable";

/** The write was never applied — safe to rebuild. */
export interface TxNotApplied {
  readonly state: "not_applied";
  /** The `TxErrorCode` (or `"tx_expired"` from a lookup) that proves it. */
  readonly reason: TxErrorCode;
  /** Present when a signed envelope existed (e.g. it was rejected or expired). */
  readonly txHash?: string;
  readonly resumable: false;
}

/** The RPC accepted the envelope; its confirmation has not been observed. */
export interface TxSubmitted {
  readonly state: "submitted";
  readonly txHash: string;
  readonly resumable: true;
}

/** Not (yet) included in a ledger according to the configured RPC. */
export interface TxPending {
  readonly state: "pending";
  readonly txHash: string;
  /**
   * `"poll_timeout"` — the SDK's local polling budget ran out;
   * `"not_found"` — a lookup answered NOT_FOUND before the time bound passed.
   */
  readonly reason: "poll_timeout" | "not_found";
  /** `false` when the RPC never confirmed it received the envelope. */
  readonly submissionAccepted: boolean;
  readonly resumable: true;
}

/** The configured RPC reports the transaction succeeded. */
export interface TxConfirmed {
  readonly state: "confirmed";
  readonly txHash: string;
  readonly ledger: number;
  readonly returnValue?: unknown;
  /** Confirmation is the configured RPC's report — not a stronger guarantee. */
  readonly source: "rpc";
  readonly resumable: false;
}

/** The configured RPC reports the transaction was included and failed. */
export interface TxChainFailed {
  readonly state: "failed";
  readonly txHash: string;
  /** Ledger of inclusion, when the source reported it. */
  readonly ledger?: number;
  readonly source: "rpc";
  readonly resumable: false;
}

/** The RPC could not settle the transaction's fate right now. */
export interface TxUnavailable {
  readonly state: "unavailable";
  /** Present whenever a signed envelope exists; look it up later. */
  readonly txHash?: string;
  /**
   * `"rpc_unreachable"` — lookups errored; `"rpc_stale"` — the RPC stopped
   * advancing; `"lookup_cancelled"` — the caller's deadline/signal stopped the
   * lookup; `"unknown"` — unclassified.
   */
  readonly reason: "rpc_unreachable" | "rpc_stale" | "lookup_cancelled" | "unknown";
  readonly resumable: boolean;
}

/** Discriminated union of every lifecycle state. Branch on `state`. */
export type TxLifecycle =
  | TxNotApplied
  | TxSubmitted
  | TxPending
  | TxConfirmed
  | TxChainFailed
  | TxUnavailable;

/** Error codes that mean the SDK has evidence the write was never applied. */
const NOT_APPLIED_CODES: ReadonlySet<TxErrorCode> = new Set<TxErrorCode>([
  "invalid_argument",
  "network_mismatch",
  "account_not_found",
  "simulation_failed",
  "network_error",
  "try_again_later",
  "tx_rejected",
  "tx_expired",
  "stale_state",
]);

/**
 * Map a write's {@link TxResult} to its lifecycle state.
 *
 * A `"timeout"` becomes `pending` (never `failed`); `"outcome_unknown"`
 * becomes `submitted`, `pending`, or `unavailable` depending on what its
 * `diagnostics` say; only `"tx_failed"` becomes `failed`.
 */
export function txLifecycleFromResult(result: TxResult): TxLifecycle {
  if (result.success) {
    return {
      state: "confirmed",
      txHash: result.txHash,
      ledger: result.ledger,
      ...(result.returnValue !== undefined ? { returnValue: result.returnValue } : {}),
      source: "rpc",
      resumable: false,
    };
  }
  const hash = result.txHash || result.diagnostics?.txHash || "";
  const code = result.errorCode;

  if (NOT_APPLIED_CODES.has(code)) {
    return { state: "not_applied", reason: code, ...(hash ? { txHash: hash } : {}), resumable: false };
  }
  switch (code) {
    case "tx_failed":
      return { state: "failed", txHash: hash, source: "rpc", resumable: false };
    case "timeout":
      return { state: "pending", txHash: hash, reason: "poll_timeout", submissionAccepted: true, resumable: true };
    case "stale_rpc":
      return { state: "unavailable", txHash: hash, reason: "rpc_stale", resumable: true };
    case "outcome_unknown": {
      const d = result.diagnostics;
      const accepted = d?.submission === "accepted";
      if (d?.lookup === "not_found") {
        return { state: "pending", txHash: hash, reason: "not_found", submissionAccepted: accepted, resumable: true };
      }
      if (accepted) return { state: "submitted", txHash: hash, resumable: true };
      return { state: "unavailable", txHash: hash, reason: "rpc_unreachable", resumable: true };
    }
    case "unknown":
    default:
      // No hash → the failure happened before a signed envelope existed.
      return hash
        ? { state: "unavailable", txHash: hash, reason: "unknown", resumable: true }
        : { state: "not_applied", reason: code, resumable: false };
  }
}

/**
 * Map a `lookupTransaction` result to its lifecycle state.
 *
 * Pass the envelope's `validUntil` (from `SubmissionDiagnostics.validUntil`)
 * to let a NOT_FOUND observed after the time bound resolve to `not_applied`;
 * without it, NOT_FOUND is always `pending` — never a cancellation.
 */
export function txLifecycleFromLookup(
  lookup: ReadResult<TxLookup>,
  options?: { txHash?: string; validUntil?: number; submissionAccepted?: boolean },
): TxLifecycle {
  if (!lookup.ok) {
    const cancelled = lookup.cancelled !== undefined;
    return {
      state: "unavailable",
      ...(options?.txHash ? { txHash: options.txHash } : {}),
      reason: cancelled ? "lookup_cancelled" : "rpc_unreachable",
      resumable: options?.txHash !== undefined,
    };
  }
  const v = lookup.value;
  switch (v.status) {
    case "success":
      return {
        state: "confirmed",
        txHash: v.txHash,
        ledger: v.ledger,
        ...(v.returnValue !== undefined ? { returnValue: v.returnValue } : {}),
        source: "rpc",
        resumable: false,
      };
    case "failed":
      return { state: "failed", txHash: v.txHash, ledger: v.ledger, source: "rpc", resumable: false };
    case "not_found":
    default: {
      const validUntil = options?.validUntil;
      if (
        validUntil !== undefined &&
        v.latestLedgerCloseTime !== undefined &&
        v.latestLedgerCloseTime > validUntil
      ) {
        return { state: "not_applied", reason: "tx_expired", txHash: v.txHash, resumable: false };
      }
      return {
        state: "pending",
        txHash: v.txHash,
        reason: "not_found",
        submissionAccepted: options?.submissionAccepted ?? false,
        resumable: true,
      };
    }
  }
}

/** `true` when the state is final according to the configured RPC (no further lookups needed). */
export function isTxLifecycleSettled(lifecycle: TxLifecycle): boolean {
  return (
    lifecycle.state === "confirmed" ||
    lifecycle.state === "failed" ||
    lifecycle.state === "not_applied"
  );
}
