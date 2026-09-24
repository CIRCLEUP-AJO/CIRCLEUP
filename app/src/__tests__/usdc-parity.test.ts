/**
 * Issue #460: Cross-workspace USDC / stroops parity tests.
 *
 * The app deliberately does not depend on @circleup/sdk, so the money-math
 * helpers are duplicated in app/src/lib/config.ts with a comment saying they
 * must stay behaviourally identical to sdk/src/utils.ts.
 *
 * This file is the automated enforcement of that contract. It imports both
 * copies and asserts that every representative input produces the same output
 * from both implementations.
 *
 * If a future change makes the two diverge — even by one stroop — this test
 * will catch it in CI before it reaches a user.
 */

import { describe, it, expect } from "vitest";

// App copy (app/src/lib/config.ts)
import {
  usdcToStroops as appUsdcToStroops,
  stroopsToUsdc as appStroopsToUsdc,
  formatUsdc as appFormatUsdc,
  formatPot as appFormatPot,
  daysToLedgers as appDaysToLedgers,
  ledgersToDays as appLedgersToDays,
} from "../lib/config";

// SDK copy — imported via a relative path to the sibling workspace source.
// The app intentionally does not list @circleup/sdk as a package dependency
// (see app/src/lib/config.ts comment), so we reach the SDK directly from the
// monorepo tree. This is the right approach for a parity test whose only job
// is comparing the two copies; the relative path is stable in the monorepo
// layout and does not represent a runtime dependency.
import {
  usdcToStroops as sdkUsdcToStroops,
  stroopsToUsdc as sdkStroopsToUsdc,
  formatUsdc as sdkFormatUsdc,
  formatPot as sdkFormatPot,
  daysToLedgers as sdkDaysToLedgers,
  ledgersToDays as sdkLedgersToDays,
} from "../../../../sdk/src/utils";

// ─── Shared test vectors ──────────────────────────────────────────────────────

/** Stroop values that cover the full range of realistic monetary inputs. */
const STROOP_VECTORS: Array<bigint | string | number> = [
  0n,
  1n,
  100_000n,         // 0.01 USDC
  1_000_000n,       // 0.10 USDC
  10_000_000n,      // 1.00 USDC
  15_000_000n,      // 1.50 USDC
  100_000_000n,     // 10.00 USDC
  123_456_789n,
  1_000_000_000n,   // 100.00 USDC
  10_000_000_000n,  // 1,000.00 USDC
  "10000000",       // string input — common from DB / API
  "15000000",
  10_000_000,       // number input
];

/** USDC decimal strings that cover edge cases in usdcToStroops. */
const USDC_STRING_VECTORS = [
  "0",
  "0.0",
  "0.0000000",
  "1",
  "1.5",
  "1.50",
  "1.5000000",
  "0.01",
  "0.0000001",
  "10",
  "100.25",
  "999.9999999",
  "1e-7",
  "5e-1",
  "1.5e3",
];

/** Number inputs accepted by usdcToStroops (valid, non-negative, ≤7 decimals). */
const USDC_NUMBER_VECTORS: number[] = [
  0,
  1,
  10,
  0.5,
  0.01,
  0.0000001,
  100.25,
];

// ─── usdcToStroops parity ─────────────────────────────────────────────────────

describe("#460 usdcToStroops — app vs SDK parity", () => {
  it("produces identical results for valid string inputs", () => {
    for (const input of USDC_STRING_VECTORS) {
      const appResult = appUsdcToStroops(input);
      const sdkResult = sdkUsdcToStroops(input);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("produces identical results for valid number inputs", () => {
    for (const input of USDC_NUMBER_VECTORS) {
      const appResult = appUsdcToStroops(input);
      const sdkResult = sdkUsdcToStroops(input);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("both throw TypeError for negative amounts", () => {
    const badInputs: Array<number | string> = [-1, -0.5, "-1", "-0.0000001"];
    for (const input of badInputs) {
      expect(() => appUsdcToStroops(input)).toThrow(TypeError);
      expect(() => sdkUsdcToStroops(input)).toThrow(TypeError);
    }
  });

  it("both throw TypeError for >7 significant decimal places", () => {
    const badInputs = ["1.12345678", "0.00000001", "1.5e-7"];
    for (const input of badInputs) {
      expect(() => appUsdcToStroops(input)).toThrow(TypeError);
      expect(() => sdkUsdcToStroops(input)).toThrow(TypeError);
    }
  });

  it("both throw TypeError for NaN / Infinity", () => {
    expect(() => appUsdcToStroops(NaN)).toThrow(TypeError);
    expect(() => sdkUsdcToStroops(NaN)).toThrow(TypeError);
    expect(() => appUsdcToStroops(Infinity)).toThrow(TypeError);
    expect(() => sdkUsdcToStroops(Infinity)).toThrow(TypeError);
  });

  it("both throw TypeError for empty / whitespace strings", () => {
    expect(() => appUsdcToStroops("")).toThrow(TypeError);
    expect(() => sdkUsdcToStroops("")).toThrow(TypeError);
    expect(() => appUsdcToStroops("   ")).toThrow(TypeError);
    expect(() => sdkUsdcToStroops("   ")).toThrow(TypeError);
  });

  it("both throw TypeError for malformed exponent notation", () => {
    const bad = ["1e", "1e2e3", "e5"];
    for (const input of bad) {
      expect(() => appUsdcToStroops(input)).toThrow(TypeError);
      expect(() => sdkUsdcToStroops(input)).toThrow(TypeError);
    }
  });
});

// ─── stroopsToUsdc parity ─────────────────────────────────────────────────────

describe("#460 stroopsToUsdc — app vs SDK parity", () => {
  it("produces identical results for representative stroop values", () => {
    for (const input of STROOP_VECTORS) {
      const appResult = appStroopsToUsdc(input);
      const sdkResult = sdkStroopsToUsdc(input);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("both return '0' for negative stroops", () => {
    const neg: Array<bigint | string | number> = [-1n, "-100", -1];
    for (const input of neg) {
      expect(appStroopsToUsdc(input)).toBe("0");
      expect(sdkStroopsToUsdc(input)).toBe("0");
    }
  });

  it("both return '0' for invalid / non-numeric inputs", () => {
    const bad: Array<bigint | string | number> = ["not-a-number", ""];
    for (const input of bad) {
      expect(appStroopsToUsdc(input)).toBe("0");
      expect(sdkStroopsToUsdc(input)).toBe("0");
    }
  });

  it("usdcToStroops ∘ stroopsToUsdc round-trips are identical", () => {
    const values = [0n, 1n, 100_000n, 15_000_000n, 100_000_000n, 123_456_789n];
    for (const v of values) {
      const appRoundTrip = appUsdcToStroops(appStroopsToUsdc(v));
      const sdkRoundTrip = sdkUsdcToStroops(sdkStroopsToUsdc(v));
      expect(appRoundTrip).toBe(v);
      expect(sdkRoundTrip).toBe(v);
      // Cross-check: both round trips agree with each other
      expect(appRoundTrip).toBe(sdkRoundTrip);
    }
  });
});

// ─── formatUsdc parity ────────────────────────────────────────────────────────

describe("#460 formatUsdc — app vs SDK parity", () => {
  it("produces identical 2-dp display strings", () => {
    for (const input of STROOP_VECTORS) {
      const appResult = appFormatUsdc(input);
      const sdkResult = sdkFormatUsdc(input);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("both truncate (not round) at 2 dp", () => {
    // 12_349_999 stroops = 1.2349999 USDC — truncate to "1.23", never "1.24"
    expect(appFormatUsdc(12_349_999n)).toBe("1.23");
    expect(sdkFormatUsdc(12_349_999n)).toBe("1.23");
  });

  it("both return '0.00' for zero", () => {
    expect(appFormatUsdc(0n)).toBe("0.00");
    expect(sdkFormatUsdc(0n)).toBe("0.00");
  });

  it("both return '0.00' for negative values", () => {
    expect(appFormatUsdc(-1n)).toBe("0.00");
    expect(sdkFormatUsdc(-1n)).toBe("0.00");
  });

  it("both return '0.00' for invalid input", () => {
    expect(appFormatUsdc("bad")).toBe("0.00");
    expect(sdkFormatUsdc("bad")).toBe("0.00");
  });
});

// ─── formatPot parity ─────────────────────────────────────────────────────────

describe("#460 formatPot — app vs SDK parity", () => {
  const cases: Array<[bigint | string | number, number]> = [
    [10_000_000n, 1],
    [10_000_000n, 4],
    [10_000_000n, 10],
    ["10000000", 5],
    [5_000_000n, 2],
    [0n, 0],
    [10_000_000n, 0],
  ];

  it("produces identical results for all test cases", () => {
    for (const [amount, count] of cases) {
      const appResult = appFormatPot(amount, count);
      const sdkResult = sdkFormatPot(amount, count);
      expect(appResult).toBe(sdkResult);
    }
  });

  it("both return '0.00' for negative member count", () => {
    expect(appFormatPot("10000000", -1)).toBe("0.00");
    expect(sdkFormatPot("10000000", -1)).toBe("0.00");
  });

  it("both return '0.00' for fractional member count", () => {
    expect(appFormatPot("10000000", 1.5)).toBe("0.00");
    expect(sdkFormatPot("10000000", 1.5)).toBe("0.00");
  });

  it("both return '0.00' for invalid amount", () => {
    expect(appFormatPot("bad", 4)).toBe("0.00");
    expect(sdkFormatPot("bad", 4)).toBe("0.00");
  });
});

// ─── Ledger helpers parity ────────────────────────────────────────────────────

describe("#460 daysToLedgers / ledgersToDays — app vs SDK parity", () => {
  const dayValues = [0, 1, 7, 30, 365];
  const ledgerValues = [0, 17_280, 120_960, 1_036_800];

  it("daysToLedgers produces identical results", () => {
    for (const days of dayValues) {
      expect(appDaysToLedgers(days)).toBe(sdkDaysToLedgers(days));
    }
  });

  it("ledgersToDays produces identical results", () => {
    for (const ledgers of ledgerValues) {
      expect(appLedgersToDays(ledgers)).toBe(sdkLedgersToDays(ledgers));
    }
  });

  it("both throw RangeError for negative days", () => {
    expect(() => appDaysToLedgers(-1)).toThrow(RangeError);
    expect(() => sdkDaysToLedgers(-1)).toThrow(RangeError);
  });

  it("both throw RangeError for negative ledgers", () => {
    expect(() => appLedgersToDays(-1)).toThrow(RangeError);
    expect(() => sdkLedgersToDays(-1)).toThrow(RangeError);
  });
});

// ─── Conversion boundary cases ────────────────────────────────────────────────

describe("#460 conversion edge cases", () => {
  it("one stroop is the minimum representable USDC amount in both copies", () => {
    expect(appUsdcToStroops("0.0000001")).toBe(1n);
    expect(sdkUsdcToStroops("0.0000001")).toBe(1n);
    expect(appStroopsToUsdc(1n)).toBe("0.0000001");
    expect(sdkStroopsToUsdc(1n)).toBe("0.0000001");
  });

  it("formatUsdc of one stroop is '0.00' (less than 1 cent) in both copies", () => {
    // 1 stroop = 0.0000001 USDC — rounds down to 0.00 at 2 dp
    expect(appFormatUsdc(1n)).toBe("0.00");
    expect(sdkFormatUsdc(1n)).toBe("0.00");
  });

  it("large round amounts are handled identically by both copies", () => {
    // 1,000 USDC × 20 members = $20,000 pot
    const roundAmount = appUsdcToStroops("1000");
    const memberCount = 20;
    expect(appFormatPot(roundAmount, memberCount)).toBe("20000.00");
    expect(sdkFormatPot(roundAmount, memberCount)).toBe("20000.00");
  });

  it("trailing zeros are stripped identically in both stroopsToUsdc copies", () => {
    // 1.5000000 → "1.5", 10.0000000 → "10"
    expect(appStroopsToUsdc(15_000_000n)).toBe("1.5");
    expect(sdkStroopsToUsdc(15_000_000n)).toBe("1.5");
    expect(appStroopsToUsdc(100_000_000n)).toBe("10");
    expect(sdkStroopsToUsdc(100_000_000n)).toBe("10");
  });
});
