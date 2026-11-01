// --- sdk/src/simulationHelpers.ts -------------------------------------------
//
// Simulation error extraction, SimulationEstimate builder (summarizeSimulation),
// config-absent/circleNotActive normalisers, and typed TxResult builders.
// Extracted from circleUpClient.ts to reduce that file's LOC.
// Re-exported from circleUpClient.ts so existing imports are unchanged.

import { xdr, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { isValidContractAddress } from './types';
import type {
  TxResult, TxSuccess, TxFailure, TxErrorCode, TxMetadata,
  SimulationEstimate, SimulateResult, SubmissionDiagnostics, ContractErrorDiagnostic,
} from "./types";
import { sanitizeTxMetadata } from "./types";
// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Build a typed failure result. */
export function txFailure(
  txHash: string,
  errorMessage: string,
  errorCode: TxErrorCode = "unknown",
  diagnostics?: SubmissionDiagnostics,
  contractError?: ContractErrorDiagnostic,
): TxFailure {
  return {
    success: false,
    txHash,
    errorMessage,
    errorCode,
    ...(diagnostics ? { diagnostics } : {}),
    ...(contractError ? { contractError } : {}),
  };
}

export function contractErrorCategory(
  code: number,
  method: string,
  contract: ContractErrorDiagnostic["contract"],
): ContractErrorDiagnostic["category"] {
  if (contract === "circle") {
    if (method === "initialize") return code >= 1 && code <= 14 ? "initialization" : "unknown";
    if (method === "pause" || method === "resume") {
      return code === 1 || code === 4 ? "authorization" : code >= 2 && code <= 3 ? "state" : "unknown";
    }
    if (method === "close") {
      return code === 3 ? "authorization" : code >= 1 && code <= 4 ? "state" : "unknown";
    }
    if (["join", "cancel", "contribute", "payout", "mark_default", "settle_round"].includes(method)) {
      if (code === 4 || code === 12) return "authorization";
      if (code === 8 || code === 9) return "deadline";
      return code >= 5 && code <= 14 ? "state" : "unknown";
    }
    if (["get_config", "get_current_round", "get_pot_amount"].includes(method)) {
      return code >= 1 && code <= 3 ? "state" : "unknown";
    }
  }
  if (contract === "factory") {
    if (method === "initialize" && (code === 108 || code === 109)) return "initialization";
    if (method === "create_circle" && code >= 100 && code <= 107) return "validation";
  }
  if (contract === "reputation") {
    if (method === "initialize" && (code === 7 || code === 8)) return "initialization";
    if (["increment", "add_authorized_caller", "remove_authorized_caller"].includes(method)) {
      if (code === 1 || code === 2 || code === 5) return "authorization";
      if (code === 3) return "state";
      if (code === 4 || code === 7 || code === 8) return "initialization";
      if (code === 6) return "validation";
    }
  }
  return "unknown";
}

export function contractErrorFromSimulation(
  raw: string,
  method: string,
  contract: ContractErrorDiagnostic["contract"],
  message: string,
): ContractErrorDiagnostic | undefined {
  const match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (!match) return undefined;
  const code = Number(match[1]);
  return { contract, method, code, category: contractErrorCategory(code, method, contract), message };
}

/** Build a typed success result. */
export function txSuccess(
  txHash: string,
  ledger: number,
  returnValue?: unknown,
): TxSuccess {
  return { success: true, txHash, ledger, returnValue };
}

/**
 * Attach caller correlation metadata to a result without mutating it.
 *
 * `metadata` is expected to have already passed through
 * {@link sanitizeTxMetadata}; `undefined` leaves the result untouched so a
 * result is never widened with an empty `metadata` field.
 */
export function attachMetadata<T extends TxResult>(
  result: T,
  metadata: TxMetadata | undefined,
): T {
  return metadata ? { ...result, metadata } : result;
}

/**
 * Out-parameter through which {@link CircleUpClient.buildAndSendCore} hands
 * the simulation estimate back to its wrapper.  Exported only because it
 * appears in that protected signature; subclasses rarely need it.
 */
export interface SimulationDiagnostics {
  estimate?: SimulationEstimate;
}

/**
 * Attach a simulation estimate to a result without mutating it.  `undefined`
 * leaves the result untouched, mirroring {@link attachMetadata}.
 */
export function attachEstimate<T extends TxResult>(
  result: T,
  estimate: SimulationEstimate | undefined,
): T {
  return estimate ? { ...result, estimate } : result;
}

/** A non-negative integer amount, as the decimal string the RPC uses. */
export function readDecimalString(value: unknown): string | undefined {
  if (typeof value === "string") return /^\d+$/.test(value) ? value : undefined;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value === "bigint") return value >= 0n ? value.toString() : undefined;
  return undefined;
}

/** A non-negative safe integer, or `undefined`. */
export function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Call a zero-argument XDR accessor if it exists, swallowing decode errors. */
export function callAccessor(target: any, name: string): unknown {
  try {
    return typeof target?.[name] === "function" ? target[name]() : undefined;
  } catch {
    return undefined;
  }
}

/** Resource usage read from a simulation's `transactionData`. */
type ResourceEstimate = Pick<
  SimulationEstimate,
  "cpuInstructions" | "readBytes" | "writeBytes" | "readOnlyEntries" | "readWriteEntries"
>;

/**
 * Read the resource section of a `SorobanDataBuilder` (or an already-built
 * `SorobanTransactionData`).
 *
 * Returns `undefined` when the data is missing or is the all-zero placeholder
 * the Stellar SDK substitutes when the RPC omitted `transactionData` — every
 * real contract invocation touches at least one ledger entry, so an empty
 * footprint with zero usage means "not reported", not "free".
 */
function readResources(transactionData: unknown): ResourceEstimate | undefined {
  if (!transactionData || typeof transactionData !== "object") return undefined;
  const data = callAccessor(transactionData, "build") ?? transactionData;
  const resources = callAccessor(data, "resources");
  if (!resources) return undefined;

  const footprint = callAccessor(resources, "footprint");
  const readOnly = callAccessor(footprint, "readOnly");
  const readWrite = callAccessor(footprint, "readWrite");
  const instructions = callAccessor(resources, "instructions");

  const out: ResourceEstimate = {
    cpuInstructions: readDecimalString(instructions),
    // Protocol 23 renamed `readBytes` to `diskReadBytes`; accept either.
    readBytes: readCount(
      callAccessor(resources, "readBytes") ?? callAccessor(resources, "diskReadBytes"),
    ),
    writeBytes: readCount(callAccessor(resources, "writeBytes")),
    readOnlyEntries: Array.isArray(readOnly) ? readOnly.length : undefined,
    readWriteEntries: Array.isArray(readWrite) ? readWrite.length : undefined,
  };

  const isPlaceholder =
    out.cpuInstructions === "0" &&
    !out.readBytes &&
    !out.writeBytes &&
    !out.readOnlyEntries &&
    !out.readWriteEntries;
  return isPlaceholder ? undefined : out;
}

/**
 * Summarise a Soroban simulation response into a log-safe
 * {@link SimulationEstimate}.
 *
 * Accepts success, restore and error responses alike.  Only the documented
 * numeric fields are copied: the transaction envelope, auth entries, return
 * value, events and every other XDR blob are ignored, so the result can be
 * logged or shown to a user without exposing signed or signable material.
 * Fields the response does not carry (or carries malformed) are left
 * `undefined`; nothing is defaulted.
 *
 * @param simulation   The (parsed) `simulateTransaction` response.
 * @param inclusionFee The inclusion fee, in stroops, set on the simulated
 *                     transaction — echoed as `inclusionFee` when well-formed.
 * @returns The estimate, or `undefined` when no field could be read.
 */
export function summarizeSimulation(
  simulation: unknown,
  inclusionFee?: string | number,
): SimulationEstimate | undefined {
  if (!simulation || typeof simulation !== "object") return undefined;
  const sim = simulation as Record<string, any>;
  const isError = typeof sim.error === "string";

  const estimate: Record<string, unknown> = {
    inclusionFee: readDecimalString(inclusionFee),
    latestLedger: readCount(sim.latestLedger),
  };

  if (!isError) {
    estimate.minResourceFee = readDecimalString(sim.minResourceFee);
    Object.assign(estimate, readResources(sim.transactionData));

    const preamble = sim.restorePreamble;
    if (preamble && typeof preamble === "object") {
      estimate.restoreRequired = true;
      estimate.restoreMinResourceFee = readDecimalString(preamble.minResourceFee);
    }
  }

  // Drop absent fields so `"field" in estimate` means "the RPC reported it".
  for (const key of Object.keys(estimate)) {
    if (estimate[key] === undefined) delete estimate[key];
  }
  if (Object.keys(estimate).length === 0) return undefined;
  return Object.freeze(estimate) as SimulationEstimate;
}

/**
 * Source account used for read-only simulations.
 *
 * This is the strkey for the all-zero ed25519 public key. Simulations are
 * never signed or submitted, so the account only needs to be a well-formed
 * address; using a fixed one keeps reads free of the RPC round-trip that
 * looking up a throwaway account would cost.
 */
export const SIMULATION_SOURCE_ACCOUNT =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Read the `latestLedger` field an RPC attaches to its responses.
 *
 * Returns `undefined` when the field is absent or not a number, in which case
 * the caller cannot judge whether the endpoint is keeping up and must not
 * treat it as stale.
 */
export function readLatestLedger(response: unknown): number | undefined {
  const value = (response as { latestLedger?: unknown } | null)?.latestLedger;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Decode the contract return value carried by a successful `getTransaction`
 * response.
 *
 * A decode failure is deliberately swallowed: the transaction is already
 * confirmed on-chain, and turning a successful contribution or payout into a
 * reported failure because its return value could not be read would be worse
 * than handing back `undefined`. Callers that need the value narrow it with a
 * `decode*` helper and get a precise error there.
 */
export function decodeReturnValue(status: unknown): unknown {
  const retval = (status as { returnValue?: xdr.ScVal } | null)?.returnValue;
  if (!retval) return undefined;
  try {
    return scValToNative(retval);
  } catch {
    return undefined;
  }
}

/**
 * Soroban contract method names are `Symbol`s: up to 32 alphanumeric or
 * underscore characters.
 */
export const CONTRACT_METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/**
 * Validate the parts of a contract invocation that every code path shares —
 * the target address, the method name, and the encoded arguments.
 *
 * Both `buildAndSend` and `simulateAndRead` run this before any network I/O so
 * a malformed call is reported as a typed SDK error naming the offending
 * argument, rather than as an opaque `Contract` constructor throw or a host
 * error that only appears after a round-trip to the RPC.
 *
 * @returns `null` when the invocation is well-formed, otherwise a
 *   human-readable description of the first problem found.
 */
export function validateInvocation(
  contractId: unknown,
  method: unknown,
  args: unknown,
): string | null {
  if (typeof contractId !== "string" || !isValidContractAddress(contractId)) {
    return (
      `contract address ${JSON.stringify(contractId)} is not a Soroban contract address ` +
      `(expected a 56-character string starting with "C").`
    );
  }
  if (typeof method !== "string" || !CONTRACT_METHOD_RE.test(method)) {
    return (
      `method name ${JSON.stringify(method)} is not a valid Soroban symbol ` +
      `(1–32 letters, digits or underscores, not starting with a digit).`
    );
  }
  if (!Array.isArray(args)) {
    return `args must be an array of xdr.ScVal, got ${typeof args}.`;
  }
  const badIndex = args.findIndex((a) => !(a instanceof xdr.ScVal));
  if (badIndex !== -1) {
    return (
      `args[${badIndex}] is not an xdr.ScVal. ` +
      `Encode arguments with scAddress / scU32 / scI128 / scBool / scAddressVec first.`
    );
  }
  return null;
}

/**
 * Extract a human-readable error string from the Soroban simulation error.
 *
 * The raw `simResult.error` is an XDR-encoded diagnostic string that often
 * contains the contract panic message, e.g.:
 *   "HostError: Value(UnexpectedType)\n  ... contract backtrace ...\nError(Contract, #1)"
 *
 * We try to surface the most actionable part in priority order:
 * 1. Quoted contract debug log (most specific — the contract author's message)
 * 2. Panic message embedded in the host error
 * 3. The last `Error(...)` segment which encodes the contract error code
 * 4. Known host-error patterns translated to plain English
 * 5. Fall back to the full string trimmed to 300 chars
 */
export function extractSimulationError(
  raw: string,
  method?: string,
  contractKind: "circle" | "factory" | "reputation" = "circle",
): string {
  // Priority 1: Contract debug log — e.g. Event contract log (debug): "already joined"
  const logMatch = raw.match(/contract\s+log\s+\(debug\):\s+"([^"]+)"/i);
  if (logMatch) return logMatch[1];

  // Priority 2: Panic messages — e.g. panic called with: "message"
  const panicMatch = raw.match(/panic called with:\s+"([^"]+)"/i);
  if (panicMatch) return panicMatch[1];

  // Priority 3: ContractError enum variant — Error(Contract, #N)
  const errCodeMatch = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (errCodeMatch) {
    const errCode = Number(errCodeMatch[1]);
    if (method === "initialize" && contractKind === "circle") {
      const initDiagnostics: Record<number, string> = {
        1: "already initialized",
        2: "at least two members are required",
        3: "the member limit was exceeded",
        4: "member addresses must be unique",
        5: "round amount must be positive",
        6: "round amount overflows the payout pot",
        7: "round amount overflows the penalty calculation",
        8: "round deadline is below the minimum",
        9: "round deadline is above the maximum",
        10: "the token address is invalid",
        11: "the reputation contract address is invalid",
        12: "the member rotation is inconsistent",
        13: "the token contract does not implement the required interface",
        14: "initialization is already in progress",
      };
      const diagnostic = initDiagnostics[errCode];
      if (diagnostic) return `Circle initialization failed: ${diagnostic}.`;
    }
    if (contractKind === "circle" && (method === "pause" || method === "resume")) {
      const pauseDiagnostics: Record<number, string> = {
        1: "only the circle admin may pause or resume",
        2: "the circle is already paused",
        3: "the circle is not paused",
        4: "the circle is not initialized",
      };
      const diagnostic = pauseDiagnostics[errCode];
      if (diagnostic) return `Circle ${method} failed: ${diagnostic}.`;
    }
    if (contractKind === "circle" && method === "close") {
      const closeDiagnostics: Record<number, string> = {
        1: "the circle has already been closed",
        2: "the circle is not in a terminal state",
        3: "the caller is not authorized to close this circle",
        4: "not all rounds have completed",
      };
      const diagnostic = closeDiagnostics[errCode];
      if (diagnostic) return `Circle close failed: ${diagnostic}.`;
    }
    if (
      contractKind === "circle" &&
      ["get_config", "get_current_round", "get_pot_amount"].includes(method ?? "")
    ) {
      const viewDiagnostics: Record<number, string> = {
        1: "the circle has not been initialized",
        2: "the circle is not active",
        3: "the payout pot overflows the supported amount",
      };
      const diagnostic = viewDiagnostics[errCode];
      if (diagnostic) return `Circle read failed: ${diagnostic}.`;
    }
    if (method === "create_circle" || (method === "initialize" && contractKind === "factory")) {
      const factoryDiagnostics: Record<number, string> = {
        100: "at least two members are required",
        101: "the member limit was exceeded",
        102: "member addresses must be unique",
        103: "round amount must be positive",
        104: "round amount overflows the payout pot",
        105: "round amount overflows the penalty calculation",
        106: "round deadline is below the minimum",
        107: "round deadline is above the maximum",
        108: "the factory has already been initialized",
        109: "factory initialization is already in progress",
      };
      const diagnostic = factoryDiagnostics[errCode];
      if (diagnostic) {
        return method === "initialize"
          ? `Factory initialization failed: ${diagnostic}.`
          : `Circle creation failed: ${diagnostic}.`;
      }
    }
    if (
      ["increment", "add_authorized_caller", "remove_authorized_caller"].includes(method ?? "") ||
      (method === "initialize" && contractKind === "reputation")
    ) {
      const reputationDiagnostics: Record<number, string> = {
        1: "the calling circle is not authorized",
        2: "only the reputation admin can change authorized callers",
        3: "the circle is not currently authorized",
        4: "the reputation contract is not initialized",
        5: "the circle was permanently revoked",
        6: "the member score reached its maximum value",
        7: "the reputation contract has already been initialized",
        8: "reputation initialization is already in progress",
      };
      const diagnostic = reputationDiagnostics[errCode];
      if (diagnostic) {
        return method === "initialize"
          ? `Reputation initialization failed: ${diagnostic}.`
          : `Reputation operation failed: ${diagnostic}.`;
      }
    }
    if (["join", "cancel", "contribute", "payout", "mark_default", "settle_round", "close"].includes(method ?? "")) {
      const mutationDiagnostics: Record<number, string> = {
        4: "the caller is not a circle member",
        5: "this action has already been completed",
        6: "the circle is not in the required state",
        7: "the circle is paused",
        8: "the contribution deadline has passed",
        9: "the contribution deadline has not passed yet",
        10: "the round has already been paid out",
        11: "the round is not eligible for this settlement action",
        12: "the member has not joined",
        13: "the member was already marked in default for this round",
        14: "the member contributed and cannot be marked in default",
      };
      const diagnostic = mutationDiagnostics[errCode];
      if (diagnostic) return `Circle operation failed: ${diagnostic}.`;
    }
    return `Contract error code ${errCodeMatch[1]}. Check that the operation is valid for the current circle state.`;
  }

  // Priority 4: Known Soroban host errors translated to plain English
  if (raw.includes("Value(UnexpectedType)")) {
    return (
      "The contract received an argument of the wrong type. " +
      "Check that all arguments are encoded with the correct scAddress/scU32/scI128 helper."
    );
  }
  if (raw.includes("Value(MissingValue)")) {
    return (
      "The contract tried to read a value that does not exist. " +
      "The circle may not be initialised, or you may be targeting the wrong contract address."
    );
  }
  if (raw.includes("Value(ExistingValue)")) {
    return "The contract tried to create a value that already exists (possible duplicate operation).";
  }
  if (raw.includes("Auth(NotAuthorized)") || raw.includes("Auth(InvalidAction)")) {
    return (
      "The transaction was not authorised. " +
      "Ensure the signing keypair matches the account that should perform this action."
    );
  }
  if (raw.includes("Budget(CpuLimitExceeded)") || raw.includes("Budget(MemLimitExceeded)")) {
    return (
      "The contract ran out of CPU or memory resources during simulation. " +
      "The operation may be too complex or the circle may have too many members."
    );
  }
  if (raw.includes("Storage(MissingValue)")) {
    return (
      "A required storage entry was not found. " +
      "The circle contract may not be deployed at this address, or the state has not been initialised."
    );
  }

  // Priority 5: Short enough to show as-is; otherwise truncate
  return raw.length <= 300 ? raw : raw.slice(0, 297) + "...";
}

/**
 * Normalise a raw RPC or network error into a short, actionable string.
 *
 * Node's `fetch` and the Stellar SDK surface many different error shapes —
 * `ECONNREFUSED`, `ENOTFOUND`, `FetchError`, HTTP timeouts, etc.  This helper
 * maps the most common ones to sentences that tell the developer what to try
 * next, while keeping the raw message for anything unusual so it is not lost.
 */
export function formatRpcError(raw: string, rpcUrl: string): string {
  const lower = raw.toLowerCase();

  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused")
  ) {
    return (
      `Could not connect to the RPC at ${rpcUrl} (connection refused). ` +
      `Check that the endpoint is running and that config.rpcUrl is correct.`
    );
  }
  if (lower.includes("enotfound") || lower.includes("name or service not known")) {
    return (
      `DNS resolution failed for the RPC at ${rpcUrl}. ` +
      `Check the hostname in config.rpcUrl.`
    );
  }
  if (
    lower.includes("etimedout") ||
    lower.includes("network timeout") ||
    lower.includes("socket hang up")
  ) {
    return (
      `The RPC at ${rpcUrl} did not respond in time (${raw}). ` +
      `The node may be overloaded — wait a moment and retry.`
    );
  }
  if (lower.includes("fetch failed") || lower.includes("failed to fetch")) {
    return (
      `Network fetch to ${rpcUrl} failed. ` +
      `Check your internet connection and that config.rpcUrl is reachable.`
    );
  }
  if (lower.includes("ssl") || lower.includes("certificate")) {
    return (
      `TLS/SSL error connecting to ${rpcUrl}. ` +
      `Check the certificate or use an HTTP URL for local development.`
    );
  }

  // For short messages pass them through; otherwise trim to avoid log spam
  return raw.length <= 200 ? raw : raw.slice(0, 197) + "...";
}

// ─── Config-absent normalisation ─────────────────────────────────────────────
//
// The contract's `get_config` view returns `ContractError::NotInitialized` (code 1)
// when the `Config` storage key is absent — i.e. the circle contract has been
// deployed but `initialize` has not been called yet (or failed midway).
//
// The raw simulation error string contains one of:
//   "Contract error code 1"               (from extractSimulationError priority 3)
//   "NotInitialized"                       (from the contract's debug log)
//   "Value(MissingValue)"                  (underlying Soroban host error)
//   "already initialized" is the *opposite* case (Config key IS present)
//
// `normalizeNotInitializedError` maps any of these forms to a single canonical
// message so `getConfigResult` callers need only check for one substring.

/**
 * Returns `true` when a `ReadResult.error` string indicates the circle has not
 * been initialized yet (the `Config` storage key is absent).
 *
 * Use this after `getConfigResult` to branch on the not-initialized case
 * without parsing arbitrary error strings:
 *
 * ```ts
 * const r = await client.getConfigResult();
 * if (!r.ok && isConfigAbsent(r.error)) {
 *   showBanner("Circle not initialized");
 * }
 * ```
 */
export function isConfigAbsent(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("not initialized") ||
    lower.includes("notinitialized") ||
    lower.includes("contract error code 1") ||
    // Soroban host error for a missing storage entry on a read-only view
    lower.includes("storage(missingvalue)")
  );
}

/**
 * Normalise a raw simulation error string into a clear, consistent message
 * when it indicates the circle's `Config` storage key is absent.
 *
 * If the string does not match the not-initialized pattern it is returned
 * unchanged, preserving the original message for other error kinds.
 */
export function normalizeNotInitializedError(raw: string): string {
  if (isConfigAbsent(raw)) {
    return (
      "Circle contract is not initialized: the Config storage key is absent. " +
      "The circle may have been deployed but `initialize` has not been called yet, " +
      "or initialization failed. Call `initialize` before reading config."
    );
  }
  return raw;
}

// ─── CircleNotActive normalisation ───────────────────────────────────────────
//
// The contract's `get_current_round` view returns `ContractError::CircleNotActive`
// (code 2) when the circle is in a terminal state (Completed or Cancelled) —
// i.e. there is no in-progress round to return.
//
// The raw simulation error string contains one of:
//   "Contract error code 2"               (from extractSimulationError priority 3)
//   "CircleNotActive"                      (from the contract's debug log)
//   "circle is not active"                 (contract panic message in older builds)
//
// `normalizeCircleNotActiveError` maps any of these forms to a single canonical
// message so `getCurrentRoundResult` callers need only check for one substring.

/**
 * Returns `true` when a `ReadResult.error` string from `getCurrentRoundResult`
 * indicates the circle is not in an active state (Completed or Cancelled) —
 * meaning there is no current round to read, not that a network error occurred.
 *
 * Use this to branch on the "no active round" case without comparing the full
 * error message string:
 *
 * ```ts
 * const r = await client.getCurrentRoundResult();
 * if (!r.ok && isCircleNotActive(r.error)) {
 *   showCompletedCircleSummary();   // expected — no round in progress
 * } else if (!r.ok) {
 *   showNetworkError(r.error);      // unexpected — transient failure
 * }
 * ```
 *
 * This correctly handles all error message forms produced by different
 * versions of the Soroban RPC and the contract's debug log.
 */
export function isCircleNotActive(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("circle not active") ||
    lower.includes("circlenotactive") ||
    lower.includes("contract error code 2") ||
    // Contract panic message in older builds / test environments
    lower.includes("circle is not active") ||
    // The canonical normalised message written by normalizeCircleNotActiveError
    lower.includes("no active round")
  );
}

/**
 * Normalise a raw simulation error string into a clear, consistent message
 * when it indicates `ContractError::CircleNotActive` (code 2).
 *
 * If the string does not match the not-active pattern it is returned unchanged,
 * preserving the original message for other error kinds.
 */
export function normalizeCircleNotActiveError(raw: string): string {
  if (isCircleNotActive(raw)) {
    return (
      "No active round: the circle is not in an Active or Pending state. " +
      "The circle may be Completed or Cancelled — inspect get_status and " +
      "use the indexer's round history instead of get_current_round."
    );
  }
  return raw;
}