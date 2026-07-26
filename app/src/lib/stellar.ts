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

export async function invokeContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  walletAddress: string,
): Promise<{ txHash: string; success: boolean; error?: string }> {
  const rpc = getRpc();

  let account: Awaited<ReturnType<typeof rpc.getAccount>>;
  try {
    account = await rpc.getAccount(walletAddress);
  } catch (err: any) {
    const msg: string = err?.message ?? "";
    if (msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch")) {
      return {
        txHash: "",
        success: false,
        error: formatContractError("network error"),
      };
    }
    return { txHash: "", success: false, error: formatContractError(msg) };
  }

  const contract = new Contract(contractId);

  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30);

  const tx = txBuilder.build();
  const simResult = await rpc.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    return { txHash: "", success: false, error: formatContractError(simResult.error) };
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();

  // signTransaction v2 returns the signed XDR string directly
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
      return {
        txHash: "",
        success: false,
        error: "You cancelled the transaction in Freighter. No funds were moved.",
      };
    }
    return { txHash: "", success: false, error: formatContractError(msg || "User rejected") };
  }

  if (!signedXdr) {
    return { txHash: "", success: false, error: "Freighter did not return a signed transaction." };
  }

  let sendResult: Awaited<ReturnType<typeof rpc.sendTransaction>>;
  try {
    sendResult = await rpc.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as any,
    );
  } catch (err: any) {
    return {
      txHash: "",
      success: false,
      error: formatContractError(err?.message ?? "network error"),
    };
  }

  if (sendResult.status === "ERROR") {
    return {
      txHash: sendResult.hash,
      success: false,
      error: formatContractError(JSON.stringify(sendResult.errorResult)),
    };
  }

  const hash = sendResult.hash;

  let attempts = TX_POLL_ATTEMPTS;
  while (attempts-- > 0) {
    await new Promise((r) => setTimeout(r, TX_POLL_INTERVAL_MS));
    let status: Awaited<ReturnType<typeof rpc.getTransaction>>;
    try {
      status = await rpc.getTransaction(hash);
    } catch {
      // Transient polling error — keep trying
      continue;
    }

    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return { txHash: hash, success: true };
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      return {
        txHash: hash,
        success: false,
        error: formatContractError("transaction failed"),
      };
    }
  }

  return { txHash: hash, success: false, error: formatContractError("timeout") };
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
