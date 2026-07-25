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

// ─── Freighter detection ──────────────────────────────────────────────────────

/**
 * Returns true when the Freighter extension is present in the browser.
 * Works by checking for the injected global the extension registers.
 * Safe to call during SSR — returns false on the server.
 */
export function isFreighterInstalled(): boolean {
  if (typeof window === "undefined") return false;
  // Freighter injects `window.freighter` (extension v3+) or
  // exposes its API via the @stellar/freighter-api package which
  // wraps the injected global. A missing global means it isn't installed.
  return (
    typeof (window as Window & { freighter?: unknown }).freighter !== "undefined"
  );
}

// ─── Freighter helpers ────────────────────────────────────────────────────────

/**
 * Attempt to read the currently-connected public key from Freighter.
 * Returns null when:
 *  - Freighter is not installed
 *  - Freighter is installed but not connected to this origin
 *  - Any unexpected error occurs
 */
export async function getWalletAddress(): Promise<string | null> {
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
 * Prompt the user to grant this origin access to their Freighter wallet.
 *
 * Returns one of:
 *   { ok: true;  address: string }           – user approved
 *   { ok: false; reason: "not_installed" }   – extension absent
 *   { ok: false; reason: "rejected" }        – user dismissed the popup
 *   { ok: false; reason: "error"; message: string } – unexpected failure
 */
export type ConnectResult =
  | { ok: true; address: string }
  | { ok: false; reason: "not_installed" | "rejected" | "error"; message?: string };

export async function connectWallet(): Promise<ConnectResult> {
  if (!isFreighterInstalled()) {
    return { ok: false, reason: "not_installed" };
  }

  try {
    const pk = await requestAccess();
    if (!pk) {
      // requestAccess resolved but returned an empty string — treat as rejection
      return { ok: false, reason: "rejected" };
    }
    return { ok: true, address: pk };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Freighter surfaces user-cancelled presses as an error whose message
    // contains "User declined" or "rejected". Normalise these to `rejected`
    // so callers can show the right UI without string-matching.
    const isRejection = /declined|rejected|cancel/i.test(message);
    if (isRejection) {
      return { ok: false, reason: "rejected" };
    }

    return { ok: false, reason: "error", message };
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

// ─── Generic contract call (signed by Freighter) ─────────────────────────────

export async function invokeContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  walletAddress: string,
): Promise<{ txHash: string; success: boolean; error?: string }> {
  const rpc = getRpc();
  const account = await rpc.getAccount(walletAddress);
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
    return { txHash: "", success: false, error: simResult.error };
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();

  // signTransaction v2 returns the signed XDR string directly
  let signedXdr: string;
  try {
    signedXdr = await signTransaction(preparedTx.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isRejection = /declined|rejected|cancel/i.test(message);
    return {
      txHash: "",
      success: false,
      error: isRejection ? "Transaction cancelled by user." : message || "User rejected",
    };
  }

  if (!signedXdr) {
    return { txHash: "", success: false, error: "No signed XDR returned from Freighter." };
  }

  const sendResult = await rpc.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as Parameters<
      typeof rpc.sendTransaction
    >[0],
  );

  if (sendResult.status === "ERROR") {
    return {
      txHash: sendResult.hash,
      success: false,
      error: JSON.stringify(sendResult.errorResult),
    };
  }

  const hash = sendResult.hash;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await rpc.getTransaction(hash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return { txHash: hash, success: true };
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      return { txHash: hash, success: false, error: "Transaction failed on-chain." };
    }
  }
  return { txHash: hash, success: false, error: "Timed out waiting for transaction confirmation." };
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
