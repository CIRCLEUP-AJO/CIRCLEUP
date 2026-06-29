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
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  isConnected,
  getPublicKey,
  signTransaction,
} from "@stellar/freighter-api";
import { STELLAR_RPC_URL, NETWORK_PASSPHRASE, REPUTATION_ADDRESS } from "./config";

// ─── Freighter helpers ────────────────────────────────────────────────────────

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
  } catch (err: any) {
    return { txHash: "", success: false, error: err?.message || "User rejected" };
  }

  if (!signedXdr) {
    return { txHash: "", success: false, error: "No signed XDR returned" };
  }

  const sendResult = await rpc.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as any,
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
      return { txHash: hash, success: false, error: "transaction failed" };
    }
  }
  return { txHash: hash, success: false, error: "timeout" };
}

// ─── Read-only simulation ─────────────────────────────────────────────────────

export async function readContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<T> {
  const rpc = getRpc();
  const contract = new Contract(contractId);
  const fakeAccount = {
    id: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    sequence: "0",
    incrementSequenceNumber() {},
  } as any;

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

export async function getCurrentRound(circleAddress: string) {
  return readContract<any>(circleAddress, "get_current_round", []);
}

export async function getCircleConfig(circleAddress: string) {
  return readContract<any>(circleAddress, "get_config", []);
}
