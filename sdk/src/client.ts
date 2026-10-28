// --- @circleup/sdk client.ts --------------------------------------------------
//
// Sub-client classes: FactoryClient, CircleClient, ReputationClient,
// IndexerClient.  The base class (CircleUpClient) and all shared helpers live
// in circleUpClient.ts to keep individual modules under 2500 LOC.
//
// All consumers import from sdk/src/index.ts � the public API surface is unchanged.

// Re-export everything from the base module so test files and deep imports
// that use 'from "../client"' still find CircleUpClient, scAddress, etc.
export * from './circleUpClient';


import {
  CircleUpClient,
  scAddress,
  scU32,
  scI128,
  scBool,
  scAddressVec,
  attachMetadata,
  DEFAULT_FULL_STATE_CACHE_TTL_MS,
  formatMismatchMessage,
  normalizeNotInitializedError,
  normalizeCircleNotActiveError,
  isConfigAbsent,
  isCircleNotActive,
  DEFAULT_INDEXER_TIMEOUT_MS,
} from './circleUpClient';
import type {
  PollConfig,
  WriteOptions,
  CircleFullState,
  CacheEntry,
} from './circleUpClient';
import { Keypair } from '@stellar/stellar-sdk';
import type { xdr } from '@stellar/stellar-sdk';
import type {
  CircleUpConfig, CircleConfig, CircleStatus, RoundState,
  TxResult, TxFailure, ReadResult, StateMismatch,
  ApiCirclesListResponse, ApiCircleDetailResponse, ApiMembersResponse,
  ApiRoundsResponse, ApiReputationResponse, ApiMemberContributionsResponse,
  ApiHealthResponse, ApiAuditEventsResponse, GetCirclesParams,
  ApiCircleStatus, CircleSortField, IndexerPagination,
  GetMemberContributionsParams, PaginateOptions,
} from './types';
import {
  validateContractArgs, isValidContractAddress, isValidStellarAddress,
  decodeAddressList, decodeU32, decodeI128, decodeBoolean,
  mapRawConfig, mapRawRoundState, assertValidCircleStatus, sanitizeTxMetadata,
} from './types';
import {
  buildSnapshot, computeActionEligibility, detectStateMismatches,
  isGateBlocked, isSnapshotFresh,
} from './gating';
import type {
  ActualState, CircleAction, ExpectedState, GateBlockReason,
  GateOptions, GateResult, StateSnapshot,
} from './gating';
import { INDEXER_MAX_PAGE_SIZE } from './constants';
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
  async createCircle(
    params: {
      creator: Keypair;
      members: string[];
      roundAmountStroops: bigint;
      roundDeadlineLedgers: number;
    },
    options?: WriteOptions,
  ): Promise<{ result: TxResult; circleAddress?: string }> {
    // Validate all parameters upfront so the error message names the exact
    // field that is wrong, rather than surfacing as an opaque encoding throw.
    const argError = validateContractArgs([
      { name: "members", value: params.members, type: "addressVec" },
      { name: "roundAmountStroops", value: params.roundAmountStroops, type: "i128" },
      { name: "roundDeadlineLedgers", value: params.roundDeadlineLedgers, type: "u32" },
    ]);
    if (argError) {
      // Echo correlation metadata even on this pre-flight rejection so the
      // caller can tie the failed attempt back to its originating UI action.
      const result: TxResult = attachMetadata(
        {
          success: false,
          txHash: "",
          errorMessage: `Invalid arguments for create_circle: ${argError}`,
          errorCode: "invalid_argument",
        },
        sanitizeTxMetadata(options?.metadata),
      );
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
      options,
    );

    // The factory returns the new circle's contract Address; an account key or
    // any other value is not a circle, so it is never reported as one.
    const created = result.success ? result.returnValue : undefined;
    if (typeof created !== "string" || !isValidContractAddress(created)) {
      return { result };
    }

    return { result, circleAddress: created };
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

// CircleFullState, CacheEntry, DEFAULT_FULL_STATE_CACHE_TTL_MS imported from circleUpClient.ts

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

  async join(member: Keypair, options?: WriteOptions): Promise<TxResult> {
    const result = await this.encodeAndSend(
      member,
      this.circleAddress,
      "join",
      () => [scAddress(member.publicKey())],
      options,
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async contribute(member: Keypair, options?: WriteOptions): Promise<TxResult> {
    const stale = await this.preflightGuard(
      options?.expected ? { expected: options.expected } : undefined,
    );
    if (stale) return stale;
    const result = await this.encodeAndSend(
      member,
      this.circleAddress,
      "contribute",
      () => [scAddress(member.publicKey())],
      options,
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async payout(caller: Keypair, options?: WriteOptions): Promise<TxResult> {
    const stale = await this.preflightGuard(
      options?.expected ? { expected: options.expected } : undefined,
    );
    if (stale) return stale;
    const result = await this.buildAndSend(
      caller,
      this.circleAddress,
      "payout",
      [],
      options,
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async markDefault(
    caller: Keypair,
    member: string,
    options?: WriteOptions,
  ): Promise<TxResult> {
    // Validate the member address early so callers get a clear error that names
    // the field rather than an opaque scAddress throw wrapped in encodeAndSend.
    const argError = validateContractArgs([
      { name: "member", value: member, type: "address" },
    ]);
    if (argError) {
      // Preserve correlation metadata on the pre-flight rejection too.
      return attachMetadata(
        {
          success: false,
          txHash: "",
          errorMessage: `Invalid arguments for mark_default: ${argError}`,
          errorCode: "invalid_argument",
        },
        sanitizeTxMetadata(options?.metadata),
      );
    }
    const stale = await this.preflightGuard(
      options?.expected ? { expected: options.expected } : undefined,
    );
    if (stale) return stale;
    const result = await this.encodeAndSend(
      caller,
      this.circleAddress,
      "mark_default",
      () => [scAddress(member)],
      options,
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async close(caller: Keypair, options?: WriteOptions): Promise<TxResult> {
    const stale = await this.preflightGuard(
      options?.expected ? { expected: options.expected } : undefined,
    );
    if (stale) return stale;
    const result = await this.encodeAndSend(
      caller,
      this.circleAddress,
      "close",
      () => [scAddress(caller.publicKey())],
      options,
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
   *
   * When the contract has not been initialized yet (the `Config` storage key
   * is absent) the simulation returns `ContractError::NotInitialized` (code 1).
   * This surfaces here as a thrown `Error` whose message contains
   * `"NotInitialized"` or `"Contract error code 1"`.  Callers that need to
   * distinguish the not-initialized case from a network error should use the
   * non-throwing {@link getConfigResult} and inspect `result.ok` / `result.error`.
   *
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
   * throwing, so callers can handle the not-initialized case and network
   * failures inline without try/catch:
   *
   * ```ts
   * const r = await client.getConfigResult();
   * if (r.ok) {
   *   console.log(r.value.roundAmount);
   * } else if (isConfigAbsent(r.error)) {
   *   showBanner("This circle has not been initialized yet.");
   * } else {
   *   showError(r.error); // network or decode error
   * }
   * ```
   *
   * The `error` string contains `"not initialized"` (case-insensitive) when
   * the contract's `Config` storage key is absent, letting callers detect
   * this specific case without parsing arbitrary error messages:
   *
   * ```ts
   * if (!r.ok && r.error.toLowerCase().includes("not initialized")) { … }
   * ```
   */
  async getConfigResult(): Promise<ReadResult<CircleConfig>> {
    try {
      const value = await this.getConfig();
      return { ok: true, value };
    } catch (err: any) {
      const raw: string = err?.message ?? "getConfig failed";
      // Normalise the ContractError::NotInitialized code (1) into a clear,
      // consistent message so callers can detect the absent-config case with
      // a simple string check rather than parsing opaque error codes.
      const normalised = normalizeNotInitializedError(raw);
      return { ok: false, error: normalised };
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
    try {
      const raw = await this.simulateAndReadOrThrow(
        this.circleAddress,
        "get_current_round",
        [],
      );
      return mapRawRoundState(raw);
    } catch (err: any) {
      const raw: string = err?.message ?? "getCurrentRound failed";
      throw new Error(normalizeCircleNotActiveError(raw));
    }
  }

  /**
   * Non-throwing variant of {@link getCurrentRound}.
   *
   * This is the preferred method for UI components that need to handle
   * `Completed` and `Cancelled` circles gracefully — the contract returns
   * `ContractError::CircleNotActive` (code 2) for those states, which surfaces
   * here as `{ ok: false, error: "…" }` rather than an uncaught exception.
   *
   * Use {@link isCircleNotActive} on the error string to distinguish the
   * "circle is in a terminal state" case from a genuine network or decode
   * error, without parsing arbitrary error messages:
   *
   * ```ts
   * const r = await client.getCurrentRoundResult();
   * if (r.ok) {
   *   showRoundProgress(r.value);
   * } else if (isCircleNotActive(r.error)) {
   *   showHistory(); // circle is Completed or Cancelled — show history instead
   * } else {
   *   showNetworkError(r.error); // transient RPC/decode failure
   * }
   * ```
   */
  async getCurrentRoundResult(): Promise<ReadResult<RoundState>> {
    try {
      const value = await this.getCurrentRound();
      return { ok: true, value };
    } catch (err: any) {
      const raw: string = err?.message ?? "getCurrentRound failed";
      // Normalise ContractError::CircleNotActive (code 2) into a clear,
      // consistent message so callers can detect the inactive-circle case
      // with a simple string check rather than parsing opaque error codes.
      const normalised = normalizeCircleNotActiveError(raw);
      return { ok: false, error: normalised };
    }
  }

  async getCollateral(member: string): Promise<bigint> {
    const raw = await this.simulateAndReadOrThrow(
      this.circleAddress,
      "get_collateral",
      [scAddress(member)],
    );
    // i128 on the wire; the contract clamps penalty deductions at zero.
    return decodeI128(raw, "getCollateral", { min: 0n });
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
    //
    // Config absence (ContractError::NotInitialized) is a legitimate state for
    // a freshly deployed circle that hasn't been initialized by the factory yet.
    // We fetch config via the non-throwing variant and re-throw only when the
    // error is NOT the not-initialized case, so getFullState never crashes a
    // UI render cycle for a valid but un-configured circle address.
    const [configResult, status] = await Promise.all([
      this.getConfigResult(),
      this.getStatus(),
    ]);

    if (!configResult.ok) {
      // Re-throw with a clear message. Callers that want non-throwing behaviour
      // should use getConfigResult() directly; getFullState throwing here
      // preserves the contract that it either returns a complete state or throws.
      throw new Error(
        `Failed to load circle config for ${this.circleAddress}: ${configResult.error}`,
      );
    }

    const config = configResult.value;

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
// All methods throw a descriptive `IndexerError` on any failure so callers
// always get an actionable message rather than a generic TypeError from a
// failed JSON parse. `IndexerError.kind` separates the failure categories:
//
//   network  — fetch() rejected (DNS, connection refused, CORS, …)
//   timeout  — no complete response within the request budget
//              (DEFAULT_INDEXER_TIMEOUT_MS unless overridden)
//   aborted  — the caller's AbortSignal fired
//   http     — the indexer answered with a non-2xx status
//   json     — a 2xx response whose body is not valid JSON
//   schema   — valid JSON whose envelope does not match the endpoint contract
//
// These are deliberately distinct from Soroban RPC failures (`withRpcRetry`,
// `PollConfig`): the indexer is a plain HTTP read path and is never retried
// automatically. Error messages never embed the full response body — at most
// the indexer's short `error` string, truncated.

/**
 * Default upper bound, in milliseconds, for a single indexer request
 * (connect + headers + body). Override per client via
 * {@link IndexerClientOptions.timeoutMs} or per call via
 * {@link IndexerRequestOptions.timeoutMs}.
 */
// DEFAULT_INDEXER_TIMEOUT_MS is re-exported from circleUpClient.ts via the import above.

/** Longest indexer-supplied `error` string echoed into an IndexerError message. */
const MAX_ERROR_DETAIL_LENGTH = 200;

/** Failure category of an {@link IndexerError}; see the section comment above. */
export type IndexerErrorKind =
  | "network"
  | "timeout"
  | "aborted"
  | "http"
  | "json"
  | "schema";

/** Thrown by {@link IndexerClient} on any failed request. */
export class IndexerError extends Error {
  /** HTTP status code, or 0 when no HTTP response was received. */
  readonly status: number;
  /** The URL that was requested. */
  readonly url: string;
  /** Failure category — branch on this rather than parsing `message`. */
  readonly kind: IndexerErrorKind;
  /**
   * `true` when retrying the same request later may succeed: network
   * failures, timeouts, HTTP 429 and 5xx. Caller aborts, 4xx, and malformed
   * payloads are not retryable.
   */
  readonly retryable: boolean;

  constructor(message: string, status: number, url: string, kind?: IndexerErrorKind) {
    super(message);
    this.name = "IndexerError";
    this.status = status;
    this.url = url;
    this.kind = kind ?? (status === 0 ? "network" : "http");
    this.retryable =
      this.kind === "network" ||
      this.kind === "timeout" ||
      (this.kind === "http" && (status === 429 || status >= 500));
  }
}

/** Client-wide options for {@link IndexerClient}. */
export interface IndexerClientOptions {
  /**
   * Upper bound in milliseconds for each request, including reading the body.
   * @default DEFAULT_INDEXER_TIMEOUT_MS (10 000)
   */
  timeoutMs?: number;
}

/** Per-call options accepted by every {@link IndexerClient} read method. */
export interface IndexerRequestOptions {
  /** Random UUIDv4 for correlating this read; never authentication. */
  requestId?: string;
  /** Receives the sanitized server correlation identifier, including on HTTP errors. */
  onRequestId?: (requestId: string) => void;
  /**
   * Caller cancellation. When it fires the request is abandoned and the
   * method rejects with an {@link IndexerError} of kind `"aborted"`.
   */
  signal?: AbortSignal;
  /** Overrides the client's timeout for this call only. */
  timeoutMs?: number;
}

/**
 * Minimal envelope contract for one endpoint: top-level keys the SDK relies
 * on and their JSON container type. Deeper field validation lives in
 * indexerSchema.ts and is exercised by the compatibility fixtures; the
 * runtime check stays shallow so additive server changes never break callers.
 */
type EnvelopeSpec = Record<string, "array" | "object" | "string">;

function validateEnvelope(body: unknown, spec: EnvelopeSpec): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return `expected a JSON object, got ${body === null ? "null" : Array.isArray(body) ? "array" : typeof body}`;
  }
  const record = body as Record<string, unknown>;
  for (const [key, type] of Object.entries(spec)) {
    const value = record[key];
    const ok =
      type === "array"
        ? Array.isArray(value)
        : type === "object"
          ? value !== null && typeof value === "object" && !Array.isArray(value)
          : typeof value === type;
    if (!ok) return type === "array" ? `"${key}" is not an array` : `field "${key}" must be a ${type}`;
  }
  return null;
}

function assertPositiveTimeout(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`IndexerClient: ${label} must be a positive, finite number of milliseconds.`);
  }
}

// ── Indexer query validation ─────────────────────────────────────────────────
//
// Mirrors the parsers in indexer/src/api.ts so a bad option fails locally,
// naming the field, instead of costing a round-trip for an HTTP 400 — and so an
// unrecognised key (a typo such as `pageSize`) is rejected rather than dropped.

const CIRCLE_STATUS_FILTERS: readonly ApiCircleStatus[] = [
  "Pending",
  "Active",
  "Completed",
  "Cancelled",
  "Closed",
];
const CIRCLE_SORT_FIELDS: readonly CircleSortField[] = [
  "created_ledger",
  "updated_at",
  "round_amount",
  "member_count",
  "status",
];
const DEFAULT_MAX_PAGES = 10;
const MAX_PAGES_LIMIT = 1_000;

/** Collects every problem with one options object, then throws them together. */
class QueryProblems {
  private readonly problems: string[] = [];

  constructor(private readonly method: string) {}

  /** Narrow `value` to a plain options object, or record why it is not one. */
  options(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) {
      this.problems.push(`options must be an object, got ${describeOption(value)}.`);
      return {};
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.problems.push(
          `unknown option "${key}" (supported: ${allowed.join(", ")}). ` +
            `It would not be sent to the indexer.`,
        );
      }
    }
    return value as Record<string, unknown>;
  }

  /** Record a problem unless `value` is `undefined` or a whole number in range. */
  integer(field: string, value: unknown, min: number, max: number): void {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      this.problems.push(
        `${field} must be an integer between ${min} and ${max}, got ${describeOption(value)}.`,
      );
    }
  }

  /** Record a problem unless `value` is `undefined` or one of `allowed`. */
  oneOf(field: string, value: unknown, allowed: readonly string[]): void {
    if (value === undefined) return;
    if (typeof value !== "string" || !allowed.includes(value)) {
      this.problems.push(
        `${field} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}, got ${describeOption(value)}.`,
      );
    }
  }

  /** Record a free-form problem. */
  add(problem: string): void {
    this.problems.push(problem);
  }

  /** @throws `RangeError` listing every recorded problem. */
  throwIfAny(): void {
    if (this.problems.length > 0) {
      throw new RangeError(
        `${this.method}: invalid options:\n${this.problems.map((p) => `  • ${p}`).join("\n")}`,
      );
    }
  }
}

function describeOption(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Serialise `entries` (skipping `undefined`) into a `?a=b` suffix, or `""`. */
function toQuery(entries: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Validate {@link GetCirclesParams} and build the `GET /circles` query. */
function buildCirclesQuery(
  method: string,
  params: GetCirclesParams | undefined,
): { query: string; page: number; limit?: number } {
  const check = new QueryProblems(method);
  const p = check.options(params, ["status", "sort", "order", "page", "limit"]);
  check.oneOf("status", p.status, CIRCLE_STATUS_FILTERS);
  check.oneOf("sort", p.sort, CIRCLE_SORT_FIELDS);
  check.oneOf("order", p.order, ["asc", "desc"]);
  check.integer("page", p.page, 1, Number.MAX_SAFE_INTEGER);
  check.integer("limit", p.limit, 1, INDEXER_MAX_PAGE_SIZE);
  check.throwIfAny();

  const page = (p.page as number | undefined) ?? 1;
  const limit = p.limit as number | undefined;
  return {
    query: toQuery({
      status: p.status as string | undefined,
      sort: p.sort as string | undefined,
      order: p.order as string | undefined,
      page: p.page as number | undefined,
      limit,
    }),
    page,
    limit,
  };
}

/** Validate {@link GetMemberContributionsParams} and build its query. */
function buildContributionsQuery(
  method: string,
  options: GetMemberContributionsParams | undefined,
): { query: string; page: number; limit?: number } {
  const check = new QueryProblems(method);
  const o = check.options(options, ["circle", "page", "limit"]);
  if (o.circle !== undefined && !isValidStellarAddress(o.circle)) {
    check.add(
      `circle must be a Stellar address (G… or C…, 56 characters), got ${describeOption(o.circle)}.`,
    );
  }
  check.integer("page", o.page, 1, Math.floor(Number.MAX_SAFE_INTEGER / INDEXER_MAX_PAGE_SIZE));
  check.integer("limit", o.limit, 1, INDEXER_MAX_PAGE_SIZE);
  check.throwIfAny();

  const page = (o.page as number | undefined) ?? 1;
  const limit = o.limit as number | undefined;
  return {
    query: toQuery({
      circle: o.circle as string | undefined,
      page: o.page as number | undefined,
      limit,
    }),
    page,
    limit,
  };
}

/** Validate {@link PaginateOptions} and return the effective page bound. */
function resolveMaxPages(method: string, options: PaginateOptions | undefined): number {
  const check = new QueryProblems(method);
  const o = check.options(options, ["maxPages"]);
  check.integer("maxPages", o.maxPages, 1, MAX_PAGES_LIMIT);
  check.throwIfAny();
  return (o.maxPages as number | undefined) ?? DEFAULT_MAX_PAGES;
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
  private timeoutMs: number;

  /**
   * @param config  SDK config. `indexerUrl` is required — construction throws
   *                immediately if it is missing so the error surfaces at setup
   *                time rather than at the first API call.
   * @param options Optional transport settings (request timeout).
   */
  constructor(config: CircleUpConfig, options?: IndexerClientOptions) {
    if (!config.indexerUrl || config.indexerUrl.trim() === "") {
      throw new Error(
        "IndexerClient requires config.indexerUrl to be set. " +
        "Add the indexer base URL (e.g. 'http://localhost:3001') to your CircleUpConfig.",
      );
    }
    // Reject a value fetch() cannot use as a base. "localhost:3001" (no scheme)
    // parses as the `localhost:` protocol, and a bare host is relative in a
    // browser, so either would only fail later as a misleading "network error"
    // or a 404 from the wrong server. Mirrors validateCircleUpConfig.
    let parsed: URL | null = null;
    try {
      parsed = new URL(config.indexerUrl.trim());
    } catch {
      parsed = null;
    }
    if (
      parsed === null ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error(
        `IndexerClient: config.indexerUrl "${config.indexerUrl}" is not a valid absolute ` +
        "HTTP(S) URL without a query string or fragment (e.g. 'http://localhost:3001').",
      );
    }
    // Strip trailing slash so path concatenation is consistent
    this.baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;

    this.timeoutMs = options?.timeoutMs ?? DEFAULT_INDEXER_TIMEOUT_MS;
    assertPositiveTimeout(this.timeoutMs, "options.timeoutMs");
  }

  // ── Internal fetch wrapper ────────────────────────────────────────────────

  /**
   * Fetch `path` from the indexer, parse the JSON response, check its
   * envelope against `spec`, and return the typed body.
   *
   * The whole exchange (connect, headers, body) is bounded by the request
   * timeout and by the caller's `signal`. Throws {@link IndexerError} with a
   * distinct `kind` for each failure category.
   */
  private async get<T>(
    path: string,
    spec: EnvelopeSpec,
    options?: IndexerRequestOptions,
  ): Promise<T> {
    const { body, status, url } = await this.request<T>(path, options);
    const invalid = validateEnvelope(body, spec);
    if (invalid) {
      throw new IndexerError(
        `Indexer response from ${url} has an invalid envelope: ${invalid}.`,
        status,
        url,
        "schema",
      );
    }
    return body;
  }

  /**
   * Fetch one page from a paged list endpoint and check its envelope: the
   * item list must be an array no longer than the page size, and the
   * pagination metadata must be present, well-formed, and match the page (and
   * explicit limit) that was requested.
   *
   * @throws {@link IndexerError} when the envelope is missing or disagrees with
   *   the request — e.g. a proxy that dropped the query string and served page
   *   1 in place of page 3.
   */
  private async getPage<T extends { pagination: IndexerPagination }>(
    path: string,
    itemsKey: keyof T & string,
    requested: { page: number; limit?: number },
    options?: IndexerRequestOptions,
  ): Promise<T> {
    const { body, status, url } = await this.request<T>(path, options);
    const fail = (problem: string): never => {
      throw new IndexerError(
        `Indexer response from ${url} has an invalid page envelope: ${problem}`,
        status,
        url,
        "schema",
      );
    };

    if (body === null || typeof body !== "object") fail("the body is not an object.");
    const items = (body as Record<string, unknown>)[itemsKey];
    if (!Array.isArray(items)) fail(`"${itemsKey}" is not an array.`);

    const p = (body as { pagination?: unknown }).pagination as
      | Record<string, unknown>
      | undefined;
    if (p === null || typeof p !== "object") fail(`"pagination" metadata is missing.`);
    const isCount = (v: unknown, min: number) =>
      typeof v === "number" && Number.isInteger(v) && v >= min;
    const bad = [
      !isCount(p!.page, 1) && "page",
      !isCount(p!.limit, 1) && "limit",
      !isCount(p!.total, 0) && "total",
      !isCount(p!.totalPages, 0) && "totalPages",
      p!.hasMore !== undefined && typeof p!.hasMore !== "boolean" && "hasMore",
    ].filter(Boolean);
    if (bad.length > 0) fail(`pagination field(s) ${bad.join(", ")} are malformed.`);

    const pagination = p as unknown as IndexerPagination;
    if (pagination.page !== requested.page) {
      fail(`requested page ${requested.page} but the server returned page ${pagination.page}.`);
    }
    if (requested.limit !== undefined && pagination.limit !== requested.limit) {
      fail(`requested limit ${requested.limit} but the server applied ${pagination.limit}.`);
    }
    if ((items as unknown[]).length > pagination.limit) {
      fail(`${(items as unknown[]).length} rows exceed the page limit of ${pagination.limit}.`);
    }
    return body;
  }

  /**
   * Walk pages starting at `startPage`, yielding each page response intact
   * (rows plus metadata), until the server reports no further pages, returns
   * an empty page, or `maxPages` pages have been fetched.
   */
  private async *paginate<T extends { pagination: IndexerPagination }>(
    method: string,
    startPage: number,
    options: PaginateOptions | undefined,
    itemsOf: (page: T) => readonly unknown[],
    fetchPage: (page: number) => Promise<T>,
  ): AsyncGenerator<T, void, undefined> {
    const maxPages = resolveMaxPages(method, options);
    for (let page = startPage, fetched = 0; fetched < maxPages; page++, fetched++) {
      const response = await fetchPage(page);
      yield response;
      const { totalPages, hasMore } = response.pagination;
      if (hasMore === false || page >= totalPages || itemsOf(response).length === 0) return;
    }
  }

  /** Fetch `path` and return the parsed body with the status and URL it came from. */
  private async request<T>(
    path: string,
    options?: IndexerRequestOptions,
  ): Promise<{ body: T; status: number; url: string }> {
    const url = `${this.baseUrl}${path}`;
    const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (options?.requestId !== undefined && !idPattern.test(options.requestId)) throw new RangeError("requestId must be a random UUIDv4");
    const requestId = options?.requestId ?? globalThis.crypto?.randomUUID?.();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    assertPositiveTimeout(timeoutMs, "timeoutMs");

    const callerSignal = options?.signal;
    if (callerSignal?.aborted) {
      throw new IndexerError(`Indexer request to ${url} was aborted by the caller.`, 0, url, "aborted");
    }

    // One controller aborts the underlying fetch for both the timeout and the
    // caller's signal; `failure` records which one fired so the error kind is
    // accurate, and the race below guarantees the promise settles even if the
    // fetch implementation ignores the signal.
    const controller = new AbortController();
    let failure = null as IndexerError | null;
    let rejectPending: (err: IndexerError) => void = () => {};
    const pending = new Promise<never>((_resolve, reject) => {
      rejectPending = reject;
    });
    const fail = (err: IndexerError) => {
      if (failure) return;
      failure = err;
      controller.abort();
      rejectPending(err);
    };
    // Prevent an unhandled rejection if the race below has already settled.
    pending.catch(() => {});

    const timer = setTimeout(
      () =>
        fail(
          new IndexerError(
            `Indexer request to ${url} timed out after ${timeoutMs} ms.`,
            0,
            url,
            "timeout",
          ),
        ),
      timeoutMs,
    );
    const onCallerAbort = () =>
      fail(new IndexerError(`Indexer request to ${url} was aborted by the caller.`, 0, url, "aborted"));
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const bounded = <R>(promise: Promise<R>): Promise<R> => Promise.race([promise, pending]);

    try {
      let response: Response;
      try {
        response = await bounded(fetch(url, { signal: controller.signal, headers: requestId ? { "X-Request-ID": requestId } : undefined }));
      } catch (err: any) {
        if (failure) throw failure;
        throw new IndexerError(
          `Network error reaching the indexer at ${url}: ${err?.message ?? "fetch failed"}. ` +
          "Check that the indexer is running and that config.indexerUrl is correct.",
          0,
          url,
          "network",
        );
      }

      const returnedId = response.headers?.get("x-request-id");
      if (returnedId && idPattern.test(returnedId)) {
        try { options?.onRequestId?.(returnedId.toLowerCase()); } catch { /* Diagnostics must not fail reads. */ }
      }
      let body: T;
      try {
        body = (await bounded(response.json())) as T;
      } catch (err) {
        if (failure) throw failure;
        if (!response.ok) {
          throw new IndexerError(
            `Indexer returned HTTP ${response.status} for ${url}.`,
            response.status,
            url,
            "http",
          );
        }
        throw new IndexerError(
          `Indexer response from ${url} was not valid JSON.`,
          response.status,
          url,
          "json",
        );
      }
      if (!response.ok) {
        const detail =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error.slice(0, MAX_ERROR_DETAIL_LENGTH)
            : body && typeof body === "object" && "error" in body && body.error !== null && typeof body.error === "object" && "message" in body.error && typeof body.error.message === "string"
              ? body.error.message.slice(0, MAX_ERROR_DETAIL_LENGTH)
              : `HTTP ${response.status}`;
        throw new IndexerError(
          `Indexer returned HTTP ${response.status}: ${detail}`,
          response.status,
          url,
          "http",
        );
      }
      return { body, status: response.status, url };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Fetch **one page** of circles known to the indexer, ordered newest first
   * by default. The response keeps the server's `pagination` metadata; use
   * `pagination.totalPages` to request further pages, or
   * {@link iterateCircles} to walk them.
   *
   * All parameters are optional — omitting them returns page 1 (20 rows) of
   * all circles sorted by `created_ledger DESC`.
   *
   * @example
   * // All circles, default pagination
   * const { circles, pagination } = await indexer.getCircles();
   *
   * // Only Active circles, sorted by round amount ascending
   * const { circles } = await indexer.getCircles({ status: "Active", sort: "round_amount", order: "asc" });
   *
   * // Page 2 of Pending circles
   * const { circles, pagination } = await indexer.getCircles({ status: "Pending", page: 2 });
   *
   * Equivalent to `GET /circles` with optional query parameters.
   *
   * @throws `RangeError` before any request when `params` holds an unknown key
   *   or a value the indexer does not accept (see {@link GetCirclesParams}).
   * @throws {@link IndexerError} on an HTTP/network failure, or when the
   *   response's page envelope is missing or does not match the request.
   */
  async getCircles(
    params?: GetCirclesParams,
    options?: IndexerRequestOptions,
  ): Promise<ApiCirclesListResponse> {
    const { query, page, limit } = buildCirclesQuery("getCircles", params);
    return this.getPage<ApiCirclesListResponse>(
      `/circles${query}`,
      "circles",
      { page, limit },
      options,
    );
  }

  /**
   * Walk the pages of `GET /circles`, yielding each page response (rows plus
   * `pagination` metadata) in order, starting at `params.page` (default 1).
   *
   * Bounded: stops after `options.maxPages` pages (default 10, max 1000), so it
   * never fetches an unbounded result set. Compare the last page's
   * `pagination.page` with `pagination.totalPages` to tell whether the bound
   * cut the walk short.
   *
   * @example
   * for await (const { circles } of indexer.iterateCircles({ status: "Active", limit: 100 })) {
   *   render(circles);
   * }
   *
   * @throws `RangeError` before any request on invalid `params` or `options`.
   * @throws {@link IndexerError} as {@link getCircles}.
   */
  iterateCircles(
    params?: GetCirclesParams,
    options?: PaginateOptions,
  ): AsyncGenerator<ApiCirclesListResponse, void, undefined> {
    const { page } = buildCirclesQuery("iterateCircles", params);
    resolveMaxPages("iterateCircles", options);
    return this.paginate(
      "iterateCircles",
      page,
      options,
      (r) => r.circles,
      (p) => this.getCircles({ ...params, page: p }),
    );
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
  async getCircleDetail(
    address: string,
    options?: IndexerRequestOptions,
  ): Promise<ApiCircleDetailResponse> {
    return this.get<ApiCircleDetailResponse>(
      `/circles/${encodeURIComponent(address)}`,
      { circle: "object", members: "array" },
      options,
    );
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
  async getMembers(address: string, options?: IndexerRequestOptions): Promise<ApiMembersResponse> {
    return this.get<ApiMembersResponse>(
      `/circles/${encodeURIComponent(address)}/members`,
      { members: "array" },
      options,
    );
  }

  /**
   * Fetch a bounded complete grouped view (100 source records per kind).
   * Oversized histories return HTTP 413; use getCircleHistory to page all records.
   * Includes completed payouts, the in-progress round,
   * open rounds, and pending defaults.
   *
   * Every round row includes a `status` field (`"completed"`, `"current"`,
   * `"cancelled"`, or `"open"`) so callers can branch on lifecycle phase
   * without inferring it from the presence or absence of payout fields
   * (issue #529).
   *
   * `pendingDefaults` contains defaults that have been recorded but belong to
   * a round that has not yet been paid out.
   *
   * Equivalent to `GET /circles/:address/rounds`.
   *
   * @param address On-chain contract address of the circle.
   */
  async getRounds(address: string, options?: IndexerRequestOptions): Promise<ApiRoundsResponse> {
    return this.get<ApiRoundsResponse>(
      `/circles/${encodeURIComponent(address)}/rounds`,
      { rounds: "array", pendingDefaults: "array" },
      options,
    );
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
  async getReputation(
    member: string,
    options?: IndexerRequestOptions & GetMemberContributionsParams,
  ): Promise<ApiReputationResponse> {
    return this.get<ApiReputationResponse>(
      `/reputation/${encodeURIComponent(member)}${buildContributionsQuery("getReputation", options ? { page: options.page, limit: options.limit, circle: options.circle } : undefined).query}`,
      { contributions: "array", defaults: "array" },
      options,
    );
  }

  /**
   * Fetch **one page** of a member's raw contribution history, newest first.
   *
   * Unlike {@link getReputation} (counts only) or {@link getRounds} (nested
   * under payouts), this returns indexed contribution rows for building a
   * personal history view. The response keeps the server's `pagination`
   * metadata and `totalAmount` (summed over all pages); use
   * {@link iterateMemberContributions} to walk the pages.
   *
   * Pass `circle` to restrict results to one circle. An unknown circle address
   * yields a 404; a member with no contributions yields an empty list.
   *
   * Equivalent to `GET /members/:member/contributions`.
   *
   * @param member Stellar public key of the member.
   * @param options Optional circle filter and pagination.
   * @throws `RangeError` before any request on an unknown option key, a
   *   `circle` that is not a Stellar address, or an invalid `page` / `limit`.
   * @throws {@link IndexerError} on an HTTP/network failure, or when the
   *   response's page envelope is missing or does not match the request.
   */
  async getMemberContributions(
    member: string,
    options?: GetMemberContributionsParams,
    requestOptions?: IndexerRequestOptions,
  ): Promise<ApiMemberContributionsResponse> {
    const { query, page, limit } = buildContributionsQuery("getMemberContributions", options);
    return this.getPage<ApiMemberContributionsResponse>(
      `/members/${encodeURIComponent(member)}/contributions${query}`,
      "contributions",
      { page, limit },
      requestOptions,
    );
  }

  /**
   * Walk the pages of a member's contribution history, yielding each page
   * response (rows plus metadata) in order, starting at `options.page`
   * (default 1).
   *
   * Bounded: stops after `paginate.maxPages` pages (default 10, max 1000).
   *
   * @throws `RangeError` before any request on invalid options.
   * @throws {@link IndexerError} as {@link getMemberContributions}.
   */
  iterateMemberContributions(
    member: string,
    options?: GetMemberContributionsParams,
    paginate?: PaginateOptions,
  ): AsyncGenerator<ApiMemberContributionsResponse, void, undefined> {
    const { page } = buildContributionsQuery("iterateMemberContributions", options);
    resolveMaxPages("iterateMemberContributions", paginate);
    return this.paginate(
      "iterateMemberContributions",
      page,
      paginate,
      (r) => r.contributions,
      (p) => this.getMemberContributions(member, { ...options, page: p }),
    );
  }

  /** Fetch one bounded page of complete flat circle history. */
  async getCircleHistory(
    address: string,
    params?: Pick<GetMemberContributionsParams, "page" | "limit">,
    options?: IndexerRequestOptions,
  ): Promise<import("./types").ApiCircleHistoryResponse> {
    const { query, page, limit } = buildContributionsQuery("getCircleHistory", params);
    return this.getPage<import("./types").ApiCircleHistoryResponse>(
      `/circles/${encodeURIComponent(address)}/history${query}`, "events", { page, limit }, options,
    );
  }

  /**
   * Fetch structured audit records for a circle's terminal lifecycle transitions
   * (`cancelled` and `closed`).
   *
   * Unlike the summarised status row in {@link getCircleDetail}, the audit
   * records carry the full event payload: who triggered the transition, amounts
   * released, penalties forfeited, and the on-chain ledger sequence — providing
   * a durable, queryable audit trail without replaying the full event log.
   *
   * Returns `{ events: [] }` (not a 404) when no audit records exist yet — this
   * is normal for circles that have not reached a terminal state, or during a
   * brief indexer lag after the on-chain event fires.
   *
   * Use `total_expected_collateral - total_released` on a `"closed"` row to
   * compute the total collateral forfeited to penalties:
   * ```ts
   * const [closed] = resp.events.filter(e => e.event_type === "closed");
   * const forfeited = BigInt(closed.total_expected_collateral ?? "0")
   *                 - BigInt(closed.total_released ?? "0");
   * ```
   *
   * Equivalent to `GET /circles/:address/audit`.
   *
   * @param address On-chain contract address of the circle.
   */
  async getCircleAuditEvents(
    address: string,
    options?: IndexerRequestOptions & Pick<GetMemberContributionsParams, "page" | "limit">,
  ): Promise<ApiAuditEventsResponse> {
    return this.get<ApiAuditEventsResponse>(
      `/circles/${encodeURIComponent(address)}/audit${buildContributionsQuery("getCircleAuditEvents", options ? { page: options.page, limit: options.limit } : undefined).query}`,
      { events: "array" },
      options,
    );
  }

  /**
   * Check whether the indexer is reachable and up to date.
   *
   * Equivalent to `GET /health`.
   *
   * @throws {@link IndexerError} if the indexer is unreachable.
   */
  async health(options?: IndexerRequestOptions): Promise<ApiHealthResponse> {
    return this.get<ApiHealthResponse>("/health", { status: "string" }, options);
  }
}