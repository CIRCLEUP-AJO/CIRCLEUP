// ─── bigint serialization helpers (Issue #908) ───────────────────────────────
//
// Soroban returns large integer values as `bigint` (i128, u64, u32 when wide).
// JSON does not natively support `bigint`: `JSON.stringify(1n)` throws a
// `TypeError: Do not know how to serialize a BigInt` and
// `JSON.parse` never produces a `bigint`.
//
// Indexer databases return arbitrary-precision numeric fields as strings.
// Callers who log or persist an SDK response can therefore hit either:
//   a) A runtime TypeError when calling JSON.stringify on an SDK response
//      containing a bigint field (e.g. CircleConfig.roundAmount,
//      RoundState.deadlineLedger, MemberState.collateral).
//   b) Silent precision loss when a consumer converts a bigint to `number`
//      without checking Number.isSafeInteger first.
//
// This module provides:
//   - `bigintReplacer`      — a JSON.stringify `replacer` that converts bigint
//                             values to decimal strings so serialization never
//                             throws.
//   - `bigintReviver`       — a JSON.parse `reviver` that converts the
//                             decimal-string wire form back to bigint for every
//                             key whose value is a decimal-integer string.
//                             NOTE: the reviver is intentionally conservative —
//                             it only restores a string that is *only* digits
//                             (optionally with a leading `-`).  Plain numeric
//                             strings from the indexer API (stroop amounts) are
//                             therefore left as strings by the reviver; callers
//                             that want bigint for those must call
//                             `decimalStringToBigInt` explicitly.
//   - `bigintToDecimalString` — convert a single bigint to its canonical
//                               decimal string representation (the wire format).
//   - `decimalStringToBigInt` — parse a canonical decimal string back to bigint,
//                               returning null for invalid inputs rather than
//                               throwing so callers can apply it to untrusted
//                               data.
//   - `serializeWithBigInt`   — JSON.stringify wrapper that uses bigintReplacer.
//   - `deserializeWithBigInt` — JSON.parse wrapper that uses bigintReviver.
//
// CONTRACT (the wire format):
//   • A bigint is serialized as its base-10 decimal string with no suffix,
//     quotes, or type annotation — e.g. `123456789012345678901234567890` or
//     `-1`.  Zero is `"0"`.
//   • The reviver restores a JSON string value to bigint only when the string
//     matches /^-?\d+$/ (all digits, optional leading minus, no whitespace, no
//     decimal point, no exponent).  This means stroop amounts returned by the
//     indexer (which are also digit-only strings) ARE restored by the reviver.
//     Callers that persist both indexer stroop strings and SDK bigint fields in
//     the same JSON object should use `serializeWithBigInt` for the write and
//     `deserializeWithBigInt` for the read; both sides then agree on the wire
//     format.
//   • Contract arithmetic fields remain `bigint` throughout SDK internals.
//     These helpers are for JSON boundaries only — do NOT convert a bigint to
//     a number inside SDK code.
//
// GLOBAL PROTOTYPE PATCH POLICY:
//   This module deliberately does NOT patch `BigInt.prototype.toJSON` or
//   `JSON`.  A global patch would affect every `JSON.stringify` call site in
//   the host application, including third-party code, which is an unexpected
//   and hard-to-debug side effect.  Instead callers pass `bigintReplacer` to
//   `JSON.stringify` explicitly, or use the `serializeWithBigInt` convenience
//   wrapper.

// ─── Wire format ─────────────────────────────────────────────────────────────

/**
 * The canonical wire representation of a `bigint` value: its base-10 decimal
 * string as produced by `bigint.toString()`.
 *
 * This is the agreed wire format between SDK serialization and deserialization.
 * Any value that matches `/^-?\d+$/` is a valid wire value.
 *
 * Examples:
 *   `0n`                      → `"0"`
 *   `-1n`                     → `"-1"`
 *   `15_000_000n`             → `"15000000"`
 *   `10n ** 28n`              → `"10000000000000000000000000000"`
 *   `-(1n << 127n)`           → `"-170141183460469231731687303715884105728"`
 */
export type BigIntWireString = string;

// ─── bigintToDecimalString ────────────────────────────────────────────────────

/**
 * Convert a single `bigint` to its canonical decimal wire string.
 *
 * This is exactly `value.toString()` — the function exists so callers have an
 * explicit, named conversion that is easy to search for and document.
 *
 * ```ts
 * bigintToDecimalString(0n)               // "0"
 * bigintToDecimalString(-1n)              // "-1"
 * bigintToDecimalString(10n ** 28n)       // "10000000000000000000000000000"
 * bigintToDecimalString(-(1n << 127n))    // "-170141183460469231731687303715884105728"
 * ```
 */
export function bigintToDecimalString(value: bigint): BigIntWireString {
  return value.toString();
}

// ─── decimalStringToBigInt ────────────────────────────────────────────────────

/** Matches a canonical bigint wire string: digits only, optional leading `-`. */
const DECIMAL_INTEGER_RE = /^-?\d+$/;

/**
 * Parse a canonical decimal wire string back to `bigint`.
 *
 * Returns `null` — never throws — when the input does not match the wire
 * format.  This makes it safe to apply to untrusted data (indexer responses,
 * persisted JSON) without wrapping in try/catch.
 *
 * ```ts
 * decimalStringToBigInt("0")                              // 0n
 * decimalStringToBigInt("-1")                             // -1n
 * decimalStringToBigInt("15000000")                       // 15000000n
 * decimalStringToBigInt("10000000000000000000000000000")  // 10n ** 28n
 * decimalStringToBigInt("1.5")                            // null (not an integer)
 * decimalStringToBigInt("1e7")                            // null (exponent form)
 * decimalStringToBigInt("")                               // null
 * decimalStringToBigInt("abc")                            // null
 * ```
 */
export function decimalStringToBigInt(value: string): bigint | null {
  if (!DECIMAL_INTEGER_RE.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    // Theoretically unreachable — BigInt() accepts any decimal integer string
    // — but guard against future engine edge cases.
    return null;
  }
}

// ─── bigintReplacer ───────────────────────────────────────────────────────────

/**
 * A `JSON.stringify` replacer that converts every `bigint` value in the object
 * tree to its decimal wire string so serialization never throws.
 *
 * Pass it as the second argument to `JSON.stringify`:
 *
 * ```ts
 * import { bigintReplacer } from "@circleup/sdk";
 *
 * const config = await client.getConfig();
 * const json = JSON.stringify(config, bigintReplacer, 2);
 * // config.roundAmount (bigint) → decimal string in the JSON output
 * ```
 *
 * Or use the convenience wrapper {@link serializeWithBigInt} instead.
 *
 * # What is serialized
 *
 * SDK fields that are `bigint`:
 *
 * | Type | Field | XDR origin |
 * |------|-------|-----------|
 * | `CircleConfig` | `roundAmount` | i128 |
 * | `RoundState` | `deadlineLedger` | u64 |
 * | `MemberState` | `collateral` | i128 |
 *
 * Fields produced by {@link decodeBigInt}, {@link decodeI128}, or
 * {@link decodeU64} in `validators.ts` are always `bigint` by the time they
 * reach a caller.
 *
 * # Precision
 *
 * JavaScript `number` has 53 bits of integer precision
 * (`Number.MAX_SAFE_INTEGER ≈ 9 × 10^15`).  An i128 on-chain amount can
 * exceed `9 × 10^38`; converting to `number` would silently corrupt balances.
 * The decimal-string wire format preserves the full value without loss.
 *
 * # No global patch
 *
 * This replacer is scoped to a single `JSON.stringify` call.  It does **not**
 * patch `BigInt.prototype.toJSON` or `JSON`.
 */
export function bigintReplacer(
  _key: string,
  value: unknown,
): unknown {
  if (typeof value === "bigint") {
    return bigintToDecimalString(value);
  }
  return value;
}

// ─── bigintReviver ────────────────────────────────────────────────────────────

/**
 * A `JSON.parse` reviver that converts decimal-integer strings back to `bigint`.
 *
 * Pass it as the second argument to `JSON.parse`:
 *
 * ```ts
 * import { bigintReviver } from "@circleup/sdk";
 *
 * const config = JSON.parse(json, bigintReviver) as CircleConfig;
 * // The decimal strings written by bigintReplacer become bigint again.
 * ```
 *
 * Or use the convenience wrapper {@link deserializeWithBigInt} instead.
 *
 * # Restoration rule
 *
 * A string value is converted to `bigint` **only** when it matches
 * `/^-?\d+$/` (a decimal integer string with no decimal point or exponent).
 * This means:
 *   - `"15000000"` → `15000000n` (bigint round-trips correctly)
 *   - `"1.5"`      → stays as `"1.5"` (stroop display strings are unaffected)
 *   - `"testnet"`  → stays as `"testnet"` (non-numeric strings unaffected)
 *
 * # Indexer stroop amounts
 *
 * Indexer API fields like `round_amount` and `collateral` are already decimal
 * integer strings (`"15000000"`).  When a payload containing both indexer
 * strings and SDK bigint fields is round-tripped through
 * `serializeWithBigInt` / `deserializeWithBigInt`, the indexer stroop strings
 * are also restored as `bigint`.  Call {@link decimalStringToBigInt} manually
 * if you only want selective restoration.
 */
export function bigintReviver(
  _key: string,
  value: unknown,
): unknown {
  if (typeof value === "string" && DECIMAL_INTEGER_RE.test(value)) {
    // Guard: BigInt constructor accepts any decimal integer string; the regex
    // already ensures the value is well-formed, but try/catch is cheap here
    // and prevents any future engine edge case from surfacing as an uncaught
    // exception inside JSON.parse.
    try {
      return BigInt(value);
    } catch {
      return value;
    }
  }
  return value;
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

/**
 * Serialize a value to a JSON string, safely handling any `bigint` fields by
 * converting them to their decimal string wire representation.
 *
 * Equivalent to `JSON.stringify(value, bigintReplacer, space)`.
 *
 * ```ts
 * import { serializeWithBigInt } from "@circleup/sdk";
 *
 * const config = await client.getConfig();
 * const json = serializeWithBigInt(config, 2);
 * // No TypeError — bigint fields are decimal strings in the output.
 * ```
 *
 * @param value The value to serialize.
 * @param space  Optional indentation (passed to `JSON.stringify`).
 */
export function serializeWithBigInt(value: unknown, space?: number | string): string {
  return JSON.stringify(value, bigintReplacer, space);
}

/**
 * Deserialize a JSON string, restoring decimal-integer strings to `bigint`.
 *
 * Equivalent to `JSON.parse(json, bigintReviver)`.
 *
 * ```ts
 * import { deserializeWithBigInt } from "@circleup/sdk";
 *
 * const config = deserializeWithBigInt(json) as CircleConfig;
 * // bigint fields (roundAmount, deadlineLedger, collateral) are bigint again.
 * ```
 *
 * @param json The JSON string to parse.
 */
export function deserializeWithBigInt(json: string): unknown {
  return JSON.parse(json, bigintReviver);
}
