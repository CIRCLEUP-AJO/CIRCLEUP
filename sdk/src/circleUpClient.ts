import {
  Account,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
  Contract,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";
import type {
  CircleUpConfig,
  CircleConfig,
  RoundState,
  CircleStatus,
  TxResult,
  TxSuccess,
  TxFailure,
  TxErrorCode,
  TxMetadata,
  SimulationEstimate,
  SimulateResult,
  ReadResult,
  ApiCirclesListResponse,
  ApiCircleDetailResponse,
  ApiMembersResponse,
  ApiRoundsResponse,
  ApiReputationResponse,
  ApiMemberContributionsResponse,
  ApiHealthResponse,
  ApiAuditEventsResponse,
  GetCirclesParams,
  ApiCircleStatus,
  CircleSortField,
  StateMismatch,
  SubmissionDiagnostics,
  TxLookup,
  ContractErrorDiagnostic,
  IndexerPagination,
  GetMemberContributionsParams,
  PaginateOptions,
} from "./types";
import { INDEXER_MAX_PAGE_SIZE } from "./constants";
import {
  validateCircleUpConfig,
  isValidContractAddress,
  isValidStellarAddress,
  mapRawConfig,
  mapRawRoundState,
  assertValidCircleStatus,
  decodeU32,
  decodeI128,
  decodeBoolean,
  decodeAddress,
  decodeAddressList,
  validateContractArgs,
  sanitizeTxMetadata,
} from "./types";
import {
  buildSnapshot,
  computeActionEligibility,
  detectStateMismatches,
  isGateBlocked,
  isSnapshotFresh,
} from "./gating";
import { USDC_DECIMALS } from "./constants";
import type {
  ActualState,
  CircleAction,
  ExpectedState,
  GateBlockReason,
  GateOptions,
  GateResult,
  StateSnapshot,
} from "./gating";

// ─── Stale-state mismatch message formatter ───────────────────────────────────

/**
 * Build a human-readable summary of which on-chain fields diverged during a
 * stale-write preflight check.
 *
 * Used by {@link CircleClient.preflight} to populate {@link PreflightStale.message}.
 */
export function formatMismatchMessage(mismatches: readonly StateMismatch[]): string {
  if (mismatches.length === 0) return "State is fresh.";
  const parts = mismatches.map(
    (m) => `${m.field} changed from ${JSON.stringify(m.expected)} to ${JSON.stringify(m.actual)}`,
  );
  return `On-chain state has changed since you last loaded this page: ${parts.join("; ")}. Refresh and try again.`;
}

// ─── Polling configuration ────────────────────────────────────────────────────

/**
 * Controls how `buildAndSend` polls for transaction confirmation after
 * submission.
 *
 * All timing values are in milliseconds.  The polling loop uses exponential
 * backoff with full jitter to avoid thundering-herd behaviour when many
 * clients poll simultaneously after a network hiccup.
 *
 * Effective wait before attempt N (0-indexed):
 *   min(maxIntervalMs, initialIntervalMs * backoffFactor^N) ± jitter
 *
 * @example
 * // Aggressive polling for tests (fast, low noise)
 * const cfg: PollConfig = { initialIntervalMs: 500, timeoutMs: 10_000 };
 *
 * // Conservative polling for mainnet (reduces RPC pressure)
 * const cfg: PollConfig = {
 *   initialIntervalMs: 3_000,
 *   maxIntervalMs: 30_000,
 *   backoffFactor: 1.5,
 *   timeoutMs: 120_000,
 * };
 */
export interface PollConfig {
  /**
   * Milliseconds to wait before the first poll attempt.
   * @default 2000
   */
  initialIntervalMs?: number;

  /**
   * Maximum milliseconds between any two poll attempts regardless of backoff.
   * @default 10_000
   */
  maxIntervalMs?: number;

  /**
   * Multiplier applied to the current interval after each attempt.
   * Must be >= 1.  Set to 1 for a flat (non-backoff) retry schedule.
   * @default 1.5
   */
  backoffFactor?: number;

  /**
   * Total time budget for confirmation polling.  If the transaction has not
   * been confirmed (SUCCESS or FAILED) within this window the method returns
   * a `TxFailure` with `errorCode: "timeout"`.
   * @default 60_000
   */
  timeoutMs?: number;

  /**
   * How many consecutive `getTransaction` network errors are tolerated before
   * giving up and returning a `TxFailure` with `errorCode: "network_error"`.
   * Transient errors within this budget are retried silently.
   * @default 5
   */
  maxConsecutiveErrors?: number;
}

/** Resolved defaults used when the caller omits individual fields. */
export const DEFAULT_POLL_CONFIG = {
  initialIntervalMs: 2_000,
  maxIntervalMs: 10_000,
  backoffFactor: 1.5,
  timeoutMs: 60_000,
  maxConsecutiveErrors: 5,
} as const satisfies Required<PollConfig>;

/**
 * How many consecutive polls may observe the same RPC ledger before the
 * confirmation loop declares the endpoint stale.
 *
 * A healthy Stellar RPC advances its `latestLedger` roughly every 5 seconds.
 * The polling interval starts at 2 s and backs off, so three consecutive
 * responses reporting an unchanged ledger means the endpoint has stopped
 * ingesting — the transaction will never be observed here no matter how long
 * we wait, and continuing to poll would burn the caller's whole timeout budget
 * on an endpoint that cannot answer.
 */
const STALE_LEDGER_POLLS = 3;

/**
 * Validate a caller-supplied {@link PollConfig}, reporting every problem at
 * once rather than failing on the first one.
 *
 * Called from the `CircleUpClient` constructor so a bad schedule surfaces at
 * setup time instead of producing a loop that spins hot, never retries, or
 * gives up before the network could plausibly have confirmed anything.
 *
 * @throws `RangeError` listing every invalid field.
 */
function validatePollConfig(cfg: Required<PollConfig>): void {
  const errors: string[] = [];

  const positive = (
    key: keyof PollConfig,
    value: number,
  ): void => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      errors.push(
        `PollConfig.${key} must be a finite number greater than 0, got ${JSON.stringify(value)}.`,
      );
    }
  };

  positive("initialIntervalMs", cfg.initialIntervalMs);
  positive("maxIntervalMs", cfg.maxIntervalMs);
  positive("timeoutMs", cfg.timeoutMs);
  positive("maxConsecutiveErrors", cfg.maxConsecutiveErrors);

  if (
    typeof cfg.maxConsecutiveErrors === "number" &&
    Number.isFinite(cfg.maxConsecutiveErrors) &&
    !Number.isInteger(cfg.maxConsecutiveErrors)
  ) {
    errors.push(
      `PollConfig.maxConsecutiveErrors must be a whole number, got ${cfg.maxConsecutiveErrors}.`,
    );
  }

  if (
    typeof cfg.backoffFactor !== "number" ||
    !Number.isFinite(cfg.backoffFactor) ||
    cfg.backoffFactor < 1
  ) {
    errors.push(
      `PollConfig.backoffFactor must be >= 1, got ${JSON.stringify(cfg.backoffFactor)}.`,
    );
  }

  if (
    Number.isFinite(cfg.initialIntervalMs) &&
    Number.isFinite(cfg.maxIntervalMs) &&
    cfg.maxIntervalMs < cfg.initialIntervalMs
  ) {
    errors.push(
      `PollConfig.maxIntervalMs (${cfg.maxIntervalMs}) must be >= initialIntervalMs ` +
        `(${cfg.initialIntervalMs}), otherwise the first wait already exceeds the cap.`,
    );
  }

  if (
    Number.isFinite(cfg.timeoutMs) &&
    Number.isFinite(cfg.initialIntervalMs) &&
    cfg.timeoutMs < cfg.initialIntervalMs
  ) {
    errors.push(
      `PollConfig.timeoutMs (${cfg.timeoutMs}) must be >= initialIntervalMs ` +
        `(${cfg.initialIntervalMs}), otherwise the loop times out before its first poll.`,
    );
  }

  if (errors.length > 0) {
    throw new RangeError(
      `Invalid PollConfig:\n${errors.map((e) => `  • ${e}`).join("\n")}`,
    );
  }
}


// ─── Transient RPC retry ──────────────────────────────────────────────────────

/**
 * Return true when `err` is a transient network or rate-limit condition that
 * is safe to retry.  Non-transient errors (auth, bad request, simulation
 * errors) propagate immediately so the caller gets feedback right away.
 *
 * Exported for unit testing.
 */
export function isTransientRpcError(err: unknown): boolean {
  if (err == null) return false;

  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }

  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("network") ||
    lower.includes("failed to fetch") ||
    lower.includes("fetch failed") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout")
  );
}

/**
 * Run a single Soroban RPC call with capped exponential backoff + full jitter
 * on transient failures.
 *
 * - Transient errors (network blips, rate-limits, gateway errors) are retried
 *   up to `maxAttempts` times.
 * - Non-transient errors propagate immediately, preserving fast failure for
 *   bad requests and auth errors.
 *
 * Full jitter: delay for attempt N is random in [0, baseDelayMs × 2^(N-1)].
 *
 * Exported for unit testing.
 *
 * @param label       Short human-readable name used in error messages.
 * @param fn          The RPC call to execute.
 * @param maxAttempts Total attempts (first try + retries). Default: 3.
 * @param baseDelayMs Base delay in ms for the first retry. Default: 400.
 * @param sleep       Injectable sleep for testing.
 */
export async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 400,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let lastErr: unknown;
  const attempts = Math.max(1, maxAttempts);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || attempt === attempts) break;
      const ceiling = baseDelayMs * 2 ** (attempt - 1);
      const delayMs = Math.floor(Math.random() * ceiling);
      await sleep(delayMs);
    }
  }

  throw lastErr;
}

// ─── Retry safety by operation ────────────────────────────────────────────────
//
// | RPC call              | Kind  | Recovery on a transient failure                     |
// |-----------------------|-------|-----------------------------------------------------|
// | getAccount            | read  | Retry freely (withRpcRetry).                        |
// | simulateTransaction   | read  | Retry freely — a simulation never touches the chain.|
// | getTransaction        | read  | Retry / keep polling by hash.                       |
// | sendTransaction       | write | Resend only the *same signed envelope* (same hash,  |
// |                       |       | same sequence number, so the network applies it at  |
// |                       |       | most once). Never rebuild or re-sign inside the SDK.|
//
// A failed send is only "safe to rebuild" when the request provably never
// reached the RPC. Otherwise the transaction may have been accepted, and a
// rebuilt one would carry the next sequence number and execute the write a
// second time. Those ambiguous cases are resolved by looking the original hash
// up, and reported as "outcome_unknown" when the lookup cannot settle them.

/** Attempts (first try + resends of the identical envelope) for sendTransaction. */
const SEND_MAX_ATTEMPTS = 3;

/**
 * Return `false` only when `err` proves the request never reached the RPC, so
 * the transaction cannot have been accepted. Returns `true` whenever that
 * cannot be ruled out.
 *
 * "Never reached" covers failures to open a connection (DNS, refused,
 * unreachable host), a rate-limit rejection, and a JSON-RPC error object —
 * the server parsed the request and refused it. Timeouts, resets, hang-ups,
 * gateway errors, and anything unrecognised are treated as possibly delivered.
 *
 * Exported for unit testing.
 */
export function mayHaveReachedServer(err: unknown): boolean {
  if (err == null) return true;
  const code =
    typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  const status =
    typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  const lower = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EHOSTUNREACH" ||
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("enotfound") ||
    lower.includes("getaddrinfo") ||
    lower.includes("ehostunreach")
  ) {
    return false;
  }
  if (status === 429) return false;
  // JSON-RPC error objects carry a negative integer code (e.g. -32602).
  if (typeof code === "number" && Number.isInteger(code) && code < 0) return false;
  return true;
}

/** Outcome of submitting one signed envelope, possibly more than once. */
type SendOutcome =
  | {
      kind: "response";
      response: SorobanRpc.Api.SendTransactionResponse;
      /** An earlier attempt failed in a way that may have delivered it. */
      priorAmbiguous: boolean;
      attempts: number;
      lastError?: string;
    }
  | { kind: "not_submitted"; attempts: number; lastError: string }
  | { kind: "ambiguous"; attempts: number; lastError: string };

/**
 * Read the `latestLedgerCloseTime` (unix seconds) an RPC attaches to
 * `getTransaction` responses. Accepts the numeric-string form older RPC
 * versions send. `undefined` when absent or malformed.
 */
function readLatestLedgerCloseTime(response: unknown): number | undefined {
  const value = (response as { latestLedgerCloseTime?: unknown } | null)
    ?.latestLedgerCloseTime;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Unix time (seconds) after which `tx` can no longer be included in a ledger,
 * or `undefined` when it carries no upper time bound.
 */
function readValidUntil(tx: { timeBounds?: { maxTime: string } }): number | undefined {
  const max = Number(tx.timeBounds?.maxTime);
  return Number.isFinite(max) && max > 0 ? max : undefined;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Build a typed failure result. */
function txFailure(
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

function contractErrorCategory(
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

function contractErrorFromSimulation(
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
function txSuccess(
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
function attachEstimate<T extends TxResult>(
  result: T,
  estimate: SimulationEstimate | undefined,
): T {
  return estimate ? { ...result, estimate } : result;
}

/** A non-negative integer amount, as the decimal string the RPC uses. */
function readDecimalString(value: unknown): string | undefined {
  if (typeof value === "string") return /^\d+$/.test(value) ? value : undefined;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value === "bigint") return value >= 0n ? value.toString() : undefined;
  return undefined;
}

/** A non-negative safe integer, or `undefined`. */
function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Call a zero-argument XDR accessor if it exists, swallowing decode errors. */
function callAccessor(target: any, name: string): unknown {
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
const SIMULATION_SOURCE_ACCOUNT =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Read the `latestLedger` field an RPC attaches to its responses.
 *
 * Returns `undefined` when the field is absent or not a number, in which case
 * the caller cannot judge whether the endpoint is keeping up and must not
 * treat it as stale.
 */
function readLatestLedger(response: unknown): number | undefined {
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
function decodeReturnValue(status: unknown): unknown {
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
const CONTRACT_METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

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
function validateInvocation(
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
function extractSimulationError(
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
function formatRpcError(raw: string, rpcUrl: string): string {
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

// ─── Contract argument helpers ────────────────────────────────────────────────
//
// Building Soroban contract arguments requires three layers of boilerplate:
//   Address construction → toScVal() → nativeToScVal(value, {type})
//
// These thin wrappers give every call-site a single, readable expression that
// names the XDR scalar type explicitly so reviewers can verify correctness at
// a glance without cross-referencing the Soroban XDR spec.
//
// All helpers are exported so SDK consumers can build their own contract calls
// without pulling in the Stellar SDK as a direct dependency.

/**
 * Encode a Stellar public key or contract address as an `ScVal` `address`.
 *
 * @param address A G-address (account) or C-address (contract).
 *
 * @throws `TypeError` if `address` is not a well-formed strkey. The Stellar
 *   SDK's own error for this is `"Unsupported address type"`, which does not
 *   say which value was wrong or what was expected, so it is replaced here.
 *
 * @example
 * scAddress("GABC…") // → xdr.ScVal (address variant)
 */
export function scAddress(address: string): xdr.ScVal {
  if (!isValidStellarAddress(address)) {
    throw new TypeError(
      `scAddress: "${String(address)}" is not a Stellar address. ` +
        `Expected a 56-character account key starting with "G" or contract address starting with "C".`,
    );
  }
  try {
    return new Address(address).toScVal();
  } catch (err: any) {
    // Correct shape but a bad strkey checksum — usually a truncated or
    // hand-edited address.
    throw new TypeError(
      `scAddress: "${address}" has the right shape but is not a valid strkey ` +
        `(${err?.message ?? "checksum failed"}). Check for a typo or a truncated copy-paste.`,
    );
  }
}

/** Inclusive bounds of a signed 128-bit integer, as enforced by `scI128`. */
const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

/**
 * Encode an unsigned 32-bit integer as an `ScVal` `u32`.
 *
 * @param value A non-negative integer that fits in a u32 (0 – 4_294_967_295).
 *
 * @throws `RangeError` if `value` is negative, non-integer, or exceeds u32 max.
 *
 * @example
 * scU32(120_960) // round_deadline_ledgers
 * scU32(0)       // round index
 */
export function scU32(value: number): xdr.ScVal {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RangeError(
      `scU32: value ${JSON.stringify(value)} is not an integer. u32 arguments must be whole numbers.`,
    );
  }
  if (value < 0 || value > 0xffffffff) {
    throw new RangeError(
      `scU32: value ${value} is out of range for u32 (0–4294967295).`,
    );
  }
  return nativeToScVal(value, { type: "u32" });
}

/**
 * Encode a signed 128-bit integer as an `ScVal` `i128`.
 *
 * Accepts `bigint` (preferred — lossless) or `number` (converted to bigint).
 *
 * @throws `TypeError` if a non-integer `number` is passed, or if a `number`
 *   exceeds `Number.MAX_SAFE_INTEGER` — past that point the conversion to
 *   bigint silently rounds, which on a monetary amount is a correctness bug
 *   that would only surface after the transaction was signed and submitted.
 * @throws `RangeError` if the value does not fit in a signed 128-bit integer.
 *
 * @example
 * scI128(100_000_000n)        // round_amount in stroops
 * scI128(BigInt("5000000"))   // from a string-serialised DB value
 */
export function scI128(value: bigint | number): xdr.ScVal {
  let n: bigint;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(
        `scI128: non-integer number ${value} cannot be safely converted to i128. ` +
          `Pass a bigint instead.`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `scI128: number ${value} exceeds Number.MAX_SAFE_INTEGER and would lose ` +
          `precision on conversion. Pass a bigint instead.`,
      );
    }
    n = BigInt(value);
  } else if (typeof value === "bigint") {
    n = value;
  } else {
    throw new TypeError(
      `scI128: expected a bigint or integer number, got ${typeof value}.`,
    );
  }
  if (n < I128_MIN || n > I128_MAX) {
    throw new RangeError(
      `scI128: value ${n} is out of range for i128 (${I128_MIN}–${I128_MAX}).`,
    );
  }
  return nativeToScVal(n, { type: "i128" });
}

/**
 * Encode a boolean as an `ScVal` `bool`.
 *
 * @example
 * scBool(true)  // paid_out flag
 * scBool(false)
 */
export function scBool(value: boolean): xdr.ScVal {
  return nativeToScVal(value, { type: "bool" });
}

/**
 * Encode an array of Stellar addresses as an `ScVal` `vec` of `address` items.
 *
 * This is the correct encoding for the `members: Vec<Address>` parameter
 * on `create_circle` and `initialize`.
 *
 * @param addresses Array of G-addresses (accounts) or C-addresses (contracts).
 *
 * @throws `TypeError` if `addresses` is not an array, or if any entry is not a
 *   valid address — the message names the offending index so a bad entry in a
 *   long member list can be found without bisecting it.
 * @throws `Error` if `addresses` is empty — Soroban requires at least one member.
 *
 * @example
 * scAddressVec(["GABC…", "GDEF…"])
 */
export function scAddressVec(addresses: string[]): xdr.ScVal {
  if (!Array.isArray(addresses)) {
    throw new TypeError(
      `scAddressVec: expected an array of addresses, got ${typeof addresses}.`,
    );
  }
  if (addresses.length === 0) {
    throw new Error(
      "scAddressVec: addresses array must not be empty. " +
        "A circle requires at least one member address.",
    );
  }
  return xdr.ScVal.scvVec(
    addresses.map((a, i) => {
      try {
        return scAddress(a);
      } catch (err: any) {
        throw new TypeError(`scAddressVec: entry ${i} is invalid — ${err?.message}`);
      }
    }),
  );
}

// ─── Write options & structured tx logging ────────────────────────────────────

/**
 * Per-call options accepted by every mutation method (`join`, `contribute`,
 * `payout`, `markDefault`, `close`, `createCircle`).
 */
export interface WriteOptions {
  /**
   * Caller correlation metadata to tie this operation to the UI action, request,
   * or job step that triggered it.  Echoed back on the resulting
   * {@link TxResult} and included in structured tx log events.
   *
   * Sanitised by {@link sanitizeTxMetadata} before use, so secrets and signed
   * payloads are stripped.  This is a *tracing* label, not a deduplication /
   * idempotency key — see {@link TxMetadata}.
   */
  metadata?: TxMetadata;
  /**
   * Opt-in stale-write preflight for mutations that support it.
   *
   * When supplied, the mutation force-refreshes the on-chain state, compares
   * it against the expectations declared here, and returns a {@link TxFailure}
   * with `errorCode: "stale_state"` if anything has moved.
   *
   * Only `markDefault` currently honours this field.  Other mutations accept
   * it silently (ignored) for API consistency so callers can pass a uniform
   * options object to all write methods without branching on the method name.
   *
   * Prefer {@link CircleClient.preflight} when you need full stale-state
   * checking across all mutation methods.
   */
  expected?: ExpectedState;
}

/**
 * Lifecycle phase of a {@link TxLogEvent}.
 *
 * `simulated` and `submitted` fire mid-flight (the latter is the first point a
 * hash exists); exactly one terminal event (`confirmed` or `failed`) fires per
 * call.
 */
export type TxLogPhase = "simulated" | "submitted" | "confirmed" | "failed";

/**
 * A structured, log-safe record of one point in a write's lifecycle, handed to
 * the {@link TxLogger} registered via {@link CircleUpClient.setTxLogger}.
 *
 * **Safe by construction.** An event carries only the contract address, the
 * method name, the (public) transaction hash, an error code, and the
 * already-sanitised correlation metadata, plus the numeric simulation
 * {@link SimulationEstimate}.  It never contains the signing
 * `Keypair`, its secret, the signed transaction XDR, or the raw `ScVal`
 * arguments — none of those are ever passed to the logger.
 */
export interface TxLogEvent {
  /** Lifecycle phase this event represents. */
  readonly phase: TxLogPhase;
  /** `contractId.method`, matching the context used in error messages. */
  readonly ctx: string;
  /** The Soroban contract address the call targets. */
  readonly contractId: string;
  /** The contract method name (e.g. "join", "contribute"). */
  readonly method: string;
  /** Transaction hash, once known (from `submitted` onward). */
  readonly txHash?: string;
  /** Ledger the transaction confirmed in — present on `confirmed` only. */
  readonly ledger?: number;
  /** Error category — present on `failed` only. */
  readonly errorCode?: TxErrorCode;
  /**
   * Simulation resource and fee estimates — present on `simulated` and on the
   * terminal event once the write has been simulated.  Log-safe by
   * construction; see {@link SimulationEstimate}.
   */
  readonly estimate?: SimulationEstimate;
  /** Caller correlation metadata (already sanitised), when supplied. */
  readonly metadata?: TxMetadata;
}

/**
 * A sink for {@link TxLogEvent}s.  Register one with
 * {@link CircleUpClient.setTxLogger} to forward correlation-tagged lifecycle
 * events to a logger, tracing backend, or test spy.
 *
 * The SDK invokes it fire-and-forget: a throwing logger never affects the
 * transaction result.
 */
export type TxLogger = (event: TxLogEvent) => void;

// ─── Deployment verification ────────────────────────────────────────────────
//
// `validateCircleUpConfig` proves the configured addresses are well-formed; it
// cannot prove they are *CircleUp* contracts on *this* network. The opt-in
// {@link CircleUpClient.verifyDeployment} flow closes that gap with read-only
// RPC calls (network passphrase + simulated view methods). Construction never
// touches the network; verification runs only when the caller asks for it.

/** Default upper bound, in milliseconds, for each verification RPC call. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;

/**
 * Identifier of one verification check.
 *
 * | Check                      | Evidence read                                   |
 * |----------------------------|-------------------------------------------------|
 * | `network`                  | RPC `getNetwork().passphrase` vs config         |
 * | `factory.usdc`             | factory `get_usdc_token()` vs `contracts.usdc`  |
 * | `factory.reputation`       | factory `get_reputation_contract()` vs `contracts.reputation` |
 * | `factory.circleWasmHash`   | factory `get_circle_wasm_hash()` (vs the expected hash, when supplied) |
 * | `reputation`               | reputation `get_admin()` returns an address     |
 * | `usdc`                     | token `decimals()` equals USDC_DECIMALS         |
 */
export type DeploymentCheckName =
  | "network"
  | "factory.usdc"
  | "factory.reputation"
  | "factory.circleWasmHash"
  | "reputation"
  | "usdc";

/**
 * Outcome of one check.
 *
 * - `ok`           — the identity matched.
 * - `mismatch`     — the contract answered, but with a different identity
 *                    (wrong network, wrong linked address, wrong wasm hash).
 * - `missing`      — no contract instance exists at the address on this network.
 * - `incompatible` — something answered, but not with the expected view
 *                    method or return type (not a CircleUp contract, or an
 *                    incompatible version).
 * - `unreachable`  — the RPC could not be reached or did not answer in time.
 * - `skipped`      — not attempted because a prerequisite check failed.
 */
export type DeploymentCheckStatus =
  | "ok"
  | "mismatch"
  | "missing"
  | "incompatible"
  | "unreachable"
  | "skipped";

/** Result of one verification check. */
export interface DeploymentCheck {
  name: DeploymentCheckName;
  status: DeploymentCheckStatus;
  /** Contract queried, when the check reads a contract. */
  contractId?: string;
  /** The configured / expected identity value. */
  expected?: string;
  /** The value the network reported, when one was read. */
  actual?: string;
  /** Human-readable explanation, safe to log. */
  detail: string;
}

/** Aggregate result of {@link CircleUpClient.verifyDeployment}. */
export interface DeploymentVerification {
  /** `true` only when every check is `ok`. Gate writes on this. */
  ok: boolean;
  checks: DeploymentCheck[];
}

/** Options for {@link CircleUpClient.verifyDeployment}. */
export interface VerifyDeploymentOptions {
  /**
   * Upper bound per RPC call (including the SDK's transient-error retries).
   * @default DEFAULT_VERIFY_TIMEOUT_MS (15 000)
   */
  timeoutMs?: number;
  /**
   * Hex-encoded circle wasm hash the factory is expected to deploy (e.g. from
   * the release manifest). When omitted the hash is reported but not compared.
   */
  expectedCircleWasmHash?: string;
}

/** Simulation error text that means no contract instance exists at the address. */
const MISSING_CONTRACT_RE =
  /required storage entry was not found|value that does not exist|MissingValue|non-?exist(ing|ent)|contract.*not found/i;

/** Simulation error text produced when the RPC itself could not be reached. */
const SIMULATION_NETWORK_ERROR_PREFIX = "Simulation network error";

/** Race `promise` against a timer; resolves to `null` on timeout. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Lower-case hex encoding of a byte array (no Buffer dependency). */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Base client ─────────────────────────────────────────────────────────────

export class CircleUpClient {
  protected rpc: SorobanRpc.Server;
  protected config: CircleUpConfig;
  protected pollConfig: Required<PollConfig>;
  /** Optional structured-log sink; see {@link setTxLogger}. */
  protected txLogger?: TxLogger;

  constructor(config: CircleUpConfig, pollConfig?: PollConfig) {
    // Validate upfront so callers get a clear message for misconfiguration
    // rather than an obscure RPC error on the first method call.
    validateCircleUpConfig(config);
    this.config = config;
    this.rpc = new SorobanRpc.Server(config.rpcUrl, { allowHttp: true });
    // Merge caller-supplied overrides onto the defaults so every field is
    // always present and the polling loop never has to deal with undefined.
    this.pollConfig = { ...DEFAULT_POLL_CONFIG, ...pollConfig };
    validatePollConfig(this.pollConfig);
  }

  // ── Structured logging ───────────────────────────────────────────────────────

  /**
   * Register a {@link TxLogger} to receive correlation-tagged lifecycle events
   * (`simulated` → `submitted` → `confirmed` | `failed`) for every write.
   *
   * Opt-in: with no logger registered the SDK emits nothing, so it never writes
   * to `console` on a caller's behalf. Pass `undefined` to detach.  Returns
   * `this` for chaining.
   *
   * The logger only ever receives log-safe fields (see {@link TxLogEvent}) — the
   * signing key, its secret, the signed XDR, and the raw arguments are never
   * handed to it.
   */
  setTxLogger(logger: TxLogger | undefined): this {
    this.txLogger = logger;
    return this;
  }

  /**
   * Deliver one {@link TxLogEvent} to the registered logger, fire-and-forget.
   *
   * A logger that throws must never turn a successful (or already-failed)
   * transaction into a different outcome, so its error is swallowed here.
   */
  private emitTxLog(event: TxLogEvent): void {
    const logger = this.txLogger;
    if (!logger) return;
    try {
      logger(event);
    } catch {
      // A misbehaving logger must not affect the transaction result.
    }
  }

  // ── Tx helpers ──────────────────────────────────────────────────────────────

  /**
   * The canonical write path for every contract call in the SDK:
   * validate → load account → simulate → assemble & sign → submit → confirm.
   *
   * Every failure mode returns a {@link TxFailure} carrying a
   * {@link TxErrorCode}; this method never throws, so callers can branch on
   * one result object instead of combining a try/catch with a status check.
   *
   * This is a thin wrapper around {@link buildAndSendCore}: it sanitises the
   * caller's correlation {@link WriteOptions.metadata} exactly once, echoes the
   * sanitised copy onto the returned {@link TxResult}, and emits the single
   * terminal (`confirmed` | `failed`) structured-log event.  The mid-flight
   * `simulated` / `submitted` events are emitted from the core.
   */
  protected async buildAndSend(
    sourceKeypair: Keypair,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    options?: WriteOptions,
  ): Promise<TxResult> {
    // Sanitise once at the entry point so both the echoed result metadata and
    // every log event carry the identical secret-free copy.
    const metadata = sanitizeTxMetadata(options?.metadata);

    // The core records the simulation estimate here as soon as it exists, so
    // every outcome after simulation carries it without each failure branch
    // having to thread it through by hand.
    const diagnostics: SimulationDiagnostics = {};
    const result = attachEstimate(
      await this.buildAndSendCore(
        sourceKeypair,
        contractId,
        method,
        args,
        metadata,
        diagnostics,
      ),
      diagnostics.estimate,
    );

    // Exactly one terminal event per call, derived from the final result so it
    // fires no matter which of the many failure branches the core took.
    this.emitTxLog({
      phase: result.success ? "confirmed" : "failed",
      ctx: `${contractId}.${method}`,
      contractId,
      method,
      // Empty-string hashes (failures before submission) collapse to undefined.
      txHash: result.txHash || undefined,
      ledger: result.success ? result.ledger : undefined,
      errorCode: result.success ? undefined : result.errorCode,
      estimate: result.estimate,
      metadata,
    });

    return attachMetadata(result, metadata);
  }

  /**
   * The implementation behind {@link buildAndSend}.  Kept separate so the
   * wrapper owns metadata sanitisation, the terminal log event, and metadata
   * echoing, leaving this method free to `return` from any failure branch
   * without repeating that bookkeeping.
   *
   * `metadata` is already sanitised; it is used only to tag the mid-flight
   * `simulated` / `submitted` log events.  `diagnostics`, when supplied,
   * receives the {@link SimulationEstimate} once simulation has returned; it
   * is write-only from the core's point of view and never influences
   * assembly or submission.
   */
  protected async buildAndSendCore(
    sourceKeypair: Keypair,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    metadata?: TxMetadata,
    diagnostics?: SimulationDiagnostics,
  ): Promise<TxResult> {
    // Context string prepended to every error from this invocation so callers
    // can correlate an error back to the contract method without a stack trace.
    const ctx = `${contractId}.${method}`;

    // Reject a malformed call before spending a network round-trip on it.
    const invalid = validateInvocation(contractId, method, args);
    if (invalid) {
      return txFailure("", `Invalid call to ${ctx}: ${invalid}`, "invalid_argument");
    }

    let account: Awaited<ReturnType<typeof this.rpc.getAccount>>;
    try {
      account = await withRpcRetry("getAccount", () =>
        this.rpc.getAccount(sourceKeypair.publicKey()),
      );
    } catch (err: any) {
      const msg = err?.message ?? "network error";
      // HTTP 404 from getAccount means the account has never been funded.
      const isNotFound =
        msg.includes("404") ||
        msg.toLowerCase().includes("not found") ||
        msg.toLowerCase().includes("does not exist");
      return txFailure(
        "",
        isNotFound
          ? `Account ${sourceKeypair.publicKey()} not found on the network. ` +
            `Fund it with Friendbot (testnet) or a real XLM transfer before calling ${ctx}.`
          : `Failed to load account for ${ctx}: ${formatRpcError(msg, this.config.rpcUrl)}`,
        isNotFound ? "account_not_found" : "network_error",
      );
    }

    // Building can throw on a malformed account object or an argument the
    // Stellar SDK rejects at encode time; keep it inside the typed contract.
    let tx: ReturnType<TransactionBuilder["build"]>;
    try {
      tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(30)
        .build();
    } catch (err: any) {
      return txFailure(
        "",
        `Failed to build the transaction for ${ctx}: ${err?.message ?? "unknown"}.`,
        "invalid_argument",
      );
    }

    // Simulate first to get footprint + fee.
    // withRpcRetry absorbs transient network blips before escalating to the
    // typed TxFailure path.
    let simResult: Awaited<ReturnType<typeof this.rpc.simulateTransaction>>;
    try {
      simResult = await withRpcRetry("simulateTransaction", () =>
        this.rpc.simulateTransaction(tx),
      );
    } catch (err: any) {
      return txFailure(
        "",
        `Network error while simulating ${ctx}: ${formatRpcError(err?.message ?? "unknown", this.config.rpcUrl)}`,
        "network_error",
      );
    }

    // Summarise before branching so a rejected simulation still reports the
    // ledger it ran against.  Diagnostic only: assembly below always uses the
    // full, untouched `simResult`.
    const estimate = summarizeSimulation(simResult, tx.fee);
    if (diagnostics) diagnostics.estimate = estimate;

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      const contractKind = contractId === this.config.contracts.circleFactory
        ? "factory"
        : contractId === this.config.contracts.reputation
          ? "reputation"
          : "circle";
      const humanMessage = extractSimulationError(simResult.error, method, contractKind);
      return txFailure(
        "",
        `Simulation failed for ${ctx}: ${humanMessage}`,
        "simulation_failed",
        undefined,
        contractErrorFromSimulation(simResult.error, method, contractKind, humanMessage),
      );
    }

    // Simulation succeeded: the call is valid against current on-chain state.
    // No hash exists yet — that arrives once the network queues the submission.
    this.emitTxLog({ phase: "simulated", ctx, contractId, method, estimate, metadata });

    let preparedTx: ReturnType<TransactionBuilder["build"]>;
    try {
      preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      preparedTx.sign(sourceKeypair);
    } catch (err: any) {
      return txFailure(
        "",
        `Failed to assemble or sign ${ctx}: ${err?.message ?? "unknown"}. ` +
          `The simulation response may be incomplete, or the signing key may not match the source account.`,
        "unknown",
      );
    }

    // The hash is a pure function of the signed envelope, so it is known before
    // the RPC answers — which is what lets an ambiguous submission be looked up
    // instead of rebuilt.
    const localHash = Buffer.from(preparedTx.hash()).toString("hex");
    const validUntil = readValidUntil(preparedTx);

    const sent = await this.submitEnvelope(preparedTx);

    if (sent.kind === "not_submitted") {
      return txFailure(
        "",
        `Network error while submitting ${ctx}: ${sent.lastError} ` +
          `The request never reached the RPC, so nothing was submitted.`,
        "network_error",
      );
    }

    if (sent.kind === "ambiguous") {
      // The RPC may have accepted the transaction without us seeing the reply.
      // Rebuilding now would sign the *next* sequence number and could apply
      // the write twice, so settle the original hash instead.
      return this.awaitConfirmation(localHash, ctx, {
        submission: "unknown",
        sendAttempts: sent.attempts,
        validUntil,
        lastSendError: sent.lastError,
      });
    }

    const sendResult = sent.response;

    if (sendResult.status === "ERROR") {
      // errorResult is an XDR TransactionResult.  The most useful part for
      // developers is the result code; pull it out rather than dumping raw JSON.
      let detail = "";
      try {
        const resultJson = sendResult.errorResult?.toXDR?.("base64") ?? "";
        detail = resultJson
          ? ` (XDR result: ${resultJson.slice(0, 120)})`
          : ` (raw: ${JSON.stringify(sendResult.errorResult).slice(0, 120)})`;
      } catch {
        // If XDR serialisation fails, omit the detail rather than crashing.
      }
      const rejected = txFailure(
        sendResult.hash,
        `Transaction rejected by the Stellar network for ${ctx}.${detail} ` +
          `This usually means the fee is too low, the sequence number is wrong, ` +
          `or the transaction expired. Try again.`,
        "tx_rejected",
      );
      if (!sent.priorAmbiguous) return rejected;
      // A rejected *resend* does not prove the write did not happen: if the
      // first attempt landed, the resend fails on its now-used sequence number.
      return this.awaitConfirmation(localHash, ctx, {
        submission: "unknown",
        sendAttempts: sent.attempts,
        validUntil,
        lastSendError: sent.lastError,
        ifNeverApplied: rejected,
      });
    }

    if (sendResult.status === "TRY_AGAIN_LATER") {
      // The RPC is congested and has *not* queued this attempt. Polling for a
      // hash the network never accepted would burn the whole timeout budget and
      // then report a misleading "timeout", so return immediately — unless an
      // earlier attempt may already have delivered the same envelope.
      const congested = txFailure(
        sendResult.hash,
        `The RPC asked us to try ${ctx} again later — it is congested and did not ` +
          `queue the transaction. Wait a few seconds and resubmit.`,
        "try_again_later",
      );
      if (!sent.priorAmbiguous) return congested;
      return this.awaitConfirmation(localHash, ctx, {
        submission: "unknown",
        sendAttempts: sent.attempts,
        validUntil,
        lastSendError: sent.lastError,
        ifNeverApplied: congested,
      });
    }

    // Remaining statuses are PENDING and DUPLICATE. DUPLICATE means this exact
    // transaction is already in flight from an earlier submission, so the
    // confirmation poll is the correct next step for both.
    const hash = sendResult.hash;

    // The network has queued the transaction and a hash now exists — this is the
    // first point a UI action can be tied to an on-chain identifier.
    this.emitTxLog({ phase: "submitted", ctx, contractId, method, txHash: hash, metadata });

    return this.awaitConfirmation(hash, ctx, {
      submission: "accepted",
      sendAttempts: sent.attempts,
      validUntil,
      latestLedger: readLatestLedger(sendResult),
    });
  }

  /**
   * Submit one signed envelope, resending the *identical* envelope on a
   * transient failure.
   *
   * Resending is safe because the hash and sequence number never change, so
   * the network applies the transaction at most once (a resend of an accepted
   * envelope comes back as DUPLICATE or as a bad-sequence rejection). What is
   * never done here is rebuilding or re-signing, which would consume the next
   * sequence number and could apply the write a second time.
   *
   * Each failure is classified with {@link mayHaveReachedServer} so the caller
   * knows whether "no response" also means "not submitted".
   */
  private async submitEnvelope(
    tx: ReturnType<TransactionBuilder["build"]>,
  ): Promise<SendOutcome> {
    let priorAmbiguous = false;
    let lastError = "unknown";

    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.rpc.sendTransaction(tx);
        return {
          kind: "response",
          response,
          priorAmbiguous,
          attempts: attempt,
          lastError: priorAmbiguous ? lastError : undefined,
        };
      } catch (err: any) {
        lastError = formatRpcError(err?.message ?? String(err), this.config.rpcUrl);
        if (mayHaveReachedServer(err)) priorAmbiguous = true;
        if (!isTransientRpcError(err) || attempt >= SEND_MAX_ATTEMPTS) {
          return priorAmbiguous
            ? { kind: "ambiguous", attempts: attempt, lastError }
            : { kind: "not_submitted", attempts: attempt, lastError };
        }
        const ceiling = 400 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * ceiling)));
      }
    }
  }

  /**
   * Poll `getTransaction(hash)` until the transaction's fate is known or the
   * poll budget runs out.
   *
   * Used both after the RPC accepted a submission (`submission: "accepted"`)
   * and after a submission whose delivery could not be confirmed
   * (`submission: "unknown"`). In the second case the poll *is* the lookup: a
   * SUCCESS or FAILED result settles it like any other confirmation.
   *
   * A NOT_FOUND result is definitive once the RPC has closed a ledger later
   * than the envelope's upper time bound — after that the transaction can never
   * be included — and is reported as `ifNeverApplied` (or `tx_expired`), both
   * safe to rebuild. Any outcome that leaves the write's fate open is reported
   * as `outcome_unknown` with {@link SubmissionDiagnostics}, never as a code
   * that invites an automatic resubmission.
   */
  private async awaitConfirmation(
    hash: string,
    ctx: string,
    opts: {
      submission: SubmissionDiagnostics["submission"];
      sendAttempts: number;
      validUntil?: number;
      lastSendError?: string;
      latestLedger?: number;
      ifNeverApplied?: TxFailure;
    },
  ): Promise<TxResult> {
    const { timeoutMs, initialIntervalMs, maxIntervalMs, backoffFactor, maxConsecutiveErrors } =
      this.pollConfig;
    const start = Date.now();
    let consecutiveErrors = 0;
    let currentInterval = initialIntervalMs;
    // Highest ledger the RPC has reported so far. A healthy endpoint advances
    // this every few seconds; one that does not is stale and will never
    // observe our transaction.
    let lastLedger: number | undefined = opts.latestLedger;
    let unchangedLedgerPolls = 0;
    let lookup: SubmissionDiagnostics["lookup"] = "not_attempted";
    let lastPollError: string | undefined;

    const outcomeUnknown = (message: string): TxFailure => {
      const lastError = lastPollError ?? opts.lastSendError;
      return txFailure(hash, message, "outcome_unknown", {
        txHash: hash,
        submission: opts.submission,
        sendAttempts: opts.sendAttempts,
        lookup,
        ...(lastLedger !== undefined ? { latestLedger: lastLedger } : {}),
        ...(opts.validUntil !== undefined ? { validUntil: opts.validUntil } : {}),
        ...(lastError !== undefined ? { lastError } : {}),
      });
    };
    const fate =
      opts.submission === "accepted"
        ? "The transaction may still confirm"
        : "The RPC may or may not have received the transaction";

    while (Date.now() - start < timeoutMs) {
      // Wait the current backoff interval before polling.
      // Full jitter: actual wait is in [0, currentInterval] to spread load
      // across clients that all submitted at the same time.
      const jitteredWait = Math.floor(Math.random() * currentInterval);
      await new Promise((r) => setTimeout(r, jitteredWait));

      let status: Awaited<ReturnType<typeof this.rpc.getTransaction>>;
      try {
        status = await this.rpc.getTransaction(hash);
        consecutiveErrors = 0; // reset streak on a successful poll
      } catch (err: any) {
        consecutiveErrors++;
        lastPollError = formatRpcError(err?.message ?? "unknown", this.config.rpcUrl);
        if (lookup === "not_attempted") lookup = "failed";
        if (consecutiveErrors >= maxConsecutiveErrors) {
          // Too many consecutive polling failures — likely a persistent RPC
          // issue; surface it rather than silently looping until timeout.
          return outcomeUnknown(
            `Lost RPC connectivity while waiting for ${ctx} (tx: ${hash}). ` +
              `Last error: ${lastPollError}. ` +
              `${fate} — look the hash up before deciding to resubmit.`,
          );
        }
        // Transient polling error — back off and keep trying
        currentInterval = Math.min(maxIntervalMs, currentInterval * backoffFactor);
        continue;
      }

      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return txSuccess(hash, status.ledger, decodeReturnValue(status));
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        // Extract the result code from the transaction result XDR when
        // available so developers see a Soroban-level error, not just "failed".
        let detail = "";
        try {
          if ("resultXdr" in status && status.resultXdr) {
            const resultMeta = status.resultXdr;
            detail = ` Result XDR: ${resultMeta.toString().slice(0, 120)}`;
          }
        } catch {
          // Ignore XDR parse errors in the error path
        }
        return txFailure(
          hash,
          `Transaction ${hash} was included in a ledger but failed for ${ctx}.${detail} ` +
            `Review the contract state and your inputs, then try again.`,
          "tx_failed",
        );
      }

      // NOT_FOUND — the transaction has not been included (yet).
      lookup = "not_found";

      // Once the RPC has closed a ledger past the envelope's time bound, the
      // transaction can never be included, so "not found" becomes "never applied".
      const closeTime = readLatestLedgerCloseTime(status);
      if (
        opts.validUntil !== undefined &&
        closeTime !== undefined &&
        closeTime > opts.validUntil
      ) {
        return (
          opts.ifNeverApplied ??
          txFailure(
            hash,
            `Transaction ${hash} for ${ctx} expired without being included in a ledger ` +
              `(valid until ${opts.validUntil}, RPC ledger closed at ${closeTime}). ` +
              `It was never applied, so it is safe to rebuild and resubmit.`,
            "tx_expired",
          )
        );
      }

      // Check that the RPC itself is still making progress: a stuck endpoint
      // reports NOT_FOUND forever and is indistinguishable from a slow ledger
      // unless the reported ledger height is compared across polls.
      const latestLedger = readLatestLedger(status);
      if (latestLedger !== undefined) {
        if (latestLedger === lastLedger) {
          unchangedLedgerPolls++;
          if (unchangedLedgerPolls >= STALE_LEDGER_POLLS) {
            return txFailure(
              hash,
              `The RPC at ${this.config.rpcUrl} has not advanced past ledger ${latestLedger} ` +
                `across ${STALE_LEDGER_POLLS} consecutive polls while ${ctx} (tx: ${hash}) was pending. ` +
                `Its view of the chain is stale, so this transaction cannot be confirmed here — ` +
                `check the hash against another RPC or Stellar Expert before resubmitting.`,
              "stale_rpc",
            );
          }
        } else {
          lastLedger = latestLedger;
          unchangedLedgerPolls = 0;
        }
      }

      // Advance the backoff interval for the next poll.
      currentInterval = Math.min(maxIntervalMs, currentInterval * backoffFactor);
    }

    if (opts.submission === "unknown") {
      return outcomeUnknown(
        `Could not determine whether ${ctx} (tx: ${hash}) was submitted: the RPC did not ` +
          `answer the submission and the hash was not found within ${timeoutMs / 1000}s. ` +
          `Look the hash up before deciding to resubmit.`,
      );
    }
    return txFailure(
      hash,
      `Timed out waiting for confirmation of ${ctx} (tx: ${hash}) after ` +
        `${timeoutMs / 1000}s. The transaction may still confirm — ` +
        `check Stellar Expert before retrying.`,
      "timeout",
    );
  }

  /**
   * Look a transaction up by hash, without submitting anything.
   *
   * This is the recovery step for a write that came back as
   * `"outcome_unknown"`, `"timeout"`, or `"stale_rpc"`: check what happened to
   * the original hash (`result.txHash` or `result.diagnostics.txHash`) before
   * deciding whether a new transaction is needed. Only a `"not_found"` lookup
   * made after `diagnostics.validUntil` has passed proves the write was never
   * applied.
   *
   * A read, so transient RPC failures are retried. Never throws.
   */
  async lookupTransaction(txHash: string): Promise<ReadResult<TxLookup>> {
    if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/i.test(txHash)) {
      return {
        ok: false,
        error: `lookupTransaction: ${JSON.stringify(txHash)} is not a transaction hash (64 hex characters).`,
      };
    }
    let status: Awaited<ReturnType<typeof this.rpc.getTransaction>>;
    try {
      status = await withRpcRetry("getTransaction", () => this.rpc.getTransaction(txHash));
    } catch (err: any) {
      return {
        ok: false,
        error: `Failed to look up ${txHash}: ${formatRpcError(err?.message ?? "unknown", this.config.rpcUrl)}`,
      };
    }
    const latestLedger = readLatestLedger(status);
    const latestLedgerCloseTime = readLatestLedgerCloseTime(status);
    const observed = {
      ...(latestLedger !== undefined ? { latestLedger } : {}),
      ...(latestLedgerCloseTime !== undefined ? { latestLedgerCloseTime } : {}),
    };
    switch (status.status) {
      case SorobanRpc.Api.GetTransactionStatus.SUCCESS:
        return {
          ok: true,
          value: {
            status: "success",
            txHash,
            ledger: status.ledger,
            returnValue: decodeReturnValue(status),
            ...observed,
          },
        };
      case SorobanRpc.Api.GetTransactionStatus.FAILED:
        return {
          ok: true,
          value: { status: "failed", txHash, ledger: status.ledger, ...observed },
        };
      case SorobanRpc.Api.GetTransactionStatus.NOT_FOUND:
        return { ok: true, value: { status: "not_found", txHash, ...observed } };
      default:
        return {
          ok: false,
          error: `lookupTransaction: the RPC returned an unrecognised status ${JSON.stringify(
            (status as { status?: unknown }).status,
          )} for ${txHash}.`,
        };
    }
  }

  /**
   * Encode a call's arguments and run them through {@link buildAndSend}.
   *
   * The `scAddress` / `scU32` / `scI128` helpers throw on malformed input,
   * which is the right behaviour for a standalone encoder but would break the
   * promise that a mutation method always resolves to a `TxResult`. Routing
   * every mutation through here converts an encoding error into the same
   * typed failure shape as any other problem, with `errorCode:
   * "invalid_argument"`.
   *
   * @param encodeArgs Builds the `ScVal` argument list; may throw.
   */
  protected async encodeAndSend(
    sourceKeypair: Keypair,
    contractId: string,
    method: string,
    encodeArgs: () => xdr.ScVal[],
    options?: WriteOptions,
  ): Promise<TxResult> {
    let args: xdr.ScVal[];
    try {
      args = encodeArgs();
    } catch (err: any) {
      // Preserve correlation metadata even when argument encoding fails, so a
      // caller's failed attempt still ties back to the originating UI action.
      return attachMetadata(
        txFailure(
          "",
          `Invalid arguments for ${contractId}.${method}: ${err?.message ?? "unknown"}`,
          "invalid_argument",
        ),
        sanitizeTxMetadata(options?.metadata),
      );
    }
    return this.buildAndSend(sourceKeypair, contractId, method, args, options);
  }

  /**
   * The canonical read path: validate → build an unsigned transaction →
   * simulate → decode the return value.
   *
   * Never throws — every failure is returned as a {@link SimulateFailure} whose
   * `error` string has already been through {@link extractSimulationError}, so
   * a contract panic reads the same here as it does on the write path.
   */
  protected async simulateAndRead(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<SimulateResult> {
    const invalid = validateInvocation(contractId, method, args);
    if (invalid) {
      return { ok: false, error: `Invalid call: ${invalid}` };
    }

    // A read-only simulation is never signed or submitted, so the source
    // account only has to be syntactically valid — it does not need to exist
    // on the network, and asking the RPC about it would add a round-trip that
    // always 404s for a throwaway key.
    let tx: ReturnType<TransactionBuilder["build"]>;
    try {
      const source = new Account(SIMULATION_SOURCE_ACCOUNT, "0");
      tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(30)
        .build();
    } catch (err: any) {
      return {
        ok: false,
        error: `Failed to build the simulation transaction: ${err?.message ?? "unknown"}`,
      };
    }

    let simResult: Awaited<ReturnType<typeof this.rpc.simulateTransaction>>;
    try {
      simResult = await withRpcRetry("simulateTransaction(read)", () =>
        this.rpc.simulateTransaction(tx),
      );
    } catch (err: any) {
      return {
        ok: false,
        error: `Simulation network error: ${formatRpcError(err?.message ?? "unknown", this.config.rpcUrl)}`,
      };
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      const contractKind = contractId === this.config.contracts.circleFactory
        ? "factory"
        : contractId === this.config.contracts.reputation
          ? "reputation"
          : "circle";
      return { ok: false, error: extractSimulationError(simResult.error, method, contractKind) };
    }

    if (!("result" in simResult) || !simResult.result) {
      return {
        ok: false,
        error:
          "the simulation returned no value. This method may not be a view function, " +
          "or the RPC response was truncated.",
      };
    }

    try {
      return { ok: true, value: scValToNative(simResult.result.retval) };
    } catch (err: any) {
      return {
        ok: false,
        error: `Failed to decode the contract return value: ${err?.message ?? "unknown"}`,
      };
    }
  }

  /**
   * Convenience wrapper: runs `simulateAndRead` and throws a descriptive
   * `Error` on failure instead of returning a `SimulateFailure`.  Used by
   * every read-only method that has no meaningful fallback for a failed read.
   *
   * Keeping the throw here (rather than in each call-site) means the error
   * message always includes the contract address and method name for easier
   * debugging.
   *
   * The return type is `unknown` on purpose: the decoded value comes straight
   * off the wire and has not been checked against anything. Call-sites narrow
   * it with `mapRawConfig`, `mapRawRoundState`, or one of the `decode*`
   * helpers, so a contract whose return shape has drifted produces a named
   * field error instead of an `undefined` that only fails three layers later.
   */
  protected async simulateAndReadOrThrow(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<unknown> {
    const result = await this.simulateAndRead(contractId, method, args);
    if (!result.ok) {
      throw new Error(
        `Contract call ${contractId}.${method} failed: ${result.error}`,
      );
    }
    return result.value;
  }

  // ── Deployment verification ─────────────────────────────────────────────────

  /**
   * Opt-in, read-only check that the configured network and contract
   * addresses really are the expected CircleUp deployment.
   *
   * Reads the RPC's network passphrase and the stable identity view methods
   * (factory links to USDC / reputation and its circle wasm hash, reputation
   * admin, USDC decimals) and compares them with this client's config. Never
   * signs or submits anything, and never runs implicitly — construction stays
   * offline. Every RPC call is bounded by `options.timeoutMs`.
   *
   * Never throws: each failure is reported as a typed {@link DeploymentCheck}.
   * Applications should keep write actions disabled until `ok` is `true`.
   *
   * @example
   * const result = await client.verifyDeployment();
   * if (!result.ok) {
   *   for (const c of result.checks.filter((c) => c.status !== "ok")) {
   *     console.warn(`${c.name}: ${c.status} — ${c.detail}`);
   *   }
   * }
   */
  async verifyDeployment(options?: VerifyDeploymentOptions): Promise<DeploymentVerification> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("verifyDeployment: timeoutMs must be a positive, finite number of milliseconds.");
    }
    const { circleFactory, reputation, usdc } = this.config.contracts;
    const checks: DeploymentCheck[] = [];

    // ── 1. Network identity — every contract read below is meaningless if the
    //       RPC serves a different network than the config targets.
    const expectedPassphrase = this.config.networkPassphrase;
    let networkCheck: DeploymentCheck;
    try {
      const network = await withTimeout(this.rpc.getNetwork(), timeoutMs);
      if (network === null) {
        networkCheck = {
          name: "network",
          status: "unreachable",
          expected: expectedPassphrase,
          detail: `The RPC at ${this.config.rpcUrl} did not answer getNetwork within ${timeoutMs} ms.`,
        };
      } else if (typeof network?.passphrase !== "string") {
        networkCheck = {
          name: "network",
          status: "incompatible",
          expected: expectedPassphrase,
          detail: "getNetwork returned no passphrase.",
        };
      } else if (network.passphrase !== expectedPassphrase) {
        networkCheck = {
          name: "network",
          status: "mismatch",
          expected: expectedPassphrase,
          actual: network.passphrase,
          detail:
            `The RPC at ${this.config.rpcUrl} serves "${network.passphrase}", ` +
            `but config.networkPassphrase is "${expectedPassphrase}".`,
        };
      } else {
        networkCheck = {
          name: "network",
          status: "ok",
          expected: expectedPassphrase,
          actual: network.passphrase,
          detail: "RPC network passphrase matches the config.",
        };
      }
    } catch (err: any) {
      networkCheck = {
        name: "network",
        status: "unreachable",
        expected: expectedPassphrase,
        detail: `getNetwork failed: ${formatRpcError(err?.message ?? "unknown", this.config.rpcUrl)}`,
      };
    }
    checks.push(networkCheck);

    const contractChecks: Array<[DeploymentCheckName, string]> = [
      ["factory.usdc", circleFactory],
      ["factory.reputation", circleFactory],
      ["factory.circleWasmHash", circleFactory],
      ["reputation", reputation],
      ["usdc", usdc],
    ];
    if (networkCheck.status !== "ok") {
      for (const [name, contractId] of contractChecks) {
        checks.push({
          name,
          status: "skipped",
          contractId,
          detail: "Skipped because the network check did not pass.",
        });
      }
      return { ok: false, checks };
    }

    // ── 2. Contract identity reads, in parallel.
    const read = async (contractId: string, method: string) => {
      const result = await withTimeout(this.simulateAndRead(contractId, method, []), timeoutMs);
      return result ?? { ok: false as const, error: `__timeout__` };
    };
    const [usdcLink, reputationLink, wasmHash, reputationAdmin, usdcDecimals] = await Promise.all([
      read(circleFactory, "get_usdc_token"),
      read(circleFactory, "get_reputation_contract"),
      read(circleFactory, "get_circle_wasm_hash"),
      read(reputation, "get_admin"),
      read(usdc, "decimals"),
    ]);

    /** Map a failed read to a typed check, or run `onValue` for a successful one. */
    const evaluate = (
      name: DeploymentCheckName,
      contractId: string,
      method: string,
      result: SimulateResult,
      expected: string | undefined,
      onValue: (value: unknown) => DeploymentCheck,
    ): DeploymentCheck => {
      if (result.ok) {
        try {
          return onValue(result.value);
        } catch (err: any) {
          return {
            name,
            status: "incompatible",
            contractId,
            expected,
            detail: `${method}() returned an unexpected value: ${err?.message ?? "decode failed"}`,
          };
        }
      }
      const error = result.error;
      if (error === "__timeout__") {
        return {
          name,
          status: "unreachable",
          contractId,
          expected,
          detail: `${method}() did not answer within ${timeoutMs} ms.`,
        };
      }
      if (error.startsWith(SIMULATION_NETWORK_ERROR_PREFIX)) {
        return { name, status: "unreachable", contractId, expected, detail: error };
      }
      if (MISSING_CONTRACT_RE.test(error)) {
        return {
          name,
          status: "missing",
          contractId,
          expected,
          detail: `No initialised contract answered ${method}() at ${contractId} on this network.`,
        };
      }
      return {
        name,
        status: "incompatible",
        contractId,
        expected,
        detail: `${method}() failed: ${error}`,
      };
    };

    const compareAddress =
      (name: DeploymentCheckName, label: string, expected: string, method: string) =>
      (value: unknown): DeploymentCheck => {
        const actual = decodeAddress(value, `${circleFactory}.${method}`);
        return actual === expected
          ? { name, status: "ok", contractId: circleFactory, expected, actual, detail: `Factory ${label} link matches the config.` }
          : {
              name,
              status: "mismatch",
              contractId: circleFactory,
              expected,
              actual,
              detail: `The factory is linked to ${label} ${actual}, but the config names ${expected}.`,
            };
      };

    checks.push(
      evaluate("factory.usdc", circleFactory, "get_usdc_token", usdcLink, usdc,
        compareAddress("factory.usdc", "USDC token", usdc, "get_usdc_token")),
      evaluate("factory.reputation", circleFactory, "get_reputation_contract", reputationLink, reputation,
        compareAddress("factory.reputation", "reputation contract", reputation, "get_reputation_contract")),
    );

    const expectedHash = options?.expectedCircleWasmHash?.trim().toLowerCase() || undefined;
    checks.push(
      evaluate("factory.circleWasmHash", circleFactory, "get_circle_wasm_hash", wasmHash, expectedHash, (value) => {
        if (!(value instanceof Uint8Array) || value.length !== 32) {
          throw new Error("expected a 32-byte hash");
        }
        const actual = bytesToHex(value);
        if (expectedHash === undefined) {
          return {
            name: "factory.circleWasmHash",
            status: "ok",
            contractId: circleFactory,
            actual,
            detail: "Factory reports a circle wasm hash (no expected hash supplied to compare).",
          };
        }
        return actual === expectedHash
          ? {
              name: "factory.circleWasmHash",
              status: "ok",
              contractId: circleFactory,
              expected: expectedHash,
              actual,
              detail: "Factory circle wasm hash matches the expected release.",
            }
          : {
              name: "factory.circleWasmHash",
              status: "mismatch",
              contractId: circleFactory,
              expected: expectedHash,
              actual,
              detail: "Factory deploys a different circle wasm than the expected release.",
            };
      }),
      evaluate("reputation", reputation, "get_admin", reputationAdmin, undefined, (value) => {
        const actual = decodeAddress(value, `${reputation}.get_admin`);
        return {
          name: "reputation",
          status: "ok",
          contractId: reputation,
          actual,
          detail: "Reputation contract answers get_admin().",
        };
      }),
      evaluate("usdc", usdc, "decimals", usdcDecimals, String(USDC_DECIMALS), (value) => {
        const decimals = decodeU32(value, `${usdc}.decimals`);
        return decimals === USDC_DECIMALS
          ? {
              name: "usdc",
              status: "ok",
              contractId: usdc,
              expected: String(USDC_DECIMALS),
              actual: String(decimals),
              detail: "USDC token reports the expected decimals.",
            }
          : {
              name: "usdc",
              status: "mismatch",
              contractId: usdc,
              expected: String(USDC_DECIMALS),
              actual: String(decimals),
              detail: `Token reports ${decimals} decimals; USDC uses ${USDC_DECIMALS}.`,
            };
      }),
    );

    return { ok: checks.every((c) => c.status === "ok"), checks };
  }
}

// ─── Factory client ───────────────────────────────────────────────────────────

// ─── Types and constants used by client.ts subclasses ─────────────────────────

/** Snapshot of a circle's full on-chain state produced by {@link CircleClient.getFullState}. */
export interface CircleFullState {
  config: CircleConfig;
  status: CircleStatus;
  /** Current round state; `null` when the circle is Completed or Cancelled. */
  currentRound: RoundState | null;
}

/** @internal In-memory cache entry used by CircleClient. */
export interface CacheEntry {
  state: CircleFullState;
  /** Timestamp (ms) when this entry was populated. */
  fetchedAt: number;
}

/**
 * How long (in milliseconds) a cached {@link CircleFullState} is considered fresh.
 * Pass `cacheTtlMs: 0` to {@link CircleClient} to disable caching entirely.
 */
export const DEFAULT_FULL_STATE_CACHE_TTL_MS = 10_000;

/**
 * Default upper bound, in milliseconds, for a single indexer request.
 * Override per client via {@link IndexerClientOptions.timeoutMs} or per call
 * via {@link IndexerRequestOptions.timeoutMs}.
 */
export const DEFAULT_INDEXER_TIMEOUT_MS = 10_000;
