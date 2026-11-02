// --- sdk/src/validators.ts --------------------------------------------------
//
// Runtime validators, decoders, and mappers extracted from types.ts.
// All functions that validate/transform at runtime live here; pure
// TypeScript type declarations remain in types.ts.
//
// Re-exported from sdk/src/index.ts via types.ts for backward compatibility.

import type {
  NetworkPassphrase,
  CircleUpConfig,
  TxMetadata,
  TxMetadataValue,
} from './types';
// ─── Config validation ────────────────────────────────────────────────────────

/** Regex for a Stellar/Soroban contract address: starts with C, 56 chars total. */
const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

/** Regex for a Stellar account address (public key): starts with G, 56 chars total. */
const ACCOUNT_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/** Returns true when `addr` looks like a valid Soroban contract address. */
export function isValidContractAddress(addr: string): boolean {
  return CONTRACT_ADDRESS_RE.test(addr);
}

/**
 * Returns true when `addr` is either a Stellar account (G…) or a Soroban
 * contract (C…) address — the two forms accepted anywhere the contracts take
 * an `Address` parameter.
 *
 * This is a shape check only; the strkey checksum is verified by the Stellar
 * SDK when the address is actually encoded (see `scAddress` in client.ts).
 */
export function isValidStellarAddress(addr: unknown): addr is string {
  return (
    typeof addr === "string" &&
    (ACCOUNT_ADDRESS_RE.test(addr) || CONTRACT_ADDRESS_RE.test(addr))
  );
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

  // indexerUrl — optional, but when present must look like an HTTP(S) URL
  if (cfg.indexerUrl !== undefined && cfg.indexerUrl !== null) {
    if (typeof cfg.indexerUrl !== "string") {
      errors.push(
        `config.indexerUrl must be a string URL (e.g. "http://localhost:3001"), got ${typeof cfg.indexerUrl}.`,
      );
    } else if (cfg.indexerUrl.trim() !== "" && !/^https?:\/\/.+/.test(cfg.indexerUrl.trim())) {
      errors.push(
        `config.indexerUrl "${cfg.indexerUrl}" does not look like a valid HTTP(S) URL.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid CircleUpConfig:\n${errors.map((e) => `  • ${e}`).join("\n")}`,
    );
  }
}

// ─── Contract argument validation ─────────────────────────────────────────────

/**
 * Validate a set of contract call parameters before any encoding is attempted.
 *
 * Called by high-level mutation methods (e.g. `createCircle`, `markDefault`)
 * to catch bad inputs — wrong types, out-of-range numbers, malformed addresses
 * — at the earliest possible point.  Returning a string rather than throwing
 * lets callers convert the problem into the appropriate error shape (`TxFailure`
 * for mutations, a thrown `TypeError` for pure encoders).
 *
 * @param params Named parameters to validate, checked in order.
 * @returns `null` when every parameter is valid; otherwise a human-readable
 *   description of the first problem found.
 */
export function validateContractArgs(
  params: Array<{ name: string; value: unknown; type: "address" | "u32" | "i128" | "bool" | "addressVec" }>,
): string | null {
  for (const { name, value, type } of params) {
    switch (type) {
      case "address": {
        if (!isValidStellarAddress(value)) {
          return (
            `"${name}" must be a Stellar account (G…) or contract (C…) address, ` +
            `got ${describeArgValue(value)}.`
          );
        }
        break;
      }
      case "u32": {
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 0xffffffff
        ) {
          return (
            `"${name}" must be a u32 integer (0–4294967295), ` +
            `got ${describeArgValue(value)}.`
          );
        }
        break;
      }
      case "i128": {
        const I128_MAX = (1n << 127n) - 1n;
        const I128_MIN = -(1n << 127n);
        if (typeof value === "number") {
          if (!Number.isInteger(value)) {
            return `"${name}" must be a whole number for i128 encoding, got ${value} (use a bigint).`;
          }
          if (!Number.isSafeInteger(value)) {
            return (
              `"${name}" (${value}) exceeds Number.MAX_SAFE_INTEGER and would lose ` +
              `precision when converted to i128. Pass a bigint instead.`
            );
          }
        } else if (typeof value === "bigint") {
          if (value < I128_MIN || value > I128_MAX) {
            return `"${name}" (${value}) is out of range for i128 (${I128_MIN}–${I128_MAX}).`;
          }
        } else {
          return `"${name}" must be a bigint or integer number for i128 encoding, got ${describeArgValue(value)}.`;
        }
        break;
      }
      case "bool": {
        if (typeof value !== "boolean") {
          return `"${name}" must be a boolean, got ${describeArgValue(value)}.`;
        }
        break;
      }
      case "addressVec": {
        if (!Array.isArray(value)) {
          return `"${name}" must be an array of Stellar addresses, got ${describeArgValue(value)}.`;
        }
        if (value.length === 0) {
          return `"${name}" must not be empty — at least one address is required.`;
        }
        for (let i = 0; i < value.length; i++) {
          if (!isValidStellarAddress(value[i])) {
            return (
              `"${name}[${i}]" is not a valid Stellar address, got ${describeArgValue(value[i])}.`
            );
          }
        }
        break;
      }
    }
  }
  return null;
}

/** Render an argument value concisely for an error message. */
function describeArgValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `bigint ${value}`;
  if (typeof value === "string") return `string "${value.slice(0, 40)}${value.length > 40 ? "…" : ""}"`;
  if (typeof value === "object") return `object (${Object.prototype.toString.call(value)})`;
  return `${typeof value} ${JSON.stringify(value)}`;
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

/**
 * Decoded configuration of a deployed circle contract.
 *
 * Returned by `CircleClient.getConfig()`.  All values are read from on-chain
 * storage via `get_config` simulation and decoded through `mapRawConfig`.
 *
 * # Invariants
 *
 * - `members.length` is in `[2, 256]` (enforced by `initialize`).
 * - Every address in `members` is a distinct Stellar account or contract address.
 * - The order of `members` determines the payout rotation: round `i` pays
 *   `members[i]`.  This order is fixed at `initialize` time and **never**
 *   changes regardless of join order.
 * - `roundAmount > 0n` (enforced by `initialize`).
 * - `roundAmount × members.length` fits in `i128` (overflow-checked at
 *   initialize time by the contract).
 * - `roundDeadlineLedgers` is in `[100, 1_036_800]`.
 * - `usdcToken` and `reputationContract` are distinct addresses and neither
 *   equals the circle's own contract address.
 */
export interface CircleConfig {
  members: string[];
  roundAmount: bigint;       // in stroops (1 USDC = 10_000_000n)
  usdcToken: string;
  reputationContract: string;
  roundDeadlineLedgers: number;
}

/**
 * Decoded state of the current (or most recent) round.
 *
 * Returned by `CircleClient.getCurrentRound()`.
 *
 * # Invariants
 *
 * - Only readable when `status === "Active"` — throws `ContractError.CircleNotActive`
 *   otherwise (surfaced as a `ReadFailure` by `getCurrentRoundResult`).
 * - `roundIndex` is in `[0, member_count - 1]` and strictly increases across
 *   rounds; it never decrements.
 * - `recipient` equals `config.members[roundIndex]` — the rotation is position-
 *   based, not join-order-based.
 * - `contributionsReceived` is in `[0, member_count]`; it reaches `member_count`
 *   exactly once per round (the trigger for payout).
 * - `deadlineLedger` is set at the ledger the circle goes Active (round 0) and
 *   at each `payout` call for subsequent rounds.
 * - `paidOut` starts `false`; set to `true` atomically with the pot transfer
 *   and never reverts (single-use CEI guard).
 */
export interface RoundState {
  roundIndex: number;
  recipient: string;
  contributionsReceived: number;
  deadlineLedger: bigint;
  paidOut: boolean;
}

/**
 * Aggregate snapshot of a circle's on-chain state.
 *
 * # Invariants
 *
 * - `status` is always one of the four `CircleStatus` variants; the SDK
 *   throws if the contract returns an unrecognised value.
 * - `currentRound` is only valid when `status === "Active"`.  For all other
 *   statuses it is absent or carries a zero-valued sentinel; use
 *   `CircleClient.getCurrentRoundResult()` to handle this gracefully.
 */
export interface CircleState {
  address: string;
  config: CircleConfig;
  status: CircleStatus;
  currentRound: RoundState;
}

/**
 * Per-member view combining on-chain collateral, defaults, reputation, and
 * contribution state for the current round.
 *
 * # Invariants
 *
 * - `collateral ≥ 0n` — the contract clamps penalty deductions to 0.
 * - `defaults` is the total number of rounds this member has missed across
 *   the circle's lifetime.  It never decreases.
 * - `reputationScore` is the member's global reputation score across all
 *   circles — not circle-scoped.  It is monotonically non-decreasing.
 * - `hasContributedThisRound` reflects on-chain `has_contributed(member, current_round_index)`;
 *   it resets to `false` at the start of each new round.
 */
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
 * Render an unexpected wire value for an error message without dumping an
 * unbounded blob into a log line or a UI toast.
 */
function describeValue(value: unknown): string {
  if (typeof value === "bigint") return `bigint ${value}`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    const json = JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? `${v}` : v,
    );
    return json.length <= 120 ? json : `${json.slice(0, 117)}...`;
  }
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Decode a `u32` field produced by `scValToNative`.
 *
 * `scValToNative` yields a plain `number` for XDR `u32`.  Anything else means
 * the contract's return shape has drifted from what the SDK expects, so we
 * fail loudly at the boundary instead of letting `NaN` or `undefined` flow
 * into domain code.
 *
 * # Invariant S2
 *
 * Throws `TypeError` when the value is not an in-range u32.  The error message
 * includes `label` (the call-site context) so the source of the bad wire value
 * is always identifiable without a stack trace.
 *
 * @param label Call-site context included in the error message,
 *              e.g. `"getDefaults"` or `"mapRawRoundState.round_index"`.
 * @throws `TypeError` when the value is not an in-range u32.
 */
export function decodeU32(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new TypeError(
      `${label}: expected a u32 (number) but the contract returned ${describeValue(value)} ` +
        `(type: ${typeof value}). This usually means the contract's return type has changed ` +
        `or the wrong field was decoded.`,
    );
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError(
      `${label}: expected a u32 (0–4294967295) but the contract returned ${describeValue(value)}.`,
    );
  }
  return value;
}

/**
 * Decode an `i128` or `u64` field produced by `scValToNative`.
 *
 * `scValToNative` yields a `bigint` for both widths.  A plain `number` is
 * accepted too — a narrower integer type on the contract side is not a
 * correctness problem — but only when it is a safe integer, because beyond
 * 2^53 the conversion would silently round a monetary amount.
 *
 * # Invariant S2
 *
 * Throws `TypeError` when the value cannot be represented losslessly.  This
 * prevents silent monetary rounding when a financial field (e.g. `round_amount`,
 * `collateral`) arrives as an unsafe number.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value cannot be represented losslessly.
 */
export function decodeBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `${label}: expected an integer amount but the contract returned ${describeValue(value)}, ` +
          `which cannot be converted to bigint without losing precision.`,
      );
    }
    return BigInt(value);
  }
  throw new TypeError(
    `${label}: expected a bigint or number for an i128/u64 field but the contract returned ` +
      `${describeValue(value)} (type: ${typeof value}). ` +
      `This usually means the contract's return type has changed or the wrong field was decoded.`,
  );
}

/** Inclusive bounds of the XDR integer widths the contracts return. */
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

/**
 * Decode an `i128` field produced by `scValToNative`, rejecting values the XDR
 * type cannot hold and, optionally, values below a domain minimum.
 *
 * Built on {@link decodeBigInt}, so a safe-integer `number` is still accepted.
 * `min` expresses a contract invariant — e.g. collateral is clamped to `0n`,
 * and a round amount is always positive — so a value that breaks it fails here
 * with the field name instead of rendering as a negative balance.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value is not an integer, or is out of range.
 */
export function decodeI128(
  value: unknown,
  label: string,
  options: { min?: bigint } = {},
): bigint {
  const n = decodeBigInt(value, label);
  if (n < I128_MIN || n > I128_MAX) {
    throw new TypeError(`${label}: ${n} is out of range for i128.`);
  }
  if (options.min !== undefined && n < options.min) {
    throw new TypeError(
      `${label}: expected a value >= ${options.min} but the contract returned ${n}.`,
    );
  }
  return n;
}

/**
 * Decode a `u64` field (e.g. a ledger sequence) produced by `scValToNative`.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value is not an integer in `[0, 2^64 - 1]`.
 */
export function decodeU64(value: unknown, label: string): bigint {
  const n = decodeBigInt(value, label);
  if (n < 0n || n > U64_MAX) {
    throw new TypeError(`${label}: ${n} is out of range for u64 (0–${U64_MAX}).`);
  }
  return n;
}

/**
 * Decode a `u32` that the contract additionally constrains to `[min, max]`.
 *
 * The range is the contract's own validation (e.g. `round_deadline_ledgers`
 * is checked against `MIN_/MAX_ROUND_DEADLINE_LEDGERS` at initialize), so a
 * value outside it means the SDK is reading the wrong field or a contract
 * built with different bounds — either way not something to pass on silently.
 *
 * @throws `TypeError` when the value is not a u32 or falls outside the range.
 */
export function decodeU32InRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  const n = decodeU32(value, label);
  if (n < min || n > max) {
    throw new TypeError(
      `${label}: expected a value in [${min}, ${max}] but the contract returned ${n}.`,
    );
  }
  return n;
}

/**
 * Decode a contract struct produced by `scValToNative` into a plain record,
 * checking that every required field is present.
 *
 * `scValToNative` turns an `ScMap` into a plain object, so anything else — an
 * array (a `Vec` or an enum variant), a primitive, or `null` — means the view
 * returned a different type entirely. Every missing field is listed at once so
 * a renamed field is reported together with whatever replaced it.
 *
 * @param label Call-site context, e.g. `"mapRawConfig"`.
 * @param required Field names that must be present and not `undefined`.
 * @param structName Contract type named in the error, e.g. `"CircleConfig"`.
 * @throws `TypeError` when `value` is not a struct or a required field is absent.
 */
export function decodeRecord<K extends string>(
  value: unknown,
  label: string,
  required: readonly K[],
  structName = "contract struct",
): Record<K, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Map
  ) {
    throw new TypeError(
      `${label}: expected a ${structName} object but the contract returned ${describeValue(value)}.`,
    );
  }
  const record = value as Record<string, unknown>;
  const missing = required.filter((key) => record[key] === undefined);
  if (missing.length > 0) {
    throw new TypeError(
      `${label}: missing required field${missing.length === 1 ? "" : "s"} ` +
        `${missing.map((k) => `"${k}"`).join(", ")}. Fields present: ` +
        `${Object.keys(record).map((k) => `"${k}"`).join(", ") || "(none)"}.`,
    );
  }
  return record as Record<K, unknown>;
}

/**
 * Decode a `bool` field produced by `scValToNative`.
 *
 * Deliberately strict: a truthy string or number here would mean the contract
 * returned something other than a `bool`, and coercing it would hide the bug.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value is not a boolean.
 */
export function decodeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(
      `${label}: expected a boolean but the contract returned ${describeValue(value)} ` +
        `(type: ${typeof value}).`,
    );
  }
  return value;
}

/**
 * Decode an `Address` field produced by `scValToNative`.
 *
 * @param label Call-site context included in the error message.
 * @throws `TypeError` when the value is not a Stellar account or contract address.
 */
export function decodeAddress(value: unknown, label: string): string {
  if (!isValidStellarAddress(value)) {
    const typeTag = value === null ? "null"
      : value === undefined ? "undefined"
      : typeof value;
    throw new TypeError(
      `${label}: expected a Stellar address (G… or C…) but the contract returned ` +
        `${describeValue(value)} (type: ${typeTag}).`,
    );
  }
  return value;
}

/**
 * Decode a `Vec<Address>` field produced by `scValToNative`.
 *
 * Empty lists are valid — a freshly deployed factory has no circles yet.
 *
 * @param label Call-site context included in the error message.
 * @param options.unique Reject a list that names the same address twice, for
 *   fields the contract guarantees are distinct (e.g. a circle's members).
 * @param options.maxLength Reject a list longer than the contract allows.
 * @throws `TypeError` when the value is not an array of Stellar addresses, or
 *   breaks one of the requested constraints.
 */
export function decodeAddressList(
  value: unknown,
  label: string,
  options: { unique?: boolean; maxLength?: number } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${label}: expected an array of Stellar addresses but the contract returned ${describeValue(value)}.`,
    );
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new TypeError(
      `${label}: expected at most ${options.maxLength} addresses but the contract returned ${value.length}.`,
    );
  }
  const addresses = value.map((entry, i) => decodeAddress(entry, `${label}[${i}]`));
  if (options.unique) {
    const seen = new Map<string, number>();
    addresses.forEach((addr, i) => {
      const first = seen.get(addr);
      if (first !== undefined) {
        throw new TypeError(
          `${label}: address ${addr} appears at both index ${first} and index ${i}; ` +
            `the contract guarantees these entries are distinct.`,
        );
      }
      seen.set(addr, i);
    });
  }
  return addresses;
}

/** Bounds the circle contract enforces at `initialize` (see contracts/circle). */
const MIN_ROUND_DEADLINE_LEDGERS = 100;
const MAX_ROUND_DEADLINE_LEDGERS = 1_036_800;
const MAX_CIRCLE_MEMBERS = 256;

const CONFIG_FIELDS = [
  "members",
  "round_amount",
  "usdc_token",
  "reputation_contract",
  "round_deadline_ledgers",
] as const;

const ROUND_FIELDS = [
  "round_index",
  "recipient",
  "contributions_received",
  "deadline_ledger",
  "paid_out",
] as const;

/**
 * Map a raw `scValToNative` wire object to the typed `CircleConfig` domain
 * shape, validating every field as it is decoded.
 *
 * Beyond the per-field types, this enforces the invariants `initialize`
 * guarantees — distinct members (at most 256), a positive round amount, and a
 * deadline inside the contract's bounds — so a value that breaks them is
 * reported here rather than producing a config that looks valid but is not.
 *
 * @throws `TypeError` if `raw` is not an object, a field is missing, or any
 *   field has the wrong type or an out-of-range value — surfaces decode bugs
 *   at the boundary rather than letting `undefined` leak into domain code.
 */
export function mapRawConfig(raw: unknown): CircleConfig {
  const wire = decodeRecord(raw, "mapRawConfig", CONFIG_FIELDS, "CircleConfig");
  return {
    members: decodeAddressList(wire.members, "mapRawConfig.members", {
      unique: true,
      maxLength: MAX_CIRCLE_MEMBERS,
    }),
    roundAmount: decodeI128(wire.round_amount, "mapRawConfig.round_amount", { min: 1n }),
    usdcToken: decodeAddress(wire.usdc_token, "mapRawConfig.usdc_token"),
    reputationContract: decodeAddress(
      wire.reputation_contract,
      "mapRawConfig.reputation_contract",
    ),
    roundDeadlineLedgers: decodeU32InRange(
      wire.round_deadline_ledgers,
      "mapRawConfig.round_deadline_ledgers",
      MIN_ROUND_DEADLINE_LEDGERS,
      MAX_ROUND_DEADLINE_LEDGERS,
    ),
  };
}

/**
 * Map a raw `scValToNative` wire object to the typed `RoundState` domain shape,
 * validating every field as it is decoded.
 *
 * @throws `TypeError` if `raw` is not an object, a field is missing, or any
 *   field has the wrong type or an out-of-range value.
 */
export function mapRawRoundState(raw: unknown): RoundState {
  const wire = decodeRecord(raw, "mapRawRoundState", ROUND_FIELDS, "RoundState");
  return {
    roundIndex: decodeU32(wire.round_index, "mapRawRoundState.round_index"),
    recipient: decodeAddress(wire.recipient, "mapRawRoundState.recipient"),
    contributionsReceived: decodeU32InRange(
      wire.contributions_received,
      "mapRawRoundState.contributions_received",
      0,
      MAX_CIRCLE_MEMBERS,
    ),
    deadlineLedger: decodeU64(
      wire.deadline_ledger,
      "mapRawRoundState.deadline_ledger",
    ),
    paidOut: decodeBoolean(wire.paid_out, "mapRawRoundState.paid_out"),
  };
}

const CIRCLE_STATUSES: readonly CircleStatus[] = [
  "Pending",
  "Active",
  "Completed",
  "Cancelled",
];

/**
 * Validate a value returned by the contract's `get_status` view and narrow it
 * to a {@link CircleStatus}.
 *
 * `CircleStatus` is a `#[contracttype]` enum, and Soroban encodes a unit enum
 * variant as a one-element vector holding its name, which `scValToNative`
 * decodes to `["Active"]`. That wire form and a bare `"Active"` symbol are
 * both accepted. Anything else — an unknown variant, a variant carrying data
 * (`["Active", 1]`), wrong case, or a non-string — throws, so callers are never
 * handed a status that only looks valid.
 *
 * @throws `Error` naming the offending value and listing the valid variants.
 */
export function assertValidCircleStatus(value: unknown): CircleStatus {
  const name =
    Array.isArray(value) && value.length === 1 && typeof value[0] === "string"
      ? value[0]
      : value;
  if (typeof name !== "string" || !CIRCLE_STATUSES.includes(name as CircleStatus)) {
    throw new Error(
      `assertValidCircleStatus: unexpected value ${describeValue(value)}. ` +
        `Expected one of: ${CIRCLE_STATUSES.map((v) => `"${v}"`).join(", ")}.`,
    );
  }
  return name as CircleStatus;
}
