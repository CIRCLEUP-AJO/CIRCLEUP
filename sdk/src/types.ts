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
  score: number;
  contributions: Array<{
    circle_address: string;
    contributions: number;
    total_rounds: number;
  }>;
  defaults: Array<{
    circle_address: string;
    count: number;
  }>;
  updatedAt: string | null;
}

/** Response body for GET /health */
export interface ApiHealthResponse {
  status: "ok";
  timestamp: string;
}
