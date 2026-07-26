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
  RoundState,
  CircleStatus,
  MemberState,
  TxResult,
  TxSuccess,
  TxFailure,
  ApiCirclesListResponse,
  ApiCircleDetailResponse,
  ApiMembersResponse,
  ApiRoundsResponse,
  ApiReputationResponse,
  ApiMemberContributionsResponse,
  ApiHealthResponse,
} from "./types";
import { validateCircleUpConfig, isValidContractAddress } from "./types";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Build a typed failure result. */
function txFailure(txHash: string, errorMessage: string): TxFailure {
  return { success: false, txHash, errorMessage };
}

/** Build a typed success result. */
function txSuccess(txHash: string, ledger: number): TxSuccess {
  return { success: true, txHash, ledger };
}

// ─── Base client ─────────────────────────────────────────────────────────────

export class CircleUpClient {
  protected rpc: SorobanRpc.Server;
  protected config: CircleUpConfig;

  constructor(config: CircleUpConfig) {
    // Validate upfront so callers get a clear message for misconfiguration
    // rather than an obscure RPC error on the first method call.
    validateCircleUpConfig(config);
    this.config = config;
    this.rpc = new SorobanRpc.Server(config.rpcUrl, { allowHttp: true });
  }

  // ── Tx helpers ──────────────────────────────────────────────────────────────

  protected async buildAndSend(
    sourceKeypair: Keypair,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<TxResult> {
    let account: Awaited<ReturnType<typeof this.rpc.getAccount>>;
    try {
      account = await this.rpc.getAccount(sourceKeypair.publicKey());
    } catch (err: any) {
      return txFailure("", `Failed to load account: ${err?.message ?? "network error"}`);
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
      return txFailure("", `Simulation network error: ${err?.message ?? "unknown"}`);
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return txFailure("", simResult.error);
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(sourceKeypair);

    let sendResult: Awaited<ReturnType<typeof this.rpc.sendTransaction>>;
    try {
      sendResult = await this.rpc.sendTransaction(preparedTx);
    } catch (err: any) {
      return txFailure("", `Submit network error: ${err?.message ?? "unknown"}`);
    }

    if (sendResult.status === "ERROR") {
      return txFailure(
        sendResult.hash,
        `Transaction rejected by network: ${JSON.stringify(sendResult.errorResult)}`,
      );
    }

    // Poll for confirmation
    const hash = sendResult.hash;
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      let status: Awaited<ReturnType<typeof this.rpc.getTransaction>>;
      try {
        status = await this.rpc.getTransaction(hash);
      } catch {
        // Transient polling error — keep trying until timeout
        continue;
      }

      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return txSuccess(hash, status.ledger);
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        return txFailure(hash, "Transaction was included in a ledger but marked as failed.");
      }
    }

    return txFailure(hash, "Timed out waiting for transaction confirmation. The transaction may still confirm — check Stellar Expert before retrying.");
  }

  protected async simulateAndRead<T>(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<T> {
    const dummyKeypair = Keypair.random();
    // Use a funded testnet account for read-only simulation
    // In production use a fixed funded source
    const account = await this.rpc
      .getAccount(dummyKeypair.publicKey())
      .catch(() => {
        // Create a fake account for simulation
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

    const simResult = await this.rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(simResult.error);
    }
    if (!("result" in simResult) || !simResult.result) {
      throw new Error("no result from simulation");
    }
    return scValToNative(simResult.result.retval) as T;
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
    const membersVal = xdr.ScVal.scvVec(
      params.members.map((m) =>
        new Address(m).toScVal()
      ),
    );

    const result = await this.buildAndSend(
      params.creator,
      this.contractId,
      "create_circle",
      [
        new Address(params.creator.publicKey()).toScVal(),
        membersVal,
        nativeToScVal(params.roundAmountStroops, { type: "i128" }),
        nativeToScVal(params.roundDeadlineLedgers, { type: "u32" }),
      ],
    );

    return { result };
  }

  async getCircles(): Promise<string[]> {
    return this.simulateAndRead<string[]>(
      this.contractId,
      "get_circles",
      [],
    );
  }

  async getCircleCount(): Promise<number> {
    return this.simulateAndRead<number>(
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
   */
  constructor(
    config: CircleUpConfig,
    circleAddress: string,
    cacheTtlMs: number = DEFAULT_FULL_STATE_CACHE_TTL_MS,
  ) {
    super(config);
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
      [new Address(member.publicKey()).toScVal()],
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async contribute(member: Keypair): Promise<TxResult> {
    const result = await this.buildAndSend(
      member,
      this.circleAddress,
      "contribute",
      [new Address(member.publicKey()).toScVal()],
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
      [new Address(member).toScVal()],
    );
    if (result.success) this.invalidateCache();
    return result;
  }

  async close(caller: Keypair): Promise<TxResult> {
    const result = await this.buildAndSend(caller, this.circleAddress, "close", [
      new Address(caller.publicKey()).toScVal(),
    ]);
    if (result.success) this.invalidateCache();
    return result;
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  async getConfig(): Promise<CircleConfig> {
    const raw = await this.simulateAndRead<any>(
      this.circleAddress,
      "get_config",
      [],
    );
    return {
      members: raw.members,
      roundAmount: BigInt(raw.round_amount),
      usdcToken: raw.usdc_token,
      reputationContract: raw.reputation_contract,
      roundDeadlineLedgers: Number(raw.round_deadline_ledgers),
    };
  }

  async getStatus(): Promise<CircleStatus> {
    return this.simulateAndRead<CircleStatus>(
      this.circleAddress,
      "get_status",
      [],
    );
  }

  async getCurrentRound(): Promise<RoundState> {
    const raw = await this.simulateAndRead<any>(
      this.circleAddress,
      "get_current_round",
      [],
    );
    return {
      roundIndex: Number(raw.round_index),
      recipient: raw.recipient,
      contributionsReceived: Number(raw.contributions_received),
      deadlineLedger: BigInt(raw.deadline_ledger),
      paidOut: Boolean(raw.paid_out),
    };
  }

  async getCollateral(member: string): Promise<bigint> {
    return this.simulateAndRead<bigint>(
      this.circleAddress,
      "get_collateral",
      [new Address(member).toScVal()],
    );
  }

  async getDefaults(member: string): Promise<number> {
    return this.simulateAndRead<number>(
      this.circleAddress,
      "get_defaults",
      [new Address(member).toScVal()],
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
    return this.simulateAndRead<boolean>(
      this.circleAddress,
      "has_contributed",
      [
        new Address(member).toScVal(),
        nativeToScVal(roundIndex, { type: "u32" }),
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
    return this.simulateAndRead<number>(
      this.contractId,
      "score",
      [new Address(member).toScVal()],
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
