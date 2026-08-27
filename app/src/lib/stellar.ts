"use client";
/**
 * Thin browser-side Stellar / Soroban helpers.
 * Uses @stellar/freighter-api v2 (isConnected → boolean, getPublicKey → string,
 * signTransaction → string XDR, requestAccess → string).
 */
import {
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Contract,
  Address,
  scValToNative,
  xdr,
  type Account,
} from "@stellar/stellar-sdk";
import {
  isConnected,
  getPublicKey,
  signTransaction,
  requestAccess,
} from "@stellar/freighter-api";
import { STELLAR_RPC_URL, NETWORK_PASSPHRASE, REPUTATION_ADDRESS } from "./config";
import { startTx, emit, categorizeError } from "./telemetry";
import {
  parseContractError,
  userMessageForError,
  type ContractAppError,
} from "./contractErrors";

// ─── Freighter detection & error types ───────────────────────────────────────

/** Typed reasons a wallet connection can fail. */
export type WalletErrorReason =
  | "not_installed"
  | "permission_denied"
  | "unknown";

export class WalletError extends Error {
  constructor(
    public readonly reason: WalletErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/**
 * Returns true when the Freighter extension is present in the browser.
 * Works by inspecting the injected global that Freighter sets; falls back to
 * a best-effort isConnected() call so it works in all Freighter v2 builds.
 */
export function isFreighterInstalled(): boolean {
  if (typeof window === "undefined") return false;
  // Freighter v2 injects window.freighter; earlier builds inject window.freighterApi
  return (
    typeof (window as any).freighter !== "undefined" ||
    typeof (window as any).freighterApi !== "undefined"
  );
}

/**
 * Returns the connected wallet public key, or null if not connected.
 *
 * Throws a {@link WalletError} with an appropriate reason so callers can show
 * actionable messages rather than silently failing:
 *  - `not_installed`  → extension is not present
 *  - `permission_denied` → user dismissed the access prompt
 */
export async function getWalletAddress(): Promise<string | null> {
  if (!isFreighterInstalled()) {
    throw new WalletError(
      "not_installed",
      "Freighter wallet extension is not installed. Visit https://freighter.app to install it.",
    );
  }
  try {
    const connected = await isConnected();
    if (!connected) return null;
    const pk = await getPublicKey();
    return pk || null;
  } catch {
    return null;
  }
}

/**
 * Prompts the user to connect their Freighter wallet.
 *
 * Throws a {@link WalletError} so callers receive a typed, user-friendly reason
 * instead of a raw exception or a silent null.
 */
export async function connectWallet(): Promise<string> {
  if (!isFreighterInstalled()) {
    throw new WalletError(
      "not_installed",
      "Freighter wallet extension is not installed. Visit https://freighter.app to install it.",
    );
  }

  try {
    // requestAccess returns the public key string directly in v2
    const pk = await requestAccess();
    if (!pk) {
      throw new WalletError(
        "permission_denied",
        "Wallet access was denied. Please approve the connection in Freighter and try again.",
      );
    }
    return pk;
  } catch (err: any) {
    // Re-throw our own errors as-is
    if (err instanceof WalletError) throw err;

    // Freighter surfaces user rejection as a message containing "denied" or similar
    const msg: string = err?.message?.toLowerCase() ?? "";
    if (
      msg.includes("denied") ||
      msg.includes("rejected") ||
      msg.includes("cancelled") ||
      msg.includes("canceled")
    ) {
      throw new WalletError(
        "permission_denied",
        "Wallet access was denied. Please approve the connection in Freighter and try again.",
      );
    }

    throw new WalletError("unknown", err?.message || "Failed to connect wallet.");
  }
}

// ─── RPC client ───────────────────────────────────────────────────────────────

let _rpc: SorobanRpc.Server | null = null;
function getRpc() {
  if (!_rpc) {
    _rpc = new SorobanRpc.Server(STELLAR_RPC_URL, { allowHttp: true });
  }
  return _rpc;
}

// ─── Contract error helpers ───────────────────────────────────────────────────

/** How many polling iterations to allow before giving up. */
const TX_POLL_ATTEMPTS = 30;
/** Delay between polling attempts in ms. */
const TX_POLL_INTERVAL_MS = 2000;
/** Total wait budget shown to users: attempts × interval. */
const TX_TIMEOUT_SECONDS = Math.round(
  (TX_POLL_ATTEMPTS * TX_POLL_INTERVAL_MS) / 1000,
);

/**
 * Converts a raw Soroban/network error into a human-readable message that
 * includes retry guidance when appropriate.
 */
export function formatContractError(raw: string | undefined): string {
  if (!raw) return "Transaction failed for an unknown reason.";

  const lower = raw.toLowerCase();

  if (lower === "transaction failed") {
    return (
      "The transaction was rejected on-chain. This may be due to a contract rule violation, " +
      "insufficient balance, or an expired transaction. " +
      "Check Stellar Expert for the full error detail."
    );
  }

  if (lower === "timeout") {
    return (
      `The transaction was submitted but confirmation timed out after ${TX_TIMEOUT_SECONDS}s. ` +
      "The network may be congested. Please check Stellar Expert for your transaction status " +
      "before retrying to avoid duplicate submissions."
    );
  }

  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("failed to fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound")
  ) {
    return (
      "A network error occurred while communicating with the Stellar RPC. " +
      "Check your internet connection and try again. " +
      "If the problem persists, the RPC endpoint may be temporarily unavailable."
    );
  }

  if (lower.includes("insufficient") && lower.includes("fee")) {
    return "The transaction fee was too low. Please try again — the fee will be recalculated automatically.";
  }

  if (lower.includes("user rejected") || lower.includes("denied")) {
    return "You cancelled the transaction in Freighter. No funds were moved.";
  }

  // Return the raw error, capitalised, for developer visibility
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ─── Generic contract call (signed by Freighter) ─────────────────────────────

/**
 * Result of a contract invocation.  The `typedError` field carries a
 * {@link ContractAppError} on every failure path so callers can branch on
 * stable codes rather than message strings.
 */
export interface InvokeResult {
  txHash: string;
  success: boolean;
  /** User-facing formatted message (legacy — prefer `typedError.message`). */
  error?: string;
  /** Typed, categorised error for deterministic branching. Only set on failure. */
  typedError?: ContractAppError;
}

export async function invokeContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  walletAddress: string,
): Promise<InvokeResult> {
  const rpc = getRpc();

  // ── Telemetry: started ───────────────────────────────────────────────────
  // startTx emits the "started" stage and returns a context handle that
  // tracks the per-invocation start time.  Only the method name is recorded —
  // contractId, walletAddress, and args are never passed to telemetry.
  const txCtx = startTx(method);

  // ── Account fetch ────────────────────────────────────────────────────────
  let account: Awaited<ReturnType<typeof rpc.getAccount>>;
  try {
    account = await rpc.getAccount(walletAddress);
  } catch (err: any) {
    const msg: string = err?.message ?? "";
    const isNetwork =
      msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch");
    emit(txCtx, "failed", categorizeError(isNetwork ? "network" : msg));
    const typedError = parseContractError(isNetwork ? "network error" : msg);
    return {
      txHash: "",
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  const contract = new Contract(contractId);

  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30);

  const tx = txBuilder.build();

  // ── Simulation ───────────────────────────────────────────────────────────
  const simResult = await rpc.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    emit(txCtx, "simulate_failed", categorizeError(simResult.error));
    const typedError = parseContractError(simResult.error);
    return {
      txHash: "",
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  // ── Telemetry: simulated ─────────────────────────────────────────────────
  emit(txCtx, "simulated");

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();

  // ── Wallet signing ───────────────────────────────────────────────────────
  // signTransaction v2 returns the signed XDR string directly.
  // The XDR is never forwarded to telemetry.
  let signedXdr: string;
  try {
    signedXdr = await signTransaction(preparedTx.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
  } catch (err: any) {
    const msg: string = err?.message ?? "";
    const lower = msg.toLowerCase();
    if (
      lower.includes("denied") ||
      lower.includes("rejected") ||
      lower.includes("cancelled") ||
      lower.includes("canceled")
    ) {
      emit(txCtx, "wallet_rejected", "wallet_denied");
      const typedError = parseContractError(msg || "User rejected");
      return {
        txHash: "",
        success: false,
        error: userMessageForError(typedError),
        typedError,
      };
    }
    const typedError = parseContractError(msg || "User rejected");
    emit(txCtx, "failed", categorizeError(msg || "User rejected"));
    return {
      txHash: "",
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  if (!signedXdr) {
    const typedError = parseContractError("Freighter did not return a signed transaction.");
    emit(txCtx, "failed", "unknown");
    return {
      txHash: "",
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  // ── Submission ───────────────────────────────────────────────────────────
  let sendResult: Awaited<ReturnType<typeof rpc.sendTransaction>>;
  try {
    sendResult = await rpc.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as any,
    );
  } catch (err: any) {
    const typedError = parseContractError(err?.message ?? "network error");
    emit(txCtx, "failed", categorizeError(err?.message ?? "network error"));
    return {
      txHash: "",
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  if (sendResult.status === "ERROR") {
    const rawErr = JSON.stringify(sendResult.errorResult);
    const typedError = parseContractError(rawErr);
    emit(txCtx, "submission_failed", "on_chain_failed");
    return {
      txHash: sendResult.hash,
      success: false,
      error: userMessageForError(typedError),
      typedError,
    };
  }

  // ── Telemetry: submitted ─────────────────────────────────────────────────
  // Hash is now known.  It is returned to the caller and visible in the
  // browser UI, but is not included in the telemetry event.
  emit(txCtx, "submitted");

  const hash = sendResult.hash;

  // ── Polling loop ─────────────────────────────────────────────────────────
  let attempts = TX_POLL_ATTEMPTS;
  while (attempts-- > 0) {
    await new Promise((r) => setTimeout(r, TX_POLL_INTERVAL_MS));
    let status: Awaited<ReturnType<typeof rpc.getTransaction>>;
    try {
      status = await rpc.getTransaction(hash);
    } catch {
      // Transient polling error — keep trying; no telemetry for transient errors
      continue;
    }

    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      // ── Telemetry: confirmed ───────────────────────────────────────────
      emit(txCtx, "confirmed");
      return { txHash: hash, success: true };
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      const typedError = parseContractError("transaction failed");
      emit(txCtx, "failed", "on_chain_failed");
      return {
        txHash: hash,
        success: false,
        error: userMessageForError(typedError),
        typedError,
      };
    }
  }

  const timedOutError = parseContractError("timeout");
  emit(txCtx, "timed_out", "timeout");
  return {
    txHash: hash,
    success: false,
    error: userMessageForError(timedOutError),
    typedError: timedOutError,
  };
}

// ─── Read-only simulation ─────────────────────────────────────────────────────

export async function readContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<T> {
  const rpc = getRpc();
  const contract = new Contract(contractId);
  // A minimal stub that satisfies the TransactionBuilder's Account interface.
  // We only need a static sequence for read-only simulation — it is never submitted.
  const fakeAccount = {
    id: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    sequence: "0",
    incrementSequenceNumber() {},
  } as unknown as Account;

  const tx = new TransactionBuilder(fakeAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(simResult.error);
  }
  if (!("result" in simResult) || !simResult.result) {
    throw new Error("No result from simulation");
  }
  return scValToNative(simResult.result.retval) as T;
}

// ─── Contract-specific helpers ────────────────────────────────────────────────

export async function getReputationScore(member: string): Promise<number> {
  return readContract<number>(REPUTATION_ADDRESS, "score", [
    new Address(member).toScVal(),
  ]);
}

export async function getCircleStatus(circleAddress: string): Promise<string> {
  return readContract<string>(circleAddress, "get_status", []);
}

export async function getCurrentRound(circleAddress: string): Promise<unknown> {
  return readContract<unknown>(circleAddress, "get_current_round", []);
}

export async function getCircleConfig(circleAddress: string): Promise<unknown> {
  return readContract<unknown>(circleAddress, "get_config", []);
}
