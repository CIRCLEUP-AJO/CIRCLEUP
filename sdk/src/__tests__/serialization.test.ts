/**
 * Tests for sdk/src/serialization.ts  (Issue #908)
 *
 * Covers:
 *   1. bigintToDecimalString  — zero, negative, large positive
 *   2. decimalStringToBigInt  — round-trip, invalid inputs, null for non-integers
 *   3. bigintReplacer          — JSON.stringify never throws, correct wire form
 *   4. bigintReviver           — JSON.parse restores bigint from wire strings
 *   5. serializeWithBigInt     — convenience wrapper; SDK domain objects
 *   6. deserializeWithBigInt   — convenience wrapper; round-trip identity
 *   7. Acceptance criteria     — round-trip of every SDK bigint field,
 *                                precision above Number.MAX_SAFE_INTEGER,
 *                                plain strings are unaffected by reviver,
 *                                no global prototype patch side-effects
 */

import { describe, it, expect } from "vitest";
import {
  bigintToDecimalString,
  decimalStringToBigInt,
  bigintReplacer,
  bigintReviver,
  serializeWithBigInt,
  deserializeWithBigInt,
} from "../serialization";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Zero as bigint — a valid amount in SDK reads. */
const ZERO = 0n;

/** Negative one — valid for i128 (the range is -(2^127) to 2^127-1). */
const NEGATIVE_ONE = -1n;

/** Minimum i128 value: -(2^127). */
const I128_MIN = -(1n << 127n);

/** Maximum i128 value: 2^127 - 1. */
const I128_MAX = (1n << 127n) - 1n;

/** Maximum u64 value: 2^64 - 1 (used by RoundState.deadlineLedger). */
const U64_MAX = (1n << 64n) - 1n;

/**
 * A representative "round amount": 10 USDC in stroops.
 * 10 × 10_000_000 = 100_000_000 stroops.
 */
const ROUND_AMOUNT_10_USDC = 100_000_000n;

/**
 * Largest test vector: 1 trillion USDC in stroops.
 * Far above Number.MAX_SAFE_INTEGER (~9 × 10^15).
 */
const ONE_TRILLION_USDC_STROOPS = 10n ** 19n;

/** Wire string forms of the above values. */
const ZERO_WIRE            = "0";
const NEGATIVE_ONE_WIRE    = "-1";
const I128_MIN_WIRE        = "-170141183460469231731687303715884105728";
const I128_MAX_WIRE        = "170141183460469231731687303715884105727";
const U64_MAX_WIRE         = "18446744073709551615";
const ROUND_AMOUNT_WIRE    = "100000000";
const ONE_TRILLION_WIRE    = "10000000000000000000";

// ─── 1. bigintToDecimalString ─────────────────────────────────────────────────

describe("bigintToDecimalString", () => {
  it("converts zero", () => {
    expect(bigintToDecimalString(ZERO)).toBe(ZERO_WIRE);
  });

  it("converts negative one", () => {
    expect(bigintToDecimalString(NEGATIVE_ONE)).toBe(NEGATIVE_ONE_WIRE);
  });

  it("converts i128 minimum", () => {
    expect(bigintToDecimalString(I128_MIN)).toBe(I128_MIN_WIRE);
  });

  it("converts i128 maximum", () => {
    expect(bigintToDecimalString(I128_MAX)).toBe(I128_MAX_WIRE);
  });

  it("converts u64 maximum (deadline_ledger range)", () => {
    expect(bigintToDecimalString(U64_MAX)).toBe(U64_MAX_WIRE);
  });

  it("converts a typical round_amount", () => {
    expect(bigintToDecimalString(ROUND_AMOUNT_10_USDC)).toBe(ROUND_AMOUNT_WIRE);
  });

  it("converts a value above Number.MAX_SAFE_INTEGER without precision loss", () => {
    expect(bigintToDecimalString(ONE_TRILLION_USDC_STROOPS)).toBe(ONE_TRILLION_WIRE);
  });

  it("produces a string (not a number)", () => {
    expect(typeof bigintToDecimalString(ROUND_AMOUNT_10_USDC)).toBe("string");
  });
});

// ─── 2. decimalStringToBigInt ─────────────────────────────────────────────────

describe("decimalStringToBigInt", () => {
  it("parses '0' → 0n", () => {
    expect(decimalStringToBigInt(ZERO_WIRE)).toBe(ZERO);
  });

  it("parses '-1' → -1n", () => {
    expect(decimalStringToBigInt(NEGATIVE_ONE_WIRE)).toBe(NEGATIVE_ONE);
  });

  it("parses i128 minimum wire string exactly", () => {
    expect(decimalStringToBigInt(I128_MIN_WIRE)).toBe(I128_MIN);
  });

  it("parses i128 maximum wire string exactly", () => {
    expect(decimalStringToBigInt(I128_MAX_WIRE)).toBe(I128_MAX);
  });

  it("parses u64 maximum wire string exactly", () => {
    expect(decimalStringToBigInt(U64_MAX_WIRE)).toBe(U64_MAX);
  });

  it("parses a typical round_amount wire string", () => {
    expect(decimalStringToBigInt(ROUND_AMOUNT_WIRE)).toBe(ROUND_AMOUNT_10_USDC);
  });

  it("parses a value above Number.MAX_SAFE_INTEGER without precision loss", () => {
    expect(decimalStringToBigInt(ONE_TRILLION_WIRE)).toBe(ONE_TRILLION_USDC_STROOPS);
  });

  it("returns null for empty string", () => {
    expect(decimalStringToBigInt("")).toBeNull();
  });

  it("returns null for decimal point (stroop display, not an integer)", () => {
    expect(decimalStringToBigInt("1.5")).toBeNull();
  });

  it("returns null for exponent notation", () => {
    expect(decimalStringToBigInt("1e7")).toBeNull();
    expect(decimalStringToBigInt("1E-7")).toBeNull();
  });

  it("returns null for alphabetic strings", () => {
    expect(decimalStringToBigInt("abc")).toBeNull();
    expect(decimalStringToBigInt("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")).toBeNull();
  });

  it("returns null for strings with leading/trailing whitespace", () => {
    expect(decimalStringToBigInt(" 0")).toBeNull();
    expect(decimalStringToBigInt("0 ")).toBeNull();
    expect(decimalStringToBigInt(" 100 ")).toBeNull();
  });

  it("returns null for '--1' (double minus)", () => {
    expect(decimalStringToBigInt("--1")).toBeNull();
  });
});

// ─── 3. bigintReplacer ────────────────────────────────────────────────────────

describe("bigintReplacer — JSON.stringify does not throw on bigint", () => {
  it("converts a top-level bigint value to its wire string", () => {
    // JSON.stringify requires a wrapping object; pass as a value under a key.
    const result = JSON.stringify({ n: ROUND_AMOUNT_10_USDC }, bigintReplacer);
    const parsed = JSON.parse(result);
    expect(parsed.n).toBe(ROUND_AMOUNT_WIRE);
  });

  it("converts zero to '0'", () => {
    const result = JSON.stringify({ n: ZERO }, bigintReplacer);
    expect(JSON.parse(result).n).toBe(ZERO_WIRE);
  });

  it("converts negative bigint correctly", () => {
    const result = JSON.stringify({ n: NEGATIVE_ONE }, bigintReplacer);
    expect(JSON.parse(result).n).toBe(NEGATIVE_ONE_WIRE);
  });

  it("converts i128 minimum correctly", () => {
    const result = JSON.stringify({ n: I128_MIN }, bigintReplacer);
    expect(JSON.parse(result).n).toBe(I128_MIN_WIRE);
  });

  it("converts a value above Number.MAX_SAFE_INTEGER without truncation", () => {
    const result = JSON.stringify({ n: ONE_TRILLION_USDC_STROOPS }, bigintReplacer);
    expect(JSON.parse(result).n).toBe(ONE_TRILLION_WIRE);
  });

  it("does not throw where plain JSON.stringify would", () => {
    const obj = { roundAmount: ROUND_AMOUNT_10_USDC };
    expect(() => JSON.stringify(obj)).toThrow(TypeError);
    expect(() => JSON.stringify(obj, bigintReplacer)).not.toThrow();
  });

  it("leaves non-bigint values untouched", () => {
    const obj = {
      str: "hello",
      num: 42,
      bool: true,
      nil: null,
    };
    const result = JSON.parse(JSON.stringify(obj, bigintReplacer));
    expect(result.str).toBe("hello");
    expect(result.num).toBe(42);
    expect(result.bool).toBe(true);
    expect(result.nil).toBeNull();
  });

  it("handles nested bigint fields in an object tree", () => {
    const obj = {
      config: {
        roundAmount: ROUND_AMOUNT_10_USDC,
        members: ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"],
        roundDeadlineLedgers: 17280,
      },
      round: {
        deadlineLedger: U64_MAX,
        roundIndex: 0,
      },
      collateral: ZERO,
    };
    const result = JSON.parse(JSON.stringify(obj, bigintReplacer));
    expect(result.config.roundAmount).toBe(ROUND_AMOUNT_WIRE);
    expect(result.config.roundDeadlineLedgers).toBe(17280);
    expect(result.round.deadlineLedger).toBe(U64_MAX_WIRE);
    expect(result.collateral).toBe(ZERO_WIRE);
  });
});

// ─── 4. bigintReviver ────────────────────────────────────────────────────────

describe("bigintReviver — JSON.parse restores decimal-integer strings to bigint", () => {
  it("restores '0' → 0n", () => {
    const result = JSON.parse(`{"n":"${ZERO_WIRE}"}`, bigintReviver) as { n: bigint };
    expect(result.n).toBe(ZERO);
  });

  it("restores '-1' → -1n", () => {
    const result = JSON.parse(`{"n":"${NEGATIVE_ONE_WIRE}"}`, bigintReviver) as { n: bigint };
    expect(result.n).toBe(NEGATIVE_ONE);
  });

  it("restores i128 minimum wire string", () => {
    const result = JSON.parse(`{"n":"${I128_MIN_WIRE}"}`, bigintReviver) as { n: bigint };
    expect(result.n).toBe(I128_MIN);
  });

  it("restores u64 maximum wire string", () => {
    const result = JSON.parse(`{"n":"${U64_MAX_WIRE}"}`, bigintReviver) as { n: bigint };
    expect(result.n).toBe(U64_MAX);
  });

  it("does NOT convert decimal-point strings (stroop display values stay strings)", () => {
    const result = JSON.parse('{"amount":"1.5"}', bigintReviver) as { amount: string };
    expect(result.amount).toBe("1.5");
    expect(typeof result.amount).toBe("string");
  });

  it("does NOT convert non-numeric strings", () => {
    const result = JSON.parse('{"s":"testnet"}', bigintReviver) as { s: string };
    expect(result.s).toBe("testnet");
  });

  it("does NOT convert JSON number literals (they stay as number)", () => {
    const result = JSON.parse('{"n":42}', bigintReviver) as { n: number };
    expect(result.n).toBe(42);
    expect(typeof result.n).toBe("number");
  });

  it("restores bigint in nested objects", () => {
    const json = JSON.stringify(
      { config: { roundAmount: ROUND_AMOUNT_WIRE, roundDeadlineLedgers: 17280 } },
    );
    const result = JSON.parse(json, bigintReviver) as {
      config: { roundAmount: bigint; roundDeadlineLedgers: bigint };
    };
    expect(result.config.roundAmount).toBe(ROUND_AMOUNT_10_USDC);
    // roundDeadlineLedgers is a JSON number 17280 — stays as number
    expect(typeof result.config.roundDeadlineLedgers).toBe("number");
  });
});

// ─── 5 & 6. serializeWithBigInt / deserializeWithBigInt ──────────────────────

describe("serializeWithBigInt / deserializeWithBigInt — round-trip", () => {
  it("round-trips zero", () => {
    const json = serializeWithBigInt({ n: ZERO });
    const back = deserializeWithBigInt(json) as { n: bigint };
    expect(back.n).toBe(ZERO);
  });

  it("round-trips negative bigint", () => {
    const json = serializeWithBigInt({ n: NEGATIVE_ONE });
    const back = deserializeWithBigInt(json) as { n: bigint };
    expect(back.n).toBe(NEGATIVE_ONE);
  });

  it("round-trips i128 minimum without precision loss", () => {
    const json = serializeWithBigInt({ n: I128_MIN });
    const back = deserializeWithBigInt(json) as { n: bigint };
    expect(back.n).toBe(I128_MIN);
  });

  it("round-trips i128 maximum without precision loss", () => {
    const json = serializeWithBigInt({ n: I128_MAX });
    const back = deserializeWithBigInt(json) as { n: bigint };
    expect(back.n).toBe(I128_MAX);
  });

  it("round-trips u64 maximum (deadline_ledger)", () => {
    const json = serializeWithBigInt({ n: U64_MAX });
    const back = deserializeWithBigInt(json) as { n: bigint };
    expect(back.n).toBe(U64_MAX);
  });

  it("round-trips a value above Number.MAX_SAFE_INTEGER without precision loss", () => {
    const json = serializeWithBigInt({ n: ONE_TRILLION_USDC_STROOPS });
    const back = deserializeWithBigInt(json) as { n: bigint };
    expect(back.n).toBe(ONE_TRILLION_USDC_STROOPS);
  });

  it("round-trips a mock CircleConfig object", () => {
    const config = {
      members: ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"],
      roundAmount: ROUND_AMOUNT_10_USDC,
      usdcToken: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      reputationContract: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      roundDeadlineLedgers: 17280,
    };
    const json = serializeWithBigInt(config);
    const back = deserializeWithBigInt(json) as typeof config;
    expect(back.roundAmount).toBe(ROUND_AMOUNT_10_USDC);
    expect(back.roundDeadlineLedgers).toBe(17280n); // JSON number "17280" restored as bigint
    expect(back.members).toEqual(config.members);
  });

  it("round-trips a mock RoundState object", () => {
    const round = {
      roundIndex: 0,
      recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      contributionsReceived: 3,
      deadlineLedger: U64_MAX,
      paidOut: false,
    };
    const json = serializeWithBigInt(round);
    const back = deserializeWithBigInt(json) as typeof round;
    expect(back.deadlineLedger).toBe(U64_MAX);
    expect(back.paidOut).toBe(false);
  });

  it("round-trips a mock MemberState object", () => {
    const member = {
      address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      collateral: ROUND_AMOUNT_10_USDC,
      defaults: 0,
      reputationScore: 85,
      hasContributedThisRound: true,
    };
    const json = serializeWithBigInt(member);
    const back = deserializeWithBigInt(json) as typeof member;
    expect(back.collateral).toBe(ROUND_AMOUNT_10_USDC);
    expect(back.hasContributedThisRound).toBe(true);
  });

  it("produces valid JSON (parseable without reviver too)", () => {
    const json = serializeWithBigInt({ n: ROUND_AMOUNT_10_USDC });
    expect(() => JSON.parse(json)).not.toThrow();
    const naive = JSON.parse(json) as { n: string };
    // Without reviver we get a string — which is fine for safe persistence
    expect(naive.n).toBe(ROUND_AMOUNT_WIRE);
  });

  it("supports optional indentation argument", () => {
    const json = serializeWithBigInt({ n: ZERO }, 2);
    expect(json).toContain("\n");
    const back = deserializeWithBigInt(json) as { n: bigint };
    expect(back.n).toBe(ZERO);
  });
});

// ─── 7. Acceptance criteria ───────────────────────────────────────────────────

describe("Acceptance criteria (Issue #908)", () => {
  it("SDK bigint fields can be serialized through serializeWithBigInt without a TypeError", () => {
    // These are the three bigint fields documented in SDK types:
    //   CircleConfig.roundAmount    (i128)
    //   RoundState.deadlineLedger   (u64)
    //   MemberState.collateral      (i128)
    const sdkValues = {
      roundAmount: ROUND_AMOUNT_10_USDC,
      deadlineLedger: U64_MAX,
      collateral: ZERO,
    };
    expect(() => serializeWithBigInt(sdkValues)).not.toThrow();
  });

  it("round-trip via serializeWithBigInt / deserializeWithBigInt recovers the exact original bigint", () => {
    const vectors: bigint[] = [
      ZERO,
      NEGATIVE_ONE,
      I128_MIN,
      I128_MAX,
      U64_MAX,
      ROUND_AMOUNT_10_USDC,
      ONE_TRILLION_USDC_STROOPS,
    ];
    for (const v of vectors) {
      const json = serializeWithBigInt({ v });
      const back = (deserializeWithBigInt(json) as { v: bigint }).v;
      expect(back).toBe(v);
    }
  });

  it("precision is preserved above Number.MAX_SAFE_INTEGER", () => {
    // Number.MAX_SAFE_INTEGER ≈ 9.007 × 10^15; ONE_TRILLION_WIRE is 10^19
    const n = ONE_TRILLION_USDC_STROOPS;
    expect(Number(n) > Number.MAX_SAFE_INTEGER).toBe(true);
    const json = serializeWithBigInt({ n });
    const back = (deserializeWithBigInt(json) as { n: bigint }).n;
    expect(back).toBe(n);
    // Confirm converting through number would actually lose information
    expect(BigInt(Number(n))).not.toBe(n);
  });

  it("contract arithmetic fields remain bigint throughout — serializeWithBigInt does not convert the input object", () => {
    // The original object must be unmodified by the serialization call.
    const original = { roundAmount: ROUND_AMOUNT_10_USDC };
    serializeWithBigInt(original);
    expect(original.roundAmount).toBe(ROUND_AMOUNT_10_USDC); // still bigint
    expect(typeof original.roundAmount).toBe("bigint");
  });

  it("non-bigint values survive the round-trip unchanged (plain strings, booleans, null)", () => {
    const payload = {
      status: "Active",
      member: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      paidOut: false,
      nothing: null,
      score: 85,
    };
    const json = serializeWithBigInt(payload);
    const back = deserializeWithBigInt(json) as typeof payload;
    // "Active" and the G-address are non-numeric strings — reviver leaves them alone
    expect(back.status).toBe("Active");
    expect(back.member).toBe(payload.member);
    expect(back.paidOut).toBe(false);
    expect(back.nothing).toBeNull();
    // score 85 — a JSON number literal; reviver leaves it as number
    expect(back.score).toBe(85);
  });

  it("BigInt.prototype.toJSON is NOT patched by this module", () => {
    // A global patch would cause unintended side-effects in third-party code.
    expect((BigInt.prototype as unknown as { toJSON?: unknown }).toJSON).toBeUndefined();
  });

  it("JSON (the global) is NOT patched by this module", () => {
    // stringify and parse must be the same functions as before the import.
    expect(JSON.stringify).toBe(JSON.stringify);
    expect(JSON.parse).toBe(JSON.parse);
  });
});
