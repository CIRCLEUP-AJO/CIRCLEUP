// ─── SDK Types ────────────────────────────────────────────────────────────────

export type NetworkPassphrase =
  | "Test SDF Network ; September 2015"
  | "Public Global Stellar Network ; September 2015";

export interface CircleUpConfig {
  /** Stellar RPC endpoint */
  rpcUrl: string;
  networkPassphrase: NetworkPassphrase;
  /** Deployed contract addresses */
  contracts: {
    circleFactory: string;
    reputation: string;
    usdc: string;
  };
  /**
   * Base URL of the CircleUp indexer REST API (e.g. "http://localhost:3001").
   * Required only when using {@link IndexerClient}. If omitted, IndexerClient
   * construction will throw so the misconfiguration is caught early.
   */
  indexerUrl?: string;
}

// ─── Config validation ────────────────────────────────────────────────────────

/** Regex for a Stellar/Soroban contract address: starts with C, 56 chars total. */
const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

/** Returns true when `addr` looks like a valid Soroban contract address. */
export function isValidContractAddress(addr: string): boolean {
  return CONTRACT_ADDRESS_RE.test(addr);
}

/**
 * Validate a `CircleUpConfig` object and throw a descriptive `Error` listing
 * every problem found.  Called automatically by `CircleUpClient` in its
 * constructor so misconfiguration surfaces immediately instead of producing
 * a cryptic RPC error on the first call.
 *
 * @throws `Error` with a human-readable summary of all validation failures.
 */
export function validateCircleUpConfig(config: unknown): asserts config is CircleUpConfig {
  const errors: string[] = [];

  if (!config || typeof config !== "object") {
    throw new Error("CircleUpConfig must be a non-null object.");
  }

  const cfg = config as Record<string, unknown>;

  // rpcUrl
  if (!cfg.rpcUrl || typeof cfg.rpcUrl !== "string") {
    errors.push('config.rpcUrl is required and must be a string (e.g. "https://soroban-testnet.stellar.org").');
  } else if (!/^https?:\/\/.+/.test(cfg.rpcUrl)) {
    errors.push(`config.rpcUrl "${cfg.rpcUrl}" does not look like a valid URL.`);
  }

  // networkPassphrase
  const validPassphrases: NetworkPassphrase[] = [
    "Test SDF Network ; September 2015",
    "Public Global Stellar Network ; September 2015",
  ];
  if (!cfg.networkPassphrase || typeof cfg.networkPassphrase !== "string") {
    errors.push("config.networkPassphrase is required. Use TESTNET_PASSPHRASE or MAINNET_PASSPHRASE from @circleup/sdk.");
  } else if (!validPassphrases.includes(cfg.networkPassphrase as NetworkPassphrase)) {
    errors.push(
      `config.networkPassphrase "${cfg.networkPassphrase}" is not recognised. ` +
        `Expected one of: ${validPassphrases.map((p) => `"${p}"`).join(", ")}.`,
    );
  }

  // contracts block
  if (!cfg.contracts || typeof cfg.contracts !== "object") {
    errors.push("config.contracts is required and must be an object with circleFactory, reputation, and usdc addresses.");
  } else {
    const contracts = cfg.contracts as Record<string, unknown>;
    for (const key of ["circleFactory", "reputation", "usdc"] as const) {
      const addr = contracts[key];
      if (!addr || typeof addr !== "string") {
        errors.push(`config.contracts.${key} is required.`);
      } else if (!isValidContractAddress(addr)) {
        errors.push(
          `config.contracts.${key} "${addr}" does not look like a valid Soroban contract address ` +
            `(expected a 56-character string starting with "C").`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid CircleUpConfig:\n${errors.map((e) => `  • ${e}`).join("\n")}`,
    );
  }
}

// ── Raw wire types returned by scValToNative from Soroban simulation ──────────
//
// When `simulateAndRead` decodes a Soroban return value via `scValToNative` the
// result is a plain JS object whose keys mirror the Rust snake_case field names
// and whose numeric values are either `number` or `bigint` depending on the
// Soroban XDR type.  These types make the `simulateAndRead` call-site explicit
// and safe — no more `as any` or property-access guesswork.
//
// They are intentionally *not* exported as part of the public SDK surface (they
// are implementation details of the mapping layer), but exporting them here
// lets the test suite assert the mapping logic without re-importing from client.

/**
 * Raw scValToNative shape for `CircleConfig` (Rust: `CircleConfig` struct).
 *
 * Field mapping:
 *   members                → string[]  (Stellar address strings)
 *   round_amount           → bigint    (i128 in XDR)
 *   usdc_token             → string
 *   reputation_contract    → string
 *   round_deadline_ledgers → number    (u32 in XDR)
 */
export interface RawCircleConfig {
  members: string[];
  round_amount: bigint;
  usdc_token: string;
  reputation_contract: string;
  round_deadline_ledgers: number;
}

/**
 * Raw scValToNative shape for `RoundState` (Rust: `RoundState` struct).
 *
 * Field mapping:
 *   round_index            → number   (u32)
 *   recipient              → string   (Stellar address)
 *   contributions_received → number   (u32)
 *   deadline_ledger        → bigint   (u64)
 *   paid_out               → boolean
 */
export interface RawRoundState {
  round_index: number;
  recipient: string;
  contributions_received: number;
  deadline_ledger: bigint;
  paid_out: boolean;
}

// ── Circle state types (mirrors contract structs) ─────────────────────────────

export type CircleStatus = "Pending" | "Active" | "Completed" | "Cancelled";

export interface CircleConfig {
  members: string[];
  roundAmount: bigint;       // in stroops (1 USDC = 10_000_000n)
  usdcToken: string;
  reputationContract: string;
  roundDeadlineLedgers: number;
}

export interface RoundState {
  roundIndex: number;
  recipient: string;
  contributionsReceived: number;
  deadlineLedger: bigint;
  paidOut: boolean;
}

export interface CircleState {
  address: string;
  config: CircleConfig;
  status: CircleStatus;
  currentRound: RoundState;
}

export interface MemberState {
  address: string;
  collateral: bigint;
  defaults: number;
  reputationScore: number;
  hasContributedThisRound: boolean;
}

// ─── Read result ─────────────────────────────────────────────────────────────
//
// A discriminated union returned by the *non-throwing* read helpers
// (getConfigResult, getStatusResult, getCurrentRoundResult).
//
// These complement the throwing variants (getConfig, getStatus, getCurrentRound)
// for call-sites that want to handle errors gracefully — e.g. showing a UI
// skeleton while the circle is still Pending — without wrapping every call in
// try/catch.
//
//   const r = await client.getConfigResult();
//   if (r.ok) {
//     render(r.value);          // CircleConfig, fully typed
//   } else {
//     showError(r.error);       // human-readable string
//   }
//
// The throwing helpers delegate to the same underlying simulation; callers that
// only need one style do not pay for the other.

/** A read that returned a decoded value. */
export interface ReadSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

/** A read that failed (network error, simulation error, decode error, …). */
export interface ReadFailure {
  readonly ok: false;
  /** Human-readable description of what went wrong. */
  readonly error: string;
}

/** Discriminated union of possible typed-read outcomes. */
export type ReadResult<T> = ReadSuccess<T> | ReadFailure;

/**
 * Type-guard — narrows `ReadResult<T>` to `ReadSuccess<T>`.
 *
 * @example
 * const r = await client.getConfigResult();
 * if (isReadSuccess(r)) console.log(r.value.roundAmount);
 */
export function isReadSuccess<T>(r: ReadResult<T>): r is ReadSuccess<T> {
  return r.ok === true;
}

/**
 * Type-guard — narrows `ReadResult<T>` to `ReadFailure`.
 *
 * @example
 * const r = await client.getStatusResult();
 * if (isReadFailure(r)) showBanner(r.error);
 */
export function isReadFailure<T>(r: ReadResult<T>): r is ReadFailure {
  return r.ok === false;
}

// ─── Raw → domain mapping helpers ────────────────────────────────────────────
//
// Extracted from the CircleClient method bodies so they can be unit-tested in
// isolation without spinning up a mock RPC server.  The helpers are exported
// so external packages (e.g. app/, indexer/) can reuse the same coercion logic
// rather than duplicating it.

/**
 * Map a raw `scValToNative` wire object to the typed `CircleConfig` domain
 * shape, coercing XDR numeric types as needed.
 *
 * @throws `Error` if `raw` is missing required fields or has wrong types —
 *   surfaces decode bugs at the boundary rather than letting `undefined` leak
 *   into domain code.
 */
export function mapRawConfig(raw: RawCircleConfig): CircleConfig {
  if (!Array.isArray(raw.members)) {
    throw new Error("mapRawConfig: members field is missing or not an array");
  }
  if (raw.round_amount === undefined || raw.round_amount === null) {
    throw new Error("mapRawConfig: round_amount field is missing");
  }
  return {
    members: raw.members,
    roundAmount: BigInt(raw.round_amount),
    usdcToken: raw.usdc_token,
    reputationContract: raw.reputation_contract,
    roundDeadlineLedgers: Number(raw.round_deadline_ledgers),
  };
}

/**
 * Map a raw `scValToNative` wire object to the typed `RoundState` domain shape.
 *
 * @throws `Error` if `raw` is missing required fields.
 */
export function mapRawRoundState(raw: RawRoundState): RoundState {
  if (raw.round_index === undefined || raw.round_index === null) {
    throw new Error("mapRawRoundState: round_index field is missing");
  }
  if (!raw.recipient) {
    throw new Error("mapRawRoundState: recipient field is missing");
  }
  return {
    roundIndex: Number(raw.round_index),
    recipient: raw.recipient,
    contributionsReceived: Number(raw.contributions_received),
    deadlineLedger: BigInt(raw.deadline_ledger),
    paidOut: Boolean(raw.paid_out),
  };
}

/**
 * Validate that a string returned by the contract's `get_status` view is a
 * recognised `CircleStatus` variant.
 *
 * Returns the narrowed type on success; throws a descriptive `Error` on an
 * unrecognised value so SDK consumers are never silently handed a garbage status.
 */
export function assertValidCircleStatus(value: unknown): CircleStatus {
  const valid: CircleStatus[] = ["Pending", "Active", "Completed", "Cancelled"];
  if (typeof value !== "string" || !valid.includes(value as CircleStatus)) {
    throw new Error(
      `assertValidCircleStatus: unexpected value "${String(value)}". ` +
        `Expected one of: ${valid.map((v) => `"${v}"`).join(", ")}.`,
    );
  }
  return value as CircleStatus;
}

// ─── simulateAndRead result ───────────────────────────────────────────────────
//
// A discriminated union returned by the internal `simulateAndRead` helper.
// Using a union here means:
//   1. Callers can never accidentally treat a simulation failure as a valid
//      decoded value — the `ok` flag must be checked before touching `value`.
//   2. The `value` field is typed as `unknown` rather than `any`, forcing
//      every call-site to narrow or explicitly cast, which surfaces
//      mapping errors at compile time rather than silently at runtime.
//   3. Error details (the raw simulation error string) are always available
//      for logging / user-facing messages without a separate try/catch.
//
// Public methods (getConfig, getCurrentRound, …) unwrap this internally and
// either throw a descriptive Error or return the narrowed domain type —
// consumers never see SimulateResult directly.

/** A simulation that returned a decoded return value. */
export interface SimulateSuccess {
  readonly ok: true;
  /** Decoded contract return value. Type is `unknown` — callers must narrow. */
  readonly value: unknown;
}

/** A simulation that produced an error from the Soroban host. */
export interface SimulateFailure {
  readonly ok: false;
  /** Raw error string from the Soroban simulation response. */
  readonly error: string;
}

/** Discriminated union of possible `simulateAndRead` outcomes. */
export type SimulateResult = SimulateSuccess | SimulateFailure;

/**
 * Type-guard — narrows `SimulateResult` to `SimulateSuccess`.
 *
 * @example
 * const result = await simulateAndRead(...);
 * if (isSimulateSuccess(result)) {
 *   const val = result.value as MyExpectedType;
 * }
 */
export function isSimulateSuccess(r: SimulateResult): r is SimulateSuccess {
  return r.ok === true;
}

/**
 * Type-guard — narrows `SimulateResult` to `SimulateFailure`.
 *
 * @example
 * const result = await simulateAndRead(...);
 * if (isSimulateFailure(result)) {
 *   throw new Error(result.error);
 * }
 */
export function isSimulateFailure(r: SimulateResult): r is SimulateFailure {
  return r.ok === false;
}

// ── Tx result ─────────────────────────────────────────────────────────────────
//
// A discriminated union so callers can pattern-match on `success` and get
// correct types in each branch — no need to check for optional fields or cast.
//
//   const result = await client.join(keypair);
//   if (result.success) {
//     console.log(result.txHash, result.ledger);   // ledger is number here
//   } else {
//     console.error(result.errorMessage);          // errorMessage is string here
//   }

/** A transaction that was confirmed on-chain successfully. */
export interface TxSuccess {
  readonly success: true;
  /** The transaction hash on the Stellar network. */
  readonly txHash: string;
  /** The ledger number in which the transaction was included. */
  readonly ledger: number;
}

/**
 * Machine-readable error category for a {@link TxFailure}.
 *
 * | Code | When it fires |
 * |------|---------------|
 * | `"account_not_found"` | The source account does not exist on the network. |
 * | `"simulation_failed"` | The Soroban simulation rejected the invocation (contract panic / validation). |
 * | `"network_error"` | A network-level fetch failure before or during submission. |
 * | `"tx_rejected"` | The transaction was submitted but immediately rejected (`status === "ERROR"`). |
 * | `"tx_failed"` | The transaction was included in a ledger but its status is FAILED. |
 * | `"timeout"` | Confirmation polling exceeded the timeout window. |
 * | `"unknown"` | An unclassified error (should not normally occur). |
 *
 * Use this field to branch on the error type without parsing `errorMessage`
 * strings — e.g. show a wallet-funding prompt on `"account_not_found"` or a
 * "check your inputs" banner on `"simulation_failed"`.
 */
export type TxErrorCode =
  | "account_not_found"
  | "simulation_failed"
  | "network_error"
  | "tx_rejected"
  | "tx_failed"
  | "timeout"
  | "unknown";

/** A transaction that failed to submit, was rejected, or timed out. */
export interface TxFailure {
  readonly success: false;
  /**
   * The transaction hash, if the transaction reached the network before
   * failing. Empty string when the failure occurred before submission (e.g.
   * simulation error or user rejection).
   */
  readonly txHash: string;
  /** Human-readable description of what went wrong. */
  readonly errorMessage: string;
  /**
   * Machine-readable error category.  Use this to branch on error type in
   * UI logic without parsing the `errorMessage` string.
   *
   * @see {@link TxErrorCode} for the full list of codes and their meanings.
   */
  readonly errorCode: TxErrorCode;
}

/** Discriminated union of all possible transaction outcomes. */
export type TxResult = TxSuccess | TxFailure;

/**
 * Type-guard — narrows `TxResult` to `TxSuccess`.
 *
 * @example
 * const res = await circleClient.join(keypair);
 * if (isTxSuccess(res)) {
 *   console.log(`Confirmed in ledger ${res.ledger}`);
 * }
 */
export function isTxSuccess(result: TxResult): result is TxSuccess {
  return result.success === true;
}

/**
 * Type-guard — narrows `TxResult` to `TxFailure`.
 *
 * @example
 * const res = await circleClient.contribute(keypair);
 * if (isTxFailure(res)) {
 *   alert(res.errorMessage);
 * }
 */
export function isTxFailure(result: TxResult): result is TxFailure {
  return result.success === false;
}

// ─── Indexer REST API models ───────────────────────────────────────────────────
//
// These types describe the JSON shapes returned by the CircleUp indexer API.
// They use snake_case field names and string-serialised amounts (stroops) to
// match the database rows directly, unlike the contract types above which use
// camelCase and bigint.
//
// Consumers should convert stroops strings to bigint / display strings via the
// helpers in sdk/src/utils.ts (formatUsdc, stroopsToUsdc, usdcToStroops).

/** The four lifecycle states a circle can be in, as returned by the indexer. */
export type ApiCircleStatus = "Pending" | "Active" | "Completed" | "Cancelled";

/**
 * A single circle row as returned by GET /circles and GET /circles/:address.
 * `round_amount` is in stroops, serialised as a string.
 */
export interface ApiCircleRow {
  address: string;
  creator: string;
  /** Per-member contribution per round, in stroops (string-serialised). */
  round_amount: string;
  member_count: number;
  status: ApiCircleStatus;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
  updated_at: string;
  /**
   * Only present in the single-circle detail response
   * (GET /circles/:address). Computed server-side from created_ledger and
   * round_deadline_ledgers; null when the circle is not Active or when the
   * data is unavailable.
   */
  deadline_ledger?: number | null;
  /** Round deadline window, in ledgers (sourced from the contract config). */
  round_deadline_ledgers?: number | null;
}

/**
 * A member record as returned by GET /circles/:address and
 * GET /circles/:address/members.
 * `collateral` is in stroops (string-serialised).
 */
export interface ApiMemberRow {
  member_address: string;
  payout_order: number;
  /** Locked collateral, in stroops (string-serialised). */
  collateral: string;
  defaults: number;
  joined_at: string | null;
  /** Reputation score aggregated by the reputation contract (0–100). */
  reputation_score: number;
  /**
   * Total number of contributions this member has made across all rounds of
   * this circle. Used to derive whether they have contributed to the current
   * active round.
   */
  total_contributions: number;
}

/**
 * A single contribution record within a round.
 * `amount` is in stroops (string-serialised).
 */
export interface ApiContributionRecord {
  member_address: string;
  /** Contribution amount, in stroops (string-serialised). */
  amount: string;
  tx_hash: string;
}

/**
 * A single default record within a round.
 * `penalty` is in stroops (string-serialised).
 */
export interface ApiDefaultRecord {
  member_address: string;
  /** Penalty deducted from collateral, in stroops (string-serialised). */
  penalty: string;
}

/**
 * A completed payout round as returned by GET /circles/:address/rounds.
 * `amount` is in stroops (string-serialised).
 */
export interface ApiRoundRow {
  roundIndex: number;
  recipient: string;
  /** Pot paid out, in stroops (string-serialised). */
  amount: string;
  txHash: string;
  ledger?: number;
  contributions: ApiContributionRecord[];
  defaults: ApiDefaultRecord[];
}

// ─── Indexer API response envelopes ───────────────────────────────────────────

/** Response body for GET /circles */
export interface ApiCirclesListResponse {
  circles: ApiCircleRow[];
}

/** Response body for GET /circles/:address */
export interface ApiCircleDetailResponse {
  circle: ApiCircleRow;
  members: ApiMemberRow[];
  /** Latest ledger processed by the indexer; used for deadline countdown math. */
  latestLedger: number | null;
}

/** Response body for GET /circles/:address/members */
export interface ApiMembersResponse {
  members: ApiMemberRow[];
}

/** Response body for GET /circles/:address/rounds */
export interface ApiRoundsResponse {
  rounds: ApiRoundRow[];
  /** Defaults that belong to a round not yet paid out. */
  pendingDefaults: ApiDefaultRecord[];
}

/** Response body for GET /reputation/:member */
export interface ApiReputationResponse {
  member: string;
  /**
   * `true` when a reputation row exists for this member in the database.
   * `false` means the member has no recorded activity; `score` will be 0.
   * Lets clients distinguish an explicit zero from a member not yet seen.
   */
  found: boolean;
  score: number;
  contributions: Array<{
    circle_address: string;
    /** Number of rounds the member has contributed in this circle. */
    contributions: number;
    total_rounds: number;
  }>;
  defaults: Array<{
    circle_address: string;
    /** Number of rounds the member has defaulted in this circle. */
    count: number;
  }>;
  updatedAt: string | null;
}

/**
 * A single row from GET /members/:member/contributions.
 * Amounts are in stroops (string-serialised).
 */
export interface ApiMemberContributionRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

/** Response body for GET /members/:member/contributions */
export interface ApiMemberContributionsResponse {
  member: string;
  /** Circle filter applied, or null when returning history across all circles. */
  circle: string | null;
  contributions: ApiMemberContributionRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Response body for GET /health */
export interface ApiHealthResponse {
  status: "ok";
  timestamp: string;
}
