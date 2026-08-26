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
  SorobanRpc,
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
  StateMismatch,
  SimulateResult,
  ReadResult,
  ApiCirclesListResponse,
  ApiCircleDetailResponse,
  ApiMembersResponse,
  ApiRoundsResponse,
  ApiReputationResponse,
  ApiMemberContributionsResponse,
  ApiHealthResponse,
} from "./types";
import {
  validateCircleUpConfig,
  isValidContractAddress,
  isValidStellarAddress,
  mapRawConfig,
  mapRawRoundState,
  assertValidCircleStatus,
  decodeU32,
  decodeBigInt,
  decodeBoolean,
  decodeAddressList,
  validateContractArgs,
} from "./types";
import {
  buildSnapshot,
  computeActionEligibility,
  detectStateMismatches,
  isGateBlocked,
  isSnapshotFresh,
} from "./gating";
import type {
  ActualState,
  CircleAction,
  ExpectedState,
  GateBlockReason,
  GateOptions,
  GateResult,
  StateSnapshot,
} from "./gating";

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

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Build a typed failure result. */
function txFailure(
  txHash: string,
  errorMessage: string,
  errorCode: TxErrorCode = "unknown",
): TxFailure {
  return { success: false, txHash, errorMessage, errorCode };
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
 * Render a human-readable summary of the state divergences a write preflight
 * found, suitable for a UI toast or a log line (issue #347).
 *
 * Each mismatch is shown as `field (expected X, now Y)` so a caller can tell
 * the user exactly what moved — which round advanced, whose contribution
 * landed — instead of a generic "please try again".
 */
function formatMismatchMessage(mismatches: readonly StateMismatch[]): string {
  const details = mismatches
    .map(
      (m) =>
        `${m.field} (expected ${JSON.stringify(m.expected)}, now ${JSON.stringify(m.actual)})`,
    )
    .join("; ");
  return (
    `Preflight aborted the submission: the on-chain state has moved past what this ` +
    `action expected — ${details}. Refresh the circle state and rebuild the action ` +
    `before resubmitting.`
  );
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
function extractSimulationError(raw: string): string {
  // Priority 1: Contract debug log — e.g. Event contract log (debug): "already joined"
  const logMatch = raw.match(/contract\s+log\s+\(debug\):\s+"([^"]+)"/i);
  if (logMatch) return logMatch[1];

  // Priority 2: Panic messages — e.g. panic called with: "message"
  const panicMatch = raw.match(/panic called with:\s+"([^"]+)"/i);
  if (panicMatch) return panicMatch[1];

  // Priority 3: ContractError enum variant — Error(Contract, #N)
  const errCodeMatch = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (errCodeMatch) {
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
      `The RPC at ${rpcUrl} did not respond in time. ` +
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

// ─── Base client ─────────────────────────────────────────────────────────────

export class CircleUpClient {
  protected rpc: SorobanRpc.Server;
  protected config: CircleUpConfig;
  protected pollConfig: Required<PollConfig>;

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

  // ── Tx helpers ──────────────────────────────────────────────────────────────

  /**
   * The canonical write path for every contract call in the SDK:
   * validate → load account → simulate → assemble & sign → submit → confirm.
   *
   * Every failure mode returns a {@link TxFailure} carrying a
   * {@link TxErrorCode}; this method never throws, so callers can branch on
   * one result object instead of combining a try/catch with a status check.
   */
  protected async buildAndSend(
    sourceKeypair: Keypair,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
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
      account = await this.rpc.getAccount(sourceKeypair.publicKey());
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

    // Simulate first to get footprint + fee
    let simResult: Awaited<ReturnType<typeof this.rpc.simulateTransaction>>;
    try {
      simResult = await this.rpc.simulateTransaction(tx);
    } catch (err: any) {
      return txFailure(
        "",
        `Network error while simulating ${ctx}: ${formatRpcError(err?.message ?? "unknown", this.config.rpcUrl)}`,
        "network_error",
      );
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      const humanMessage = extractSimulationError(simResult.error);
      return txFailure(
        "",
        `Simulation failed for ${ctx}: ${humanMessage}`,
        "simulation_failed",
      );
    }

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

    let sendResult: Awaited<ReturnType<typeof this.rpc.sendTransaction>>;
    try {
      sendResult = await this.rpc.sendTransaction(preparedTx);
    } catch (err: any) {
      return txFailure(
        "",
        `Network error while submitting ${ctx}: ${formatRpcError(err?.message ?? "unknown", this.config.rpcUrl)}`,
        "network_error",
      );
    }

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
      return txFailure(
        sendResult.hash,
        `Transaction rejected by the Stellar network for ${ctx}.${detail} ` +
          `This usually means the fee is too low, the sequence number is wrong, ` +
          `or the transaction expired. Try again.`,
        "tx_rejected",
      );
    }

    if (sendResult.status === "TRY_AGAIN_LATER") {
      // The RPC is congested and has *not* queued the transaction. Polling for
      // a hash the network never accepted would burn the whole timeout budget
      // and then report a misleading "timeout", so return immediately with the
      // code that tells the caller to resubmit.
      return txFailure(
        sendResult.hash,
        `The RPC asked us to try ${ctx} again later — it is congested and did not ` +
          `queue the transaction. Wait a few seconds and resubmit.`,
        "try_again_later",
      );
    }

    // Remaining statuses are PENDING and DUPLICATE. DUPLICATE means this exact
    // transaction is already in flight from an earlier submission, so the
    // confirmation poll below is the correct next step for both.

    // Poll for confirmation with exponential backoff + full jitter
    const hash = sendResult.hash;
    const { timeoutMs, initialIntervalMs, maxIntervalMs, backoffFactor, maxConsecutiveErrors } =
      this.pollConfig;
    const start = Date.now();
    let consecutiveErrors = 0;
    let currentInterval = initialIntervalMs;
    // Highest ledger the RPC has reported so far. A healthy endpoint advances
    // this every few seconds; one that does not is stale and will never
    // observe our transaction.
    let lastLedger: number | undefined = readLatestLedger(sendResult);
    let unchangedLedgerPolls = 0;

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
        if (consecutiveErrors >= maxConsecutiveErrors) {
          // Too many consecutive polling failures — likely a persistent RPC
          // issue; surface it rather than silently looping until timeout.
          return txFailure(
            hash,
            `Lost RPC connectivity while waiting for ${ctx} (tx: ${hash}). ` +
              `Last error: ${formatRpcError((err as any)?.message ?? "unknown", this.config.rpcUrl)}. ` +
              `The transaction may still confirm — check Stellar Expert before retrying.`,
            "network_error",
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

      // NOT_FOUND — the transaction has not been included yet. Before waiting
      // again, check that the RPC itself is still making progress: a stuck
      // endpoint reports NOT_FOUND forever and is indistinguishable from a
      // slow ledger unless the reported ledger height is compared across polls.
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

    return txFailure(
      hash,
      `Timed out waiting for confirmation of ${ctx} (tx: ${hash}) after ` +
        `${timeoutMs / 1000}s. The transaction may still confirm — ` +
        `check Stellar Expert before retrying.`,
      "timeout",
    );
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
  ): Promise<TxResult> {
    let args: xdr.ScVal[];
    try {
      args = encodeArgs();
    } catch (err: any) {
      return txFailure(
        "",
        `Invalid arguments for ${contractId}.${method}: ${err?.message ?? "unknown"}`,
        "invalid_argument",
      );
    }
    return this.buildAndSend(sourceKeypair, contractId, method, args);
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
      simResult = await this.rpc.simulateTransaction(tx);
    } catch (err: any) {
      return {
        ok: false,
        error: `Simulation network error: ${formatRpcError(err?.message ?? "unknown", this.config.rpcUrl)}`,
      };
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return { ok: false, error: extractSimulationError(simResult.error) };
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
}

// ─── Factory client ───────────────────────────────────────────────────────────

export class FactoryClient extends CircleUpClient {
  private get contractId() {
    return this.config.contracts.circleFactory;
  }

  /**
   * Create a new circle.
   *
   * `circleAddress` is read from the transaction's own return value, so it
   * identifies the circle *this* call created. It is `undefined` when the
   * transaction failed or when the confirming RPC response carried no readable
   * address — never a guess based on the registry, which would name another
   * caller's circle whenever two creations land in the same ledger.
   *
   * Never throws: a malformed member list or round amount comes back as
   * `result.errorCode === "invalid_argument"`, like every other failure.
   */
  async createCircle(params: {
    creator: Keypair;
    members: string[];
    roundAmountStroops: bigint;
    roundDeadlineLedgers: number;
  }): Promise<{ result: TxResult; circleAddress?: string }> {
    // Validate all parameters upfront so the error message names the exact
    // field that is wrong, rather than surfacing as an opaque encoding throw.
    const argError = validateContractArgs([
      { name: "members", value: params.members, type: "addressVec" },
      { name: "roundAmountStroops", value: params.roundAmountStroops, type: "i128" },
      { name: "roundDeadlineLedgers", value: params.roundDeadlineLedgers, type: "u32" },
    ]);
    if (argError) {
      const result: TxResult = {
        success: false,
        txHash: "",
        errorMessage: `Invalid arguments for create_circle: ${argError}`,
        errorCode: "invalid_argument",
      };
      return { result };
    }

    const result = await this.encodeAndSend(
      params.creator,
      this.contractId,
      "create_circle",
      () => [
        scAddress(params.creator.publicKey()),
        scAddressVec(params.members),
        scI128(params.roundAmountStroops),
        scU32(params.roundDeadlineLedgers),
      ],
    );

    if (!result.success || !isValidStellarAddress(result.returnValue)) {
      return { result };
    }

    return { result, circleAddress: result.returnValue };
  }

  async getCircles(): Promise<string[]> {
    const raw = await this.simulateAndReadOrThrow(
      this.contractId,
      "get_circles",
      [],
    );
    return decodeAddressList(raw, "getCircles");
  }

  async getCircleCount(): Promise<number> {
    const raw = await this.simulateAndReadOrThrow(
      this.contractId,
      "get_circle_count",
      [],
    );
    return decodeU32(raw, "getCircleCount");
  }
}

// ─── Circle state cache ───────────────────────────────────────────────────────

/** Snapshot of a circle's full on-chain state produced by `getFullState`. */
export interface CircleFullState {
  config: CircleConfig;
  status: CircleStatus;
  /**
   * Current round state.  `null` when the circle is `Completed` or
   * `Cancelled` — callers must guard on `status` before accessing.
   */
  currentRound: RoundState | null;
}

interface CacheEntry {
  state: CircleFullState;
  /** Timestamp (ms) when this entry was populated. */
  fetchedAt: number;
}

/**
 * How long (in milliseconds) a cached `CircleFullState` is considered fresh.
 * Defaults to 10 seconds — long enough to avoid hammering the RPC during a
 * single UI render cycle, short enough that callers see near-real-time data.
 *
 * Pass `cacheTtlMs: 0` to `CircleClient` to disable caching entirely.
 */
export const DEFAULT_FULL_STATE_CACHE_TTL_MS = 10_000;

/**
 * Error thrown by {@link CircleClient.gateActionOrThrow} when a gate check
 * blocks the requested action.  Callers can `catch` this and inspect `reason`
 * to branch on the specific cause without parsing the message string.
 */
export class GateError extends Error {
  /** Machine-readable block reason — mirrors {@link GateBlocked.reason}. */
  readonly reason: GateBlockReason;

  constructor(reason: GateBlockReason, message: string) {
    super(message);
    this.name = "GateError";
    this.reason = reason;
  }
}

// ─── Stale-write preflight (issue #347) ─────────────────────────────────────────

/**
 * Options for the opt-in stale-write preflight.
 *
 * Attach this to any {@link CircleClient} mutation — or pass it to
 * {@link CircleClient.preflight} directly — to force a fresh on-chain read and
 * compare it against the state the caller's decision was based on.  If anything
 * the caller pinned has moved, the mutation returns a {@link TxFailure} with
 * `errorCode: "stale_state"` instead of submitting a transaction that would
 * predictably revert.
 *
 * Omitting the preflight entirely preserves the fast path: a caller with
 * trusted-fresh data submits directly with no extra RPC round-trip.
 */
export interface PreflightOptions {
  /**
   * The state the caller expected when they decided to act.  Only the fields
   * that were actually part of the decision need be supplied; unspecified
   * fields are never compared.  See {@link ExpectedState}.
   */
  expected: ExpectedState;

  /**
   * The member address whose contribution status should be verified.  Required
   * only when `expected.hasContributed` is set, because resolving that flag
   * needs an extra `has_contributed` read keyed by member.  Ignored otherwise.
   */
  memberAddress?: string;
}

/**
 * Result of a {@link CircleClient.preflight} check — a discriminated union so
 * callers pattern-match on `stale` rather than probing optional fields.
 */
export type PreflightResult = PreflightFresh | PreflightStale;

/** The declared expectations still match on-chain state; safe to proceed. */
export interface PreflightFresh {
  readonly stale: false;
}

/**
 * The on-chain state has diverged from what the caller expected.  `mismatches`
 * lists exactly which fields moved; `message` is a ready-to-display summary.
 */
export interface PreflightStale {
  readonly stale: true;
  readonly mismatches: readonly StateMismatch[];
  readonly message: string;
}

// ─── Circle client ────────────────────────────────────────────────────────────

export class CircleClient extends CircleUpClient {
  private circleAddress: string;
  private cacheTtlMs: number;
  private _stateCache: CacheEntry | null = null;

  /**
   * @param config        SDK network / contract configuration.
   * @param circleAddress On-chain address of the circle contract.
   * @param cacheTtlMs    How long (ms) `getFullState` results are cached.
   *                      Pass `0` to disable caching. Defaults to
   *                      {@link DEFAULT_FULL_STATE_CACHE_TTL_MS} (10 s).
   * @param pollConfig    Optional override for the tx confirmation polling
   *                      schedule (intervals, backoff, timeout).  Useful in
   *                      tests (fast intervals) and on mainnet (longer budget).
   */
  constructor(
    config: CircleUpConfig,
    circleAddress: string,
    cacheTtlMs: number = DEFAULT_FULL_STATE_CACHE_TTL_MS,
    pollConfig?: PollConfig,
  ) {
    super(config, pollConfig);
    if (!circleAddress || typeof circleAddress !== "string") {
      throw new Error("CircleClient: circleAddress is required.");
    }
    if (!isValidContractAddress(circleAddress)) {
      throw new Error(
        `CircleClient: "${circleAddress}" is not a valid Soroban contract address ` +
          `(expected a 56-character string starting with "C").`,
      );
    }
    this.circleAddress = circleAddress;
    this.cacheTtlMs = cacheTtlMs;
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  async join(member: Keypair, preflight?: PreflightOptions): Promise<TxResult> {
    const stale = await this.preflightGuard(preflight);
    if (stale) return stale;
    const result = await this.encodeAndSend(
      member,
      this.circleAddress,
      "join",
      () => [scAddress(member.publicKey())],
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async contribute(member: Keypair, preflight?: PreflightOptions): Promise<TxResult> {
    const stale = await this.preflightGuard(preflight);
    if (stale) return stale;
    const result = await this.encodeAndSend(
      member,
      this.circleAddress,
      "contribute",
      () => [scAddress(member.publicKey())],
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async payout(caller: Keypair, preflight?: PreflightOptions): Promise<TxResult> {
    const stale = await this.preflightGuard(preflight);
    if (stale) return stale;
    const result = await this.buildAndSend(caller, this.circleAddress, "payout", []);
    if (result.success) this.invalidateCache();
    return result;
  }

  async markDefault(
    caller: Keypair,
    member: string,
    preflight?: PreflightOptions,
  ): Promise<TxResult> {
    // Validate the member address early so callers get a clear error that names
    // the field rather than an opaque scAddress throw wrapped in encodeAndSend.
    const argError = validateContractArgs([
      { name: "member", value: member, type: "address" },
    ]);
    if (argError) {
      return {
        success: false,
        txHash: "",
        errorMessage: `Invalid arguments for mark_default: ${argError}`,
        errorCode: "invalid_argument",
      };
    }
    const stale = await this.preflightGuard(preflight);
    if (stale) return stale;
    const result = await this.encodeAndSend(
      caller,
      this.circleAddress,
      "mark_default",
      () => [scAddress(member)],
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async close(caller: Keypair, preflight?: PreflightOptions): Promise<TxResult> {
    const stale = await this.preflightGuard(preflight);
    if (stale) return stale;
    const result = await this.encodeAndSend(
      caller,
      this.circleAddress,
      "close",
      () => [scAddress(caller.publicKey())],
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  // ── Stale-write preflight (issue #347) ───────────────────────────────────────

  /**
   * Actively check whether a write would be submitted against stale state.
   *
   * Force-refreshes the full on-chain state, resolves the fields the caller
   * pinned in `options.expected`, and reports any divergence as a list of typed
   * {@link StateMismatch} values.  This lets a caller detect a *predictable*
   * stale submission — one that would revert because another member acted after
   * the caller's view was rendered — without having to submit and watch it fail.
   *
   * This is a read-only operation: it never submits a transaction and never
   * alters any subsequent transaction's arguments.  A `stale: false` result
   * means nothing the caller pinned has changed — **not** that the write is
   * guaranteed to succeed.  The contract remains the final authority.
   *
   * @example
   * const pre = await client.preflight({ expected: { roundIndex: 2 } });
   * if (pre.stale) { showError(pre.message); return; }
   * await client.contribute(keypair);
   *
   * @param options  The expected state to compare against, plus an optional
   *                 member address for `hasContributed` resolution.
   */
  async preflight(options: PreflightOptions): Promise<PreflightResult> {
    const fresh = await this.getFullState({ forceRefresh: true });
    const actual = await this.resolveActualState(fresh, options);
    const mismatches = detectStateMismatches(options.expected, actual);
    if (mismatches.length === 0) {
      return { stale: false };
    }
    return { stale: true, mismatches, message: formatMismatchMessage(mismatches) };
  }

  /**
   * Resolve the concrete {@link ActualState} to compare a preflight expectation
   * against, from a freshly-fetched {@link CircleFullState}.
   *
   * Round-derived fields are `null` when the circle has no current round.  The
   * per-member `hasContributed` flag costs an extra `has_contributed` read, so
   * it is resolved only when the caller both pinned an expectation for it and
   * supplied `memberAddress`; otherwise it stays `null` and the comparator
   * skips it.
   */
  private async resolveActualState(
    fresh: CircleFullState,
    options: PreflightOptions,
  ): Promise<ActualState> {
    const round = fresh.currentRound;

    let hasContributed: boolean | null = null;
    if (
      options.expected.hasContributed !== undefined &&
      options.memberAddress &&
      round
    ) {
      hasContributed = await this.hasContributed(
        options.memberAddress,
        round.roundIndex,
      );
    }

    return {
      status: fresh.status,
      roundIndex: round ? round.roundIndex : null,
      contributionsReceived: round ? round.contributionsReceived : null,
      hasContributed,
      paidOut: round ? round.paidOut : null,
    };
  }

  /**
   * Shared guard run at the top of every mutation.  Returns a `stale_state`
   * {@link TxFailure} when an opted-in preflight detects divergence, or `null`
   * to let the mutation proceed.
   *
   * Two paths return `null` (proceed):
   *   1. **Fast path** — no `preflight` supplied, so no extra RPC is spent and
   *      a caller with trusted-fresh data submits immediately.
   *   2. **Read failure** — the preflight read itself threw (e.g. a transient
   *      RPC error).  A preflight is an *optimisation*, not the source of
   *      truth: failing it must not block a write the contract would accept, so
   *      the guard swallows the error and proceeds, leaving the contract as the
   *      final authority and preserving the mutation's non-throwing contract.
   */
  private async preflightGuard(
    preflight: PreflightOptions | undefined,
  ): Promise<TxFailure | null> {
    if (!preflight) return null;

    let result: PreflightResult;
    try {
      result = await this.preflight(preflight);
    } catch {
      return null;
    }

    if (!result.stale) return null;

    return {
      success: false,
      txHash: "",
      errorMessage: result.message,
      errorCode: "stale_state",
      mismatches: result.mismatches,
    };
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  /**
   * Fetch and decode the circle's configuration from the contract.
   *
   * **Throws** a descriptive `Error` on any simulation or decode failure.
   * For a non-throwing alternative that returns a discriminated union instead
   * of throwing, use {@link getConfigResult}.
   */
  async getConfig(): Promise<CircleConfig> {
    const raw = await this.simulateAndReadOrThrow(
      this.circleAddress,
      "get_config",
      [],
    );
    return mapRawConfig(raw);
  }

  /**
   * Non-throwing variant of {@link getConfig}.
   *
   * Returns a `ReadResult<CircleConfig>` discriminated union instead of
   * throwing, so callers can handle failures inline without try/catch:
   *
   * @example
   * const r = await client.getConfigResult();
   * if (r.ok) {
   *   console.log(r.value.roundAmount);
   * } else {
   *   showError(r.error); // human-readable string
   * }
   */
  async getConfigResult(): Promise<ReadResult<CircleConfig>> {
    try {
      const value = await this.getConfig();
      return { ok: true, value };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "getConfig failed" };
    }
  }

  /**
   * Fetch the circle's current lifecycle status from the contract.
   *
   * Validates that the returned value is a recognised {@link CircleStatus}
   * variant and throws if it is not, so callers are never silently handed a
   * garbage string if the contract changes.
   *
   * **Throws** on simulation failure or unrecognised status.
   * For a non-throwing alternative use {@link getStatusResult}.
   */
  async getStatus(): Promise<CircleStatus> {
    const raw = await this.simulateAndReadOrThrow(
      this.circleAddress,
      "get_status",
      [],
    );
    // Validate the returned string is a known variant before returning it.
    // assertValidCircleStatus throws with a descriptive message if not.
    return assertValidCircleStatus(raw);
  }

  /**
   * Non-throwing variant of {@link getStatus}.
   *
   * @example
   * const r = await client.getStatusResult();
   * if (r.ok && r.value === "Active") showContributeButton();
   */
  async getStatusResult(): Promise<ReadResult<CircleStatus>> {
    try {
      const value = await this.getStatus();
      return { ok: true, value };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "getStatus failed" };
    }
  }

  /**
   * Fetch the current round state from the contract.
   *
   * The contract returns an error when the circle is `Completed` or
   * `Cancelled` (no active round exists).  That error propagates as a thrown
   * `Error` here. For a non-throwing alternative that lets you handle the
   * not-active case inline, use {@link getCurrentRoundResult}.
   *
   * **Throws** on simulation failure or when the circle is not Active/Pending.
   */
  async getCurrentRound(): Promise<RoundState> {
    const raw = await this.simulateAndReadOrThrow(
      this.circleAddress,
      "get_current_round",
      [],
    );
    return mapRawRoundState(raw);
  }

  /**
   * Non-throwing variant of {@link getCurrentRound}.
   *
   * This is the preferred method for UI components that need to handle
   * `Completed` and `Cancelled` circles gracefully — the contract returns an
   * error for those states, which surfaces here as `{ ok: false, error: "…" }`
   * rather than an uncaught exception.
   *
   * @example
   * const r = await client.getCurrentRoundResult();
   * if (r.ok) {
   *   showRoundProgress(r.value);
   * } else {
   *   // circle is Completed or Cancelled — show history instead
   *   showHistory();
   * }
   */
  async getCurrentRoundResult(): Promise<ReadResult<RoundState>> {
    try {
      const value = await this.getCurrentRound();
      return { ok: true, value };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "getCurrentRound failed" };
    }
  }

  async getCollateral(member: string): Promise<bigint> {
    const raw = await this.simulateAndReadOrThrow(
      this.circleAddress,
      "get_collateral",
      [scAddress(member)],
    );
    return decodeBigInt(raw, "getCollateral");
  }

  async getDefaults(member: string): Promise<number> {
    const raw = await this.simulateAndReadOrThrow(
      this.circleAddress,
      "get_defaults",
      [scAddress(member)],
    );
    return decodeU32(raw, "getDefaults");
  }

  /**
   * Returns whether `member` has contributed in the specified round.
   *
   * **Important:** The contract stores contribution flags in _temporary_
   * storage, which is scoped to the ledger sequence number of that round.
   * Querying a past round index once the round has advanced may return `false`
   * even if the member did contribute. Use this for the _current_ round only,
   * or use {@link hasContributedCurrentRound} which handles that for you.
   * For historical contribution data across all rounds, query the indexer via
   * {@link IndexerClient.getMemberContributions}, {@link IndexerClient.getMembers},
   * or {@link IndexerClient.getRounds}.
   *
   * @param member     Stellar public key of the member to check.
   * @param roundIndex Zero-based round index to query.
   */
  async hasContributed(member: string, roundIndex: number): Promise<boolean> {
    const raw = await this.simulateAndReadOrThrow(
      this.circleAddress,
      "has_contributed",
      [
        scAddress(member),
        scU32(roundIndex),
      ],
    );
    return decodeBoolean(raw, "hasContributed");
  }

  /**
   * Returns whether `member` has already contributed to the **current** round.
   *
   * This is the preferred helper for the common UI use-case of showing a
   * "Contribute" button — it fetches the current round index automatically so
   * callers don't need to know it ahead of time.
   *
   * Uses the state cache when available, so repeated calls within the TTL
   * window are cheap (one RPC simulation for the round index, zero for the
   * cache hit).
   *
   * @example
   * const contributed = await client.hasContributedCurrentRound(walletAddress);
   * if (!contributed) showContributeButton();
   *
   * @param member Stellar public key of the member to check.
   */
  async hasContributedCurrentRound(member: string): Promise<boolean> {
    const state = await this.getFullState();
    if (!state.currentRound) {
      // Completed or Cancelled — no active round; member cannot contribute.
      return false;
    }
    return this.hasContributed(member, state.currentRound.roundIndex);
  }

  /**
   * Fetch the full on-chain state of this circle (config + status + current
   * round) in a single parallel RPC burst, then cache the result for
   * `cacheTtlMs` milliseconds.
   *
   * Subsequent calls within the TTL window return the cached snapshot without
   * hitting the RPC. This is safe because circle state only changes when a
   * mutating transaction is confirmed; the cache is automatically invalidated
   * after any successful mutation method on this client (`join`, `contribute`,
   * `payout`, `markDefault`, `close`).
   *
   * Pass `{ forceRefresh: true }` to bypass the cache and fetch a fresh
   * snapshot unconditionally (useful after receiving an external event or
   * indexer notification).
   *
   * @example
   * // Fast — returns cache if available
   * const state = await client.getFullState();
   *
   * // Force a fresh fetch after an external event
   * const state = await client.getFullState({ forceRefresh: true });
   *
   * // Disable caching for a one-off client
   * const client = new CircleClient(config, addr, 0);
   */
  async getFullState(options?: { forceRefresh?: boolean }): Promise<CircleFullState> {
    if (!options?.forceRefresh && this.isCacheValid()) {
      return this._stateCache!.state;
    }

    // Fetch config and status in parallel; current round is fetched separately
    // because its result depends on status (Completed/Cancelled → no round).
    const [config, status] = await Promise.all([
      this.getConfig(),
      this.getStatus(),
    ]);

    // currentRound is only meaningful for Active and Pending circles.
    // For terminal states (Completed / Cancelled) we store null rather than
    // propagating the contract's CircleNotActive error.
    let currentRound: RoundState | null = null;
    if (status === "Active" || status === "Pending") {
      const roundResult = await this.getCurrentRoundResult();
      if (roundResult.ok) {
        currentRound = roundResult.value;
      }
      // If the round fetch fails despite being in an active-ish state we leave
      // currentRound as null — callers must guard on it, and the gate layer
      // will block writes that require a valid round.
    }

    const state: CircleFullState = { config, status, currentRound };
    this._stateCache = { state, fetchedAt: Date.now() };
    return state;
  }

  /**
   * Returns the most recently fetched full state without making any RPC calls.
   * Returns `null` if no state has been fetched yet or if the cache has expired.
   *
   * Useful for rendering a loading skeleton while `getFullState()` is in flight:
   *
   * @example
   * const cached = client.getCachedState();
   * if (cached) renderCircle(cached);   // show stale state immediately
   * const fresh = await client.getFullState();
   * renderCircle(fresh);                // update with fresh data
   */
  getCachedState(): CircleFullState | null {
    return this.isCacheValid() ? this._stateCache!.state : null;
  }

  /**
   * Build a {@link StateSnapshot} from the current cache entry (if valid) or
   * by calling {@link getFullState}.  The snapshot's `fetchedAtMs` is set to
   * the cache entry's `fetchedAt` so age calculations are accurate.
   *
   * @param latestLedger  Most-recently-indexed ledger for deadline math.
   *                      Pass `null` when not available.
   * @param forceRefresh  When `true`, bypass the cache.
   */
  async buildStateSnapshot(
    latestLedger: number | null = null,
    forceRefresh = false,
  ): Promise<StateSnapshot> {
    if (!forceRefresh && this.isCacheValid() && this._stateCache) {
      const { state, fetchedAt } = this._stateCache;
      return buildSnapshot(
        state.status,
        state.currentRound,
        state.config,
        latestLedger,
        fetchedAt,
      );
    }

    const state = await this.getFullState({ forceRefresh: true });
    const fetchedAt = this._stateCache?.fetchedAt ?? Date.now();
    return buildSnapshot(state.status, state.currentRound, state.config, latestLedger, fetchedAt);
  }

  /**
   * Evaluate whether a contract action is safe to submit, using the most
   * recently fetched (or freshly fetched) state snapshot as the source of
   * truth.
   *
   * The method:
   *   1. Fetches (or returns cached) full state.
   *   2. Builds a {@link StateSnapshot} with `fetchedAtMs` tied to the cache
   *      entry so age is measured from the actual RPC call, not from when
   *      `gateAction` is called.
   *   3. Delegates to {@link computeActionEligibility}.
   *
   * Returns the raw {@link GateResult} — callers decide whether to throw,
   * surface a UI error, or silently skip.  For a throwing variant see
   * {@link gateActionOrThrow}.
   *
   * @example
   * const gate = await client.gateAction("contribute", {
   *   memberAddress: wallet,
   *   hasContributedCurrentRound: false,
   * });
   * if (!gate.allowed) { showError(gate.message); return; }
   * await client.contribute(keypair);
   */
  async gateAction(
    action: CircleAction,
    opts: Omit<GateOptions, "nowMs"> & { latestLedger?: number | null } = {},
  ): Promise<GateResult> {
    const { latestLedger = null, ...gateOpts } = opts;
    const snapshot = await this.buildStateSnapshot(latestLedger);
    return computeActionEligibility(action, snapshot, gateOpts);
  }

  /**
   * Like {@link gateAction} but throws a {@link GateError} instead of
   * returning a blocked result.  Useful in async flows where propagating
   * an exception is more ergonomic than checking the return value:
   *
   * @example
   * await client.gateActionOrThrow("join", { memberAddress: wallet });
   * // if we reach here the gate passed — safe to proceed
   * await client.join(keypair);
   *
   * @throws {@link GateError} when the gate blocks the action.
   */
  async gateActionOrThrow(
    action: CircleAction,
    opts: Omit<GateOptions, "nowMs"> & { latestLedger?: number | null } = {},
  ): Promise<void> {
    const result = await this.gateAction(action, opts);
    if (isGateBlocked(result)) {
      throw new GateError(result.reason, result.message);
    }
  }

  /**
   * Manually discard the in-memory state cache. Useful when an external event
   * (e.g. an indexer webhook or a Stellar event stream update) indicates the
   * on-chain state has changed but you haven't called a mutation through this
   * client instance.
   */
  invalidateCache(): void {
    this._stateCache = null;
  }

  /**
   * Returns `true` when the cache holds a valid (non-expired) entry.
   *
   * Exposed as a public method so external code (e.g. app layer) can check
   * staleness without triggering a fetch.
   */
  isCacheStale(): boolean {
    return !this.isCacheValid();
  }

  private isCacheValid(): boolean {
    if (this.cacheTtlMs === 0 || this._stateCache === null) return false;
    return isSnapshotFresh(
      { fetchedAtMs: this._stateCache.fetchedAt },
      this.cacheTtlMs,
    );
  }
}

// ─── Reputation client ────────────────────────────────────────────────────────

export class ReputationClient extends CircleUpClient {
  private get contractId() {
    return this.config.contracts.reputation;
  }

  async getScore(member: string): Promise<number> {
    const raw = await this.simulateAndReadOrThrow(
      this.contractId,
      "score",
      [scAddress(member)],
    );
    return decodeU32(raw, "getScore");
  }
}

// ─── Indexer client ───────────────────────────────────────────────────────────
//
// The indexer REST API surfaces data that the Soroban contracts cannot provide
// directly: historical rounds, per-member contribution counts across all rounds,
// aggregated reputation, and the full list of circles (the factory only stores
// an on-chain Vec which requires a contract read per address).
//
// All methods throw a descriptive `IndexerError` on any non-2xx response or
// network failure so callers always get an actionable message rather than a
// generic TypeError from a failed JSON parse.

/** Thrown by {@link IndexerClient} on any failed request. */
export class IndexerError extends Error {
  /** HTTP status code, or 0 for network-level failures. */
  readonly status: number;
  /** The URL that was requested. */
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = "IndexerError";
    this.status = status;
    this.url = url;
  }
}

/**
 * Typed HTTP client for the CircleUp indexer REST API.
 *
 * Provides access to indexed / historical data that Soroban contracts cannot
 * expose directly:
 *  - Full list of circles (with creator, status, round info)
 *  - Per-circle member roster with collateral + contribution counts
 *  - Completed round history (payouts, contributions, defaults)
 *  - Aggregated member reputation across all circles
 *
 * @example
 * const indexer = new IndexerClient({ ...sdkConfig, indexerUrl: "http://localhost:3001" });
 *
 * // List all circles
 * const { circles } = await indexer.getCircles();
 *
 * // Detailed state for one circle (includes members + latest ledger)
 * const { circle, members, latestLedger } = await indexer.getCircleDetail("CADDR...");
 *
 * // Historical rounds
 * const { rounds } = await indexer.getRounds("CADDR...");
 *
 * // Member reputation
 * const rep = await indexer.getReputation("GABC...");
 */
export class IndexerClient {
  private baseUrl: string;

  /**
   * @param config SDK config. `indexerUrl` is required — construction throws
   *               immediately if it is missing so the error surfaces at setup
   *               time rather than at the first API call.
   */
  constructor(config: CircleUpConfig) {
    if (!config.indexerUrl || config.indexerUrl.trim() === "") {
      throw new Error(
        "IndexerClient requires config.indexerUrl to be set. " +
        "Add the indexer base URL (e.g. 'http://localhost:3001') to your CircleUpConfig.",
      );
    }
    // Strip trailing slash so path concatenation is consistent
    this.baseUrl = config.indexerUrl.replace(/\/+$/, "");
  }

  // ── Internal fetch wrapper ────────────────────────────────────────────────

  /**
   * Fetch `path` from the indexer, parse the JSON response, and return the
   * typed body. Throws {@link IndexerError} on any non-2xx status or network
   * failure.
   */
  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err: any) {
      throw new IndexerError(
        `Network error reaching the indexer at ${url}: ${err?.message ?? "fetch failed"}. ` +
        "Check that the indexer is running and that config.indexerUrl is correct.",
        0,
        url,
      );
    }

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json() as Record<string, unknown>;
        const msg = body?.error;
        detail = typeof msg === "string" ? ` — ${msg}` : "";
      } catch {
        // Ignore JSON parse failure for error bodies
      }
      throw new IndexerError(
        `Indexer returned HTTP ${response.status} for ${url}${detail}`,
        response.status,
        url,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err: any) {
      throw new IndexerError(
        `Failed to parse JSON response from ${url}: ${err?.message ?? "invalid JSON"}`,
        response.status,
        url,
      );
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Fetch all circles known to the indexer, ordered newest first.
   *
   * Equivalent to `GET /circles`.
   */
  async getCircles(): Promise<ApiCirclesListResponse> {
    return this.get<ApiCirclesListResponse>("/circles");
  }

  /**
   * Fetch detailed state for a single circle: the circle row, its current
   * member roster (with reputation scores and contribution counts), and the
   * latest ledger the indexer has processed.
   *
   * `latestLedger` can be combined with `circle.deadline_ledger` to display a
   * human-readable countdown without an extra RPC call.
   *
   * Throws {@link IndexerError} with `status === 404` if the address is not
   * found.
   *
   * Equivalent to `GET /circles/:address`.
   *
   * @param address On-chain contract address of the circle.
   */
  async getCircleDetail(address: string): Promise<ApiCircleDetailResponse> {
    return this.get<ApiCircleDetailResponse>(`/circles/${encodeURIComponent(address)}`);
  }

  /**
   * Fetch the member roster for a circle with live contribution counts.
   *
   * `total_contributions` on each member reflects the number of rounds they
   * have contributed to in this circle — useful for deriving whether they
   * have contributed to the current round without a contract query:
   *
   * ```ts
   * // member has contributed to current round if their total equals current_round + 1
   * const contributed = member.total_contributions > circle.current_round;
   * ```
   *
   * Equivalent to `GET /circles/:address/members`.
   *
   * @param address On-chain contract address of the circle.
   */
  async getMembers(address: string): Promise<ApiMembersResponse> {
    return this.get<ApiMembersResponse>(`/circles/${encodeURIComponent(address)}/members`);
  }

  /**
   * Fetch all completed payout rounds for a circle, including per-round
   * contributions and defaults.
   *
   * `pendingDefaults` contains defaults that have been recorded but belong to
   * a round that has not yet been paid out.
   *
   * Equivalent to `GET /circles/:address/rounds`.
   *
   * @param address On-chain contract address of the circle.
   */
  async getRounds(address: string): Promise<ApiRoundsResponse> {
    return this.get<ApiRoundsResponse>(`/circles/${encodeURIComponent(address)}/rounds`);
  }

  /**
   * Fetch aggregated reputation data for a member across all circles.
   *
   * Returns the on-chain score, per-circle contribution counts, and per-circle
   * default counts. Members who have never participated return `score: 0` and
   * empty arrays rather than a 404.
   *
   * Equivalent to `GET /reputation/:member`.
   *
   * @param member Stellar public key of the member.
   */
  async getReputation(member: string): Promise<ApiReputationResponse> {
    return this.get<ApiReputationResponse>(`/reputation/${encodeURIComponent(member)}`);
  }

  /**
   * Fetch the raw contribution history for a member.
   *
   * Unlike {@link getReputation} (counts only) or {@link getRounds} (nested
   * under payouts), this returns every indexed contribution row for building
   * a personal history view.
   *
   * Pass `circle` to restrict results to one circle. An unknown circle address
   * yields a 404; a member with no contributions yields an empty list.
   *
   * Equivalent to `GET /members/:member/contributions`.
   *
   * @param member Stellar public key of the member.
   * @param options Optional circle filter and pagination.
   */
  async getMemberContributions(
    member: string,
    options?: { circle?: string; page?: number; limit?: number },
  ): Promise<ApiMemberContributionsResponse> {
    const params = new URLSearchParams();
    if (options?.circle) params.set("circle", options.circle);
    if (options?.page != null) params.set("page", String(options.page));
    if (options?.limit != null) params.set("limit", String(options.limit));
    const qs = params.toString();
    return this.get<ApiMemberContributionsResponse>(
      `/members/${encodeURIComponent(member)}/contributions${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Check whether the indexer is reachable and up to date.
   *
   * Equivalent to `GET /health`.
   *
   * @throws {@link IndexerError} if the indexer is unreachable.
   */
  async health(): Promise<ApiHealthResponse> {
    return this.get<ApiHealthResponse>("/health");
  }
}
