/**
 * amount-units.test.ts
 *
 * Tests for the amount unit labeling contract (sdk/src/utils.ts).
 *
 * Acceptance criteria verified here:
 *   1. Every user-visible or exported amount has an unambiguous unit label.
 *   2. No monetary conversion silently rounds — exact values round-trip.
 *   3. tagStroops rejects non-integer strings so mis-labelled floats are
 *      caught at tagging time, not downstream.
 *   4. toDisplayUsdc truncates (never rounds up) and carries UNIT_USDC.
 *   5. toExactUsdc always emits exactly 7 decimal places and carries
 *      UNIT_USDC_EXACT, enabling lossless round-trips.
 *   6. Edge cases: zero, one stroop, fractional amounts, very large values
 *      (above Number.MAX_SAFE_INTEGER), and maximum i128 precision.
 *   7. UNIT_STROOPS / UNIT_USDC / UNIT_USDC_EXACT constants are stable
 *      string literals so callers can rely on them for switch/case logic.
 */

import { describe, it, expect } from "vitest";
import {
  UNIT_STROOPS,
  UNIT_USDC,
  UNIT_USDC_EXACT,
  tagStroops,
  toDisplayUsdc,
  toExactUsdc,
  usdcToStroops,
  stroopsToUsdc,
  formatUsdc,
  STROOP,
  USDC_DECIMALS,
} from "./utils";

// ── Unit label constants ──────────────────────────────────────────────────────

describe("unit label constants", () => {
  it("UNIT_STROOPS is the string 'stroops'", () => {
    expect(UNIT_STROOPS).toBe("stroops");
  });

  it("UNIT_USDC is the string 'USDC'", () => {
    expect(UNIT_USDC).toBe("USDC");
  });

  it("UNIT_USDC_EXACT is the string 'USDC (exact)'", () => {
    expect(UNIT_USDC_EXACT).toBe("USDC (exact)");
  });

  it("constants are distinct from each other", () => {
    expect(UNIT_STROOPS).not.toBe(UNIT_USDC);
    expect(UNIT_STROOPS).not.toBe(UNIT_USDC_EXACT);
    expect(UNIT_USDC).not.toBe(UNIT_USDC_EXACT);
  });
});

// ── tagStroops ────────────────────────────────────────────────────────────────

describe("tagStroops — tagging raw wire values", () => {
  it("tags a valid decimal integer string with UNIT_STROOPS", () => {
    const result = tagStroops("15000000");
    expect(result.amount).toBe("15000000");
    expect(result.unit).toBe(UNIT_STROOPS);
  });

  it("tags zero", () => {
    const result = tagStroops("0");
    expect(result.amount).toBe("0");
    expect(result.unit).toBe(UNIT_STROOPS);
  });

  it("tags a negative stroop value (e.g. a penalty / debt)", () => {
    const result = tagStroops("-20000000");
    expect(result.amount).toBe("-20000000");
    expect(result.unit).toBe(UNIT_STROOPS);
  });

  it("trims surrounding whitespace before tagging", () => {
    const result = tagStroops("  100000000  ");
    expect(result.amount).toBe("100000000");
    expect(result.unit).toBe(UNIT_STROOPS);
  });

  it("tags a very large integer (i128 range)", () => {
    const i128Max = "170141183460469231731687303715884105727";
    const result = tagStroops(i128Max);
    expect(result.amount).toBe(i128Max);
    expect(result.unit).toBe(UNIT_STROOPS);
  });

  it("throws TypeError for a decimal (USDC display string)", () => {
    expect(() => tagStroops("1.5")).toThrow(TypeError);
    expect(() => tagStroops("10.00")).toThrow(TypeError);
    expect(() => tagStroops("0.0000001")).toThrow(TypeError);
  });

  it("throws TypeError for an empty string", () => {
    expect(() => tagStroops("")).toThrow(TypeError);
    expect(() => tagStroops("   ")).toThrow(TypeError);
  });

  it("throws TypeError for non-numeric strings", () => {
    expect(() => tagStroops("abc")).toThrow(TypeError);
    expect(() => tagStroops("1e7")).toThrow(TypeError);   // scientific notation
    expect(() => tagStroops("0x10")).toThrow(TypeError);  // hex
  });

  it("error message mentions the rejected value for debuggability", () => {
    let msg = "";
    try { tagStroops("1.5"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("1.5");
  });

  it("error message hints that a USDC display string may have been passed", () => {
    let msg = "";
    try { tagStroops("10.00"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/USDC display string/i);
  });
});

// ── toDisplayUsdc ─────────────────────────────────────────────────────────────

describe("toDisplayUsdc — 2-dp display values", () => {
  it("tags 1 USDC as '1.00 USDC'", () => {
    const result = toDisplayUsdc(STROOP);
    expect(result.amount).toBe("1.00");
    expect(result.unit).toBe(UNIT_USDC);
  });

  it("tags zero as '0.00 USDC'", () => {
    const result = toDisplayUsdc(0n);
    expect(result.amount).toBe("0.00");
    expect(result.unit).toBe(UNIT_USDC);
  });

  it("accepts bigint, string, and number inputs", () => {
    expect(toDisplayUsdc(100_000_000n).amount).toBe("10.00");
    expect(toDisplayUsdc("100000000").amount).toBe("10.00");
    expect(toDisplayUsdc(100_000_000).amount).toBe("10.00");
  });

  it("truncates to 2 dp — never rounds up", () => {
    // 12_349_999 stroops = 1.2349999 USDC → must show "1.23", never "1.24"
    expect(toDisplayUsdc(12_349_999n).amount).toBe("1.23");
    // 9_999_999 stroops = 0.9999999 USDC → must show "0.99", never "1.00"
    expect(toDisplayUsdc(9_999_999n).amount).toBe("0.99");
  });

  it("sub-cent values (< 100_000 stroops) display as '0.00'", () => {
    expect(toDisplayUsdc(1n).amount).toBe("0.00");       // 1 stroop
    expect(toDisplayUsdc(99_999n).amount).toBe("0.00");  // just under $0.01
  });

  it("returns '0.00 USDC' for negative values", () => {
    const result = toDisplayUsdc(-1n);
    expect(result.amount).toBe("0.00");
    expect(result.unit).toBe(UNIT_USDC);
  });

  it("returns '0.00 USDC' for invalid inputs", () => {
    expect(toDisplayUsdc("bad").amount).toBe("0.00");
    expect(toDisplayUsdc("bad").unit).toBe(UNIT_USDC);
  });

  it("large values above Number.MAX_SAFE_INTEGER display correctly", () => {
    // 10^19 stroops = 10^12 USDC = "1000000000000.00"
    const result = toDisplayUsdc(10n ** 19n);
    expect(result.amount).toBe("1000000000000.00");
    expect(result.unit).toBe(UNIT_USDC);
  });
});

// ── toExactUsdc ───────────────────────────────────────────────────────────────

describe("toExactUsdc — 7-dp exact values", () => {
  it("tags 1 USDC as '1.0000000 USDC (exact)'", () => {
    const result = toExactUsdc(STROOP);
    expect(result.amount).toBe("1.0000000");
    expect(result.unit).toBe(UNIT_USDC_EXACT);
  });

  it("tags zero as '0.0000000 USDC (exact)'", () => {
    const result = toExactUsdc(0n);
    expect(result.amount).toBe("0.0000000");
    expect(result.unit).toBe(UNIT_USDC_EXACT);
  });

  it("always emits exactly 7 decimal places", () => {
    // 1 stroop = 0.0000001 USDC — all 7 places must be present
    expect(toExactUsdc(1n).amount).toBe("0.0000001");
    // 10 USDC — trailing zeros preserved for uniform column width
    expect(toExactUsdc(100_000_000n).amount).toBe("10.0000000");
    // 1.5 USDC
    expect(toExactUsdc(15_000_000n).amount).toBe("1.5000000");
    // 0.01 USDC
    expect(toExactUsdc(100_000n).amount).toBe("0.0100000");
  });

  it("accepts bigint, string, and number inputs", () => {
    expect(toExactUsdc(100_000_000n).amount).toBe("10.0000000");
    expect(toExactUsdc("100000000").amount).toBe("10.0000000");
    expect(toExactUsdc(100_000_000).amount).toBe("10.0000000");
  });

  it("returns '0.0000000 USDC (exact)' for negative values", () => {
    const result = toExactUsdc(-1n);
    expect(result.amount).toBe("0.0000000");
    expect(result.unit).toBe(UNIT_USDC_EXACT);
  });

  it("returns '0.0000000 USDC (exact)' for invalid inputs", () => {
    expect(toExactUsdc("bad").amount).toBe("0.0000000");
    expect(toExactUsdc("bad").unit).toBe(UNIT_USDC_EXACT);
  });

  it("exact value round-trips through usdcToStroops without loss", () => {
    const testCases = [0n, 1n, 100_000n, 15_000_000n, 100_000_000n, 123_456_789n];
    for (const stroops of testCases) {
      const tagged = toExactUsdc(stroops);
      const recovered = usdcToStroops(tagged.amount);
      expect(recovered).toBe(stroops);
    }
  });

  it("preserves full precision for i128-range values (above Number.MAX_SAFE_INTEGER)", () => {
    // 10^19 stroops = 1_000_000_000_000.0000000 USDC
    const result = toExactUsdc(10n ** 19n);
    expect(result.amount).toBe("1000000000000.0000000");
    expect(result.unit).toBe(UNIT_USDC_EXACT);
    // Must round-trip exactly
    expect(usdcToStroops(result.amount)).toBe(10n ** 19n);
  });

  it("maximum-precision test vector: 999999999999.9999999 USDC", () => {
    const stroops = 9_999_999_999_999_999_999n;
    const result = toExactUsdc(stroops);
    expect(result.amount).toBe("999999999999.9999999");
    expect(usdcToStroops(result.amount)).toBe(stroops);
  });
});

// ── No silent rounding in any conversion helper ───────────────────────────────

describe("no silent rounding — exact conversion invariants", () => {
  it("usdcToStroops and stroopsToUsdc are exact inverses for 7-dp values", () => {
    const cases = [
      "0", "0.0000001", "0.01", "1", "1.5", "1.1234567",
      "10", "100", "999999999999.9999999",
    ];
    for (const usdc of cases) {
      const stroops = usdcToStroops(usdc);
      const recovered = stroopsToUsdc(stroops);
      // Re-parse to strip trailing zeros for comparison
      expect(usdcToStroops(recovered)).toBe(stroops);
    }
  });

  it("toExactUsdc output always converts back to the original stroops", () => {
    const inputs: Array<bigint | string | number> = [
      0n, 1n, 1_000_000n, STROOP, 100_000_000_000n, 10n ** 15n, 10n ** 19n,
    ];
    for (const input of inputs) {
      const tagged = toExactUsdc(input);
      const n = typeof input === "bigint" ? input : BigInt(input.toString());
      expect(usdcToStroops(tagged.amount)).toBe(n);
    }
  });

  it("toDisplayUsdc result never exceeds the true amount (truncation invariant)", () => {
    // For every sample, formatUsdc(n) ≤ actual USDC value
    const samples = [
      { stroops: 12_349_999n, display: "1.23" },
      { stroops: 9_999_999n,  display: "0.99" },
      { stroops: 999_999n,    display: "0.09" },
      { stroops: 100_000n,    display: "0.01" },
      { stroops: 99_999n,     display: "0.00" },
      { stroops: 1n,          display: "0.00" },
    ];
    for (const { stroops, display } of samples) {
      expect(toDisplayUsdc(stroops).amount).toBe(display);
      // Confirm displayed value ≤ true value
      const displayedStroops = usdcToStroops(display === "0.00" ? "0" : display);
      expect(displayedStroops).toBeLessThanOrEqual(stroops);
    }
  });

  it("formatUsdc (2dp) and toExactUsdc (7dp) agree on whole-USDC amounts", () => {
    const wholeUsdc = [0n, STROOP, 10n * STROOP, 100n * STROOP, 1_000n * STROOP];
    for (const n of wholeUsdc) {
      const display = formatUsdc(n);
      const exact = toExactUsdc(n).amount;
      // For whole USDC values the 2-dp and 7-dp forms must agree after parsing
      expect(usdcToStroops(display)).toBe(usdcToStroops(exact));
    }
  });
});

// ── TaggedAmount structural contract ─────────────────────────────────────────

describe("TaggedAmount structural contract", () => {
  it("tagStroops result has exactly amount and unit fields", () => {
    const result = tagStroops("100000000");
    expect(Object.keys(result).sort()).toEqual(["amount", "unit"]);
  });

  it("toDisplayUsdc result has exactly amount and unit fields", () => {
    const result = toDisplayUsdc(100_000_000n);
    expect(Object.keys(result).sort()).toEqual(["amount", "unit"]);
  });

  it("toExactUsdc result has exactly amount and unit fields", () => {
    const result = toExactUsdc(100_000_000n);
    expect(Object.keys(result).sort()).toEqual(["amount", "unit"]);
  });

  it("unit fields are the exact constant values (switch/case safe)", () => {
    // Callers use the unit field in switch/case; verify the constants are
    // the exact string values so there is no off-by-one with UNIT_* constants.
    expect(tagStroops("0").unit === UNIT_STROOPS).toBe(true);
    expect(toDisplayUsdc(0n).unit === UNIT_USDC).toBe(true);
    expect(toExactUsdc(0n).unit === UNIT_USDC_EXACT).toBe(true);
  });

  it("amount fields are always strings (not numbers)", () => {
    expect(typeof tagStroops("100000000").amount).toBe("string");
    expect(typeof toDisplayUsdc(100_000_000n).amount).toBe("string");
    expect(typeof toExactUsdc(100_000_000n).amount).toBe("string");
  });
});

// ── USDC_DECIMALS constant is the single source of truth ─────────────────────

describe("USDC_DECIMALS — single source of truth", () => {
  it("USDC_DECIMALS equals 7", () => {
    expect(USDC_DECIMALS).toBe(7);
  });

  it("STROOP equals 10^USDC_DECIMALS", () => {
    expect(STROOP).toBe(BigInt(10 ** USDC_DECIMALS));
  });

  it("toExactUsdc produces exactly USDC_DECIMALS decimal places", () => {
    const result = toExactUsdc(STROOP);
    const [, frac] = result.amount.split(".");
    expect(frac).toHaveLength(USDC_DECIMALS);
  });

  it("toExactUsdc(0n) produces USDC_DECIMALS zeros after the decimal point", () => {
    const result = toExactUsdc(0n);
    const [, frac] = result.amount.split(".");
    expect(frac).toBe("0".repeat(USDC_DECIMALS));
  });
});

// ── API consumer contract: distinguishing wire vs display amounts ──────────────

describe("API consumer contract — wire vs display distinguishability", () => {
  it("a stroop amount tagged with tagStroops cannot be confused with a USDC display", () => {
    // Simulate an API response field and a display field for the same value.
    const wireAmount = tagStroops("100000000");   // 10 USDC = 100_000_000 stroops
    const displayAmount = toDisplayUsdc(100_000_000n); // "10.00 USDC"

    // The amounts are numerically the same value in different representations.
    // The unit fields are the distinguishing signal.
    expect(wireAmount.unit).not.toBe(displayAmount.unit);
    expect(wireAmount.amount).toBe("100000000");
    expect(displayAmount.amount).toBe("10.00");
  });

  it("a USDC display string cannot be silently passed to tagStroops", () => {
    // Ensures the type guard at the boundary catches cross-unit accidents.
    expect(() => tagStroops("10.00")).toThrow(TypeError);
    expect(() => tagStroops("1.5000000")).toThrow(TypeError);
  });

  it("an exact USDC string is distinguishable from a 2-dp display string by unit", () => {
    const exact = toExactUsdc(15_000_000n);   // "1.5000000 USDC (exact)"
    const display = toDisplayUsdc(15_000_000n); // "1.50 USDC"

    expect(exact.unit).toBe(UNIT_USDC_EXACT);
    expect(display.unit).toBe(UNIT_USDC);
    expect(exact.amount).not.toBe(display.amount);
    // Exact preserves full precision; display is lossy
    expect(exact.amount).toBe("1.5000000");
    expect(display.amount).toBe("1.50");
  });
});
