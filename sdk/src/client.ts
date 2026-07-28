import {
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
  RawCircleConfig,
  RawRoundState,
  RoundState,
  CircleStatus,
  TxResult,
  TxSuccess,
  TxFailure,
  TxErrorCode,
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
  mapRawConfig,
  mapRawRoundState,
  assertValidCircleStatus,
} from "./types";

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
const DEFAULT_POLL_CONFIG = {
  initialIntervalMs: 2_000,
  maxIntervalMs: 10_000,
  backoffFactor: 1.5,
  timeoutMs: 60_000,
  maxConsecutiveErrors: 5,
} as const satisfies Required<PollConfig>;

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
function txSuccess(txHash: string, ledger: number): TxSuccess {
  return { success: true, txHash, ledger };
}

/**
 * Extract a human-readable error string from the Soroban simulation error.
 *
 * The raw `simResult.error` is an XDR-encoded diagnostic string that often
 * contains the contract panic message, e.g.:
 *   "HostError: Value(UnexpectedType)\n  ... contract backtrace ...\nError(Contract, #1)"
 *
 * We try to surface the most actionable part:
 * 1. A quoted contract message (text between "contract backtrace" or panic string)
 * 2. The last `Error(...)` segment which encodes the contract error code
 * 3. Fall back to the full string if neither pattern matches
 */
function extractSimulationError(raw: string): string {
  // Soroban contract panics embed the message as a quoted string, e.g.:
  //   Event contract log (debug): "already joined"
  const logMatch = raw.match(/contract\s+log\s+\(debug\):\s+"([^"]+)"/i);
  if (logMatch) return logMatch[1];

  // Panic messages appear as: panic called with: "message"
  const panicMatch = raw.match(/panic called with:\s+"([^"]+)"/i);
  if (panicMatch) return panicMatch[1];

  // ContractError enum variant: Error(Contract, #N) — extract code number
  const errCodeMatch = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (errCodeMatch) {
    return `Contract error code ${errCodeMatch[1]}. Check that the operation is valid for the current circle state.`;
  }

  // If the raw string is short enough to be user-visible, pass it through;
  // otherwise trim it to avoid dumping a multi-KB XDR blob into a UI toast.
  return raw.length <= 300 ? raw : raw.slice(0, 297) + "...";
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
 * @example
 * scAddress("GABC…") // → xdr.ScVal (address variant)
 */
export function scAddress(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

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
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
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
 * @throws `TypeError` if a non-integer `number` is passed.
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
    n = BigInt(value);
  } else {
    n = value;
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
 * @throws `Error` if `addresses` is empty — Soroban requires at least one member.
 *
 * @example
 * scAddressVec(["GABC…", "GDEF…"])
 */
export function scAddressVec(addresses: string[]): xdr.ScVal {
  if (addresses.length === 0) {
    throw new Error(
      "scAddressVec: addresses array must not be empty. " +
        "A circle requires at least one member address.",
    );
  }
  return xdr.ScVal.scvVec(addresses.map((a) => new Address(a).toScVal()));
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
    if (this.pollConfig.backoffFactor < 1) {
      throw new RangeError(
        `PollConfig.backoffFactor must be >= 1, got ${this.pollConfig.backoffFactor}.`,
      );
    }
  }

  // ── Tx helpers ──────────────────────────────────────────────────────────────

  protected async buildAndSend(
    sourceKeypair: Keypair,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<TxResult> {
    // Context string prepended to every error from this invocation so callers
    // can correlate an error back to the contract method without a stack trace.
    const ctx = `${contractId}.${method}`;

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
          : `Failed to load account for ${ctx}: ${msg}`,
        isNotFound ? "account_not_found" : "network_error",
      );
    }

    const contract = new Contract(contractId);

    const txBuilder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30);

    const tx = txBuilder.build();

    // Simulate first to get footprint + fee
    let simResult: Awaited<ReturnType<typeof this.rpc.simulateTransaction>>;
    try {
      simResult = await this.rpc.simulateTransaction(tx);
    } catch (err: any) {
      return txFailure(
        "",
        `Network error while simulating ${ctx}: ${err?.message ?? "unknown"}. ` +
          `Check your RPC endpoint (${this.config.rpcUrl}).`,
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

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(sourceKeypair);

    let sendResult: Awaited<ReturnType<typeof this.rpc.sendTransaction>>;
    try {
      sendResult = await this.rpc.sendTransaction(preparedTx);
    } catch (err: any) {
      return txFailure(
        "",
        `Network error while submitting ${ctx}: ${err?.message ?? "unknown"}. ` +
          `Check your RPC endpoint (${this.config.rpcUrl}).`,
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

    // Poll for confirmation with exponential backoff + full jitter
    const hash = sendResult.hash;
    const { timeoutMs, initialIntervalMs, maxIntervalMs, backoffFactor, maxConsecutiveErrors } =
      this.pollConfig;
    const start = Date.now();
    let consecutiveErrors = 0;
    let currentInterval = initialIntervalMs;

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
              `Last error: ${(err as any)?.message ?? "unknown"}. ` +
              `The transaction may still confirm — check Stellar Expert before retrying.`,
            "network_error",
          );
        }
        // Transient polling error — back off and keep trying
        currentInterval = Math.min(maxIntervalMs, currentInterval * backoffFactor);
        continue;
      }

      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return txSuccess(hash, status.ledger);
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

      // NOT_FOUND / still PENDING — advance the backoff interval for next poll
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

  protected async simulateAndRead(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<SimulateResult> {
    const dummyKeypair = Keypair.random();
    const account = await this.rpc
      .getAccount(dummyKeypair.publicKey())
      .catch(() => {
        return {
          id: dummyKeypair.publicKey(),
          sequence: "0",
          incrementSequenceNumber: () => {},
        } as any;
      });

    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    let simResult: Awaited<ReturnType<typeof this.rpc.simulateTransaction>>;
    try {
      simResult = await this.rpc.simulateTransaction(tx);
    } catch (err: any) {
      return {
        ok: false,
        error: `Simulation network error: ${err?.message ?? "unknown"}`,
      };
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return { ok: false, error: simResult.error };
    }

    if (!("result" in simResult) || !simResult.result) {
      return { ok: false, error: "no result from simulation" };
    }

    return { ok: true, value: scValToNative(simResult.result.retval) };
  }

  /**
   * Convenience wrapper: runs `simulateAndRead` and throws a descriptive
   * `Error` on failure instead of returning a `SimulateFailure`.  Used by
   * every read-only method that has no meaningful fallback for a failed read.
   *
   * Keeping the throw here (rather than in each call-site) means the error
   * message always includes the contract address and method name for easier
   * debugging.
   */
  protected async simulateAndReadOrThrow<T>(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<T> {
    const result = await this.simulateAndRead(contractId, method, args);
    if (!result.ok) {
      throw new Error(
        `Contract call ${contractId}.${method} failed: ${result.error}`,
      );
    }
    return result.value as T;
  }
}

// ─── Factory client ───────────────────────────────────────────────────────────

export class FactoryClient extends CircleUpClient {
  private get contractId() {
    return this.config.contracts.circleFactory;
  }

  /** Create a new circle. Returns the new circle's contract address. */
  async createCircle(params: {
    creator: Keypair;
    members: string[];
    roundAmountStroops: bigint;
    roundDeadlineLedgers: number;
  }): Promise<{ result: TxResult; circleAddress?: string }> {
    const membersVal = scAddressVec(params.members);

    const result = await this.buildAndSend(
      params.creator,
      this.contractId,
      "create_circle",
      [
        scAddress(params.creator.publicKey()),
        membersVal,
        scI128(params.roundAmountStroops),
        scU32(params.roundDeadlineLedgers),
      ],
    );

    if (!result.success) {
      return { result };
    }

    // The factory `create_circle` entry-point returns the new circle's Address.
    // Read it back via simulation so callers don't have to query get_circles()
    // and guess which address is new.
    let circleAddress: string | undefined;
    try {
      const circles = await this.getCircles();
      // The last entry in the registry is always the one we just created
      // because the factory appends and never reorders.
      if (circles.length > 0) {
        circleAddress = circles[circles.length - 1];
      }
    } catch {
      // Non-fatal: the transaction succeeded; we just can't resolve the address
      // right now.  Callers can fall back to getCircles() themselves.
    }

    return { result, circleAddress };
  }

  async getCircles(): Promise<string[]> {
    return this.simulateAndReadOrThrow<string[]>(
      this.contractId,
      "get_circles",
      [],
    );
  }

  async getCircleCount(): Promise<number> {
    return this.simulateAndReadOrThrow<number>(
      this.contractId,
      "get_circle_count",
      [],
    );
  }
}

// ─── Circle state cache ───────────────────────────────────────────────────────

/** Snapshot of a circle's full on-chain state produced by `getFullState`. */
export interface CircleFullState {
  config: CircleConfig;
  status: CircleStatus;
  currentRound: RoundState;
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

  async join(member: Keypair): Promise<TxResult> {
    const result = await this.buildAndSend(
      member,
      this.circleAddress,
      "join",
      [scAddress(member.publicKey())],
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async contribute(member: Keypair): Promise<TxResult> {
    const result = await this.buildAndSend(
      member,
      this.circleAddress,
      "contribute",
      [scAddress(member.publicKey())],
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async payout(caller: Keypair): Promise<TxResult> {
    const result = await this.buildAndSend(caller, this.circleAddress, "payout", []);
    if (result.success) this.invalidateCache();
    return result;
  }

  async markDefault(caller: Keypair, member: string): Promise<TxResult> {
    const result = await this.buildAndSend(
      caller,
      this.circleAddress,
      "mark_default",
      [scAddress(member)],
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async close(caller: Keypair): Promise<TxResult> {
    const result = await this.buildAndSend(caller, this.circleAddress, "close", [
      scAddress(caller.publicKey()),
    ]);
    if (result.success) this.invalidateCache();
    return result;
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
    const raw = await this.simulateAndReadOrThrow<RawCircleConfig>(
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
    const raw = await this.simulateAndReadOrThrow<string>(
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
    const raw = await this.simulateAndReadOrThrow<RawRoundState>(
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
    return this.simulateAndReadOrThrow<bigint>(
      this.circleAddress,
      "get_collateral",
      [scAddress(member)],
    );
  }

  async getDefaults(member: string): Promise<number> {
    return this.simulateAndReadOrThrow<number>(
      this.circleAddress,
      "get_defaults",
      [scAddress(member)],
    );
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
    return this.simulateAndReadOrThrow<boolean>(
      this.circleAddress,
      "has_contributed",
      [
        scAddress(member),
        scU32(roundIndex),
      ],
    );
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
    const { currentRound } = await this.getFullState();
    return this.hasContributed(member, currentRound.roundIndex);
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

    const [config, status, currentRound] = await Promise.all([
      this.getConfig(),
      this.getStatus(),
      this.getCurrentRound(),
    ]);

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
   * Manually discard the in-memory state cache. Useful when an external event
   * (e.g. an indexer webhook or a Stellar event stream update) indicates the
   * on-chain state has changed but you haven't called a mutation through this
   * client instance.
   */
  invalidateCache(): void {
    this._stateCache = null;
  }

  private isCacheValid(): boolean {
    if (this.cacheTtlMs === 0 || this._stateCache === null) return false;
    return Date.now() - this._stateCache.fetchedAt < this.cacheTtlMs;
  }
}

// ─── Reputation client ────────────────────────────────────────────────────────

export class ReputationClient extends CircleUpClient {
  private get contractId() {
    return this.config.contracts.reputation;
  }

  async getScore(member: string): Promise<number> {
    return this.simulateAndReadOrThrow<number>(
      this.contractId,
      "score",
      [scAddress(member)],
    );
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
