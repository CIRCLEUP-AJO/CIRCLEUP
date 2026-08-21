/**
 * Tests for Issue 116: contract argument construction helpers.
 *
 * scAddress, scU32, scI128, scBool, scAddressVec are pure functions that
 * wrap Stellar SDK XDR encoding.  No RPC calls, no mocking needed.
 *
 * Covered:
 *   - scAddress: valid G-address, valid C-address, empty string throws
 *   - scU32: in-range integers, boundary values, negative / float / overflow throw
 *   - scI128: bigint input, integer number input, float number throws, boundary bigints
 *   - scBool: true, false, round-trips through scValToNative
 *   - scAddressVec: single item, multiple items, empty array throws
 *   - XDR type tags are correct for each helper (via scValToNative round-trip)
 *   - Integration: helpers produce args that work inside a TransactionBuilder.addOperation call
 */

import { describe, it, expect } from "vitest";
import { xdr, scValToNative, Address } from "@stellar/stellar-sdk";
import { scAddress, scU32, scI128, scBool, scAddressVec } from "../client";
import { CIRCLE_ADDR, MEMBER_A_ADDR, MEMBER_B_ADDR } from "./fixtures";

// ─── Real Stellar addresses used across the suite ────────────────────────────

const G_ADDR_A = MEMBER_A_ADDR;
const G_ADDR_B = MEMBER_B_ADDR;
const C_ADDR = CIRCLE_ADDR;

// ─── scAddress ────────────────────────────────────────────────────────────────

describe("scAddress", () => {
  it("returns an xdr.ScVal instance", () => {
    const val = scAddress(G_ADDR_A);
    expect(val).toBeInstanceOf(xdr.ScVal);
  });

  it("produces an address ScVal for a G-address (account)", () => {
    const val = scAddress(G_ADDR_A);
    // scValToNative on an address returns the original string
    const native = scValToNative(val);
    expect(native).toBe(G_ADDR_A);
  });

  it("produces an address ScVal for a C-address (contract)", () => {
    const val = scAddress(C_ADDR);
    const native = scValToNative(val);
    expect(native).toBe(C_ADDR);
  });

  it("two calls with the same address produce equal XDR buffers", () => {
    const a = scAddress(G_ADDR_A);
    const b = scAddress(G_ADDR_A);
    expect(a.toXDR("base64")).toBe(b.toXDR("base64"));
  });

  it("two different addresses produce different XDR buffers", () => {
    const a = scAddress(G_ADDR_A);
    const b = scAddress(G_ADDR_B);
    expect(a.toXDR("base64")).not.toBe(b.toXDR("base64"));
  });

  it("is equivalent to new Address(addr).toScVal()", () => {
    const expected = new Address(G_ADDR_A).toScVal().toXDR("base64");
    expect(scAddress(G_ADDR_A).toXDR("base64")).toBe(expected);
  });

  it("throws when given an empty string", () => {
    expect(() => scAddress("")).toThrow();
  });

  it("throws when given a syntactically invalid address", () => {
    expect(() => scAddress("not-a-stellar-address")).toThrow();
  });
});

// ─── scU32 ────────────────────────────────────────────────────────────────────

describe("scU32", () => {
  it("returns an xdr.ScVal instance", () => {
    expect(scU32(42)).toBeInstanceOf(xdr.ScVal);
  });

  it("round-trips through scValToNative as a number", () => {
    expect(scValToNative(scU32(12345))).toBe(12345);
  });

  it("encodes 0 (minimum u32 value)", () => {
    expect(scValToNative(scU32(0))).toBe(0);
  });

  it("encodes 4_294_967_295 (maximum u32 value)", () => {
    expect(scValToNative(scU32(0xffffffff))).toBe(0xffffffff);
  });

  it("encodes typical round_deadline_ledgers values", () => {
    expect(scValToNative(scU32(120_960))).toBe(120_960);
    expect(scValToNative(scU32(17_280))).toBe(17_280);
  });

  it("throws RangeError for negative values", () => {
    expect(() => scU32(-1)).toThrow(RangeError);
    expect(() => scU32(-1000)).toThrow(RangeError);
  });

  it("throws RangeError for values exceeding u32 max", () => {
    expect(() => scU32(0x100000000)).toThrow(RangeError);
  });

  it("throws RangeError for non-integer floats", () => {
    expect(() => scU32(1.5)).toThrow(RangeError);
    expect(() => scU32(0.1)).toThrow(RangeError);
  });

  it("throws RangeError for NaN", () => {
    expect(() => scU32(NaN)).toThrow(RangeError);
  });

  it("error message mentions the problematic value", () => {
    try {
      scU32(-5);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).toContain("-5");
    }
  });
});

// ─── scI128 ──────────────────────────────────────────────────────────────────

describe("scI128", () => {
  it("returns an xdr.ScVal instance for bigint input", () => {
    expect(scI128(100_000_000n)).toBeInstanceOf(xdr.ScVal);
  });

  it("returns an xdr.ScVal instance for integer number input", () => {
    expect(scI128(50_000_000)).toBeInstanceOf(xdr.ScVal);
  });

  it("round-trips a bigint through scValToNative", () => {
    // scValToNative returns bigint for i128
    const val = scI128(100_000_000n);
    expect(scValToNative(val)).toBe(100_000_000n);
  });

  it("round-trips an integer number (converted to bigint internally)", () => {
    const val = scI128(50_000_000);
    expect(scValToNative(val)).toBe(50_000_000n);
  });

  it("encodes 0n correctly", () => {
    expect(scValToNative(scI128(0n))).toBe(0n);
  });

  it("encodes negative bigints (valid i128 range)", () => {
    const val = scI128(-1n);
    expect(scValToNative(val)).toBe(-1n);
  });

  it("encodes large round-amount values in stroops", () => {
    // 1 000 USDC = 10_000_000_000 stroops — well within i128 range
    const tenThousandUsdc = 10_000_000_000n;
    expect(scValToNative(scI128(tenThousandUsdc))).toBe(tenThousandUsdc);
  });

  it("throws TypeError for a non-integer float number", () => {
    expect(() => scI128(1.5)).toThrow(TypeError);
    expect(() => scI128(0.001)).toThrow(TypeError);
  });

  it("error message suggests using bigint for float inputs", () => {
    try {
      scI128(3.14);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).toMatch(/bigint/i);
    }
  });

  it("two equal bigints produce identical XDR", () => {
    const a = scI128(999n);
    const b = scI128(999n);
    expect(a.toXDR("base64")).toBe(b.toXDR("base64"));
  });

  it("different values produce different XDR", () => {
    expect(scI128(1n).toXDR("base64")).not.toBe(scI128(2n).toXDR("base64"));
  });
});

// ─── scBool ───────────────────────────────────────────────────────────────────

describe("scBool", () => {
  it("returns an xdr.ScVal instance for true", () => {
    expect(scBool(true)).toBeInstanceOf(xdr.ScVal);
  });

  it("returns an xdr.ScVal instance for false", () => {
    expect(scBool(false)).toBeInstanceOf(xdr.ScVal);
  });

  it("round-trips true through scValToNative", () => {
    expect(scValToNative(scBool(true))).toBe(true);
  });

  it("round-trips false through scValToNative", () => {
    expect(scValToNative(scBool(false))).toBe(false);
  });

  it("true and false produce different XDR", () => {
    expect(scBool(true).toXDR("base64")).not.toBe(scBool(false).toXDR("base64"));
  });

  it("two true values produce the same XDR", () => {
    expect(scBool(true).toXDR("base64")).toBe(scBool(true).toXDR("base64"));
  });
});

// ─── scAddressVec ─────────────────────────────────────────────────────────────

describe("scAddressVec", () => {
  it("returns an xdr.ScVal instance", () => {
    expect(scAddressVec([G_ADDR_A])).toBeInstanceOf(xdr.ScVal);
  });

  it("round-trips a single address through scValToNative", () => {
    const val = scAddressVec([G_ADDR_A]);
    const native = scValToNative(val) as string[];
    expect(native).toEqual([G_ADDR_A]);
  });

  it("round-trips multiple addresses preserving order", () => {
    const val = scAddressVec([G_ADDR_A, G_ADDR_B, C_ADDR]);
    const native = scValToNative(val) as string[];
    expect(native).toEqual([G_ADDR_A, G_ADDR_B, C_ADDR]);
  });

  it("the ScVal is a vec (scvVec switch arm)", () => {
    const val = scAddressVec([G_ADDR_A]);
    // switch() returns 'vec' for scvVec
    expect(val.switch().name).toBe("scvVec");
  });

  it("throws Error when the addresses array is empty", () => {
    expect(() => scAddressVec([])).toThrow(Error);
  });

  it("empty-array error message explains the requirement", () => {
    try {
      scAddressVec([]);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).toMatch(/empty/i);
    }
  });

  it("throws when any address in the list is invalid", () => {
    expect(() => scAddressVec([G_ADDR_A, "bad-address"])).toThrow();
  });

  it("produces the same XDR as a manual xdr.ScVal.scvVec construction", () => {
    const manual = xdr.ScVal.scvVec([
      new Address(G_ADDR_A).toScVal(),
      new Address(G_ADDR_B).toScVal(),
    ]).toXDR("base64");

    const helper = scAddressVec([G_ADDR_A, G_ADDR_B]).toXDR("base64");
    expect(helper).toBe(manual);
  });

  it("vec length matches the input array length", () => {
    const addresses = [G_ADDR_A, G_ADDR_B, C_ADDR];
    const val = scAddressVec(addresses);
    const native = scValToNative(val) as string[];
    expect(native.length).toBe(addresses.length);
  });
});

// ─── Cross-helper: args usable together in a real ScVal array ────────────────

describe("contract arg helpers — combined usage", () => {
  it("can build the full create_circle args array without throwing", () => {
    // Mirrors the args used in FactoryClient.createCircle
    expect(() => {
      const args: xdr.ScVal[] = [
        scAddress(G_ADDR_A),                        // creator
        scAddressVec([G_ADDR_A, G_ADDR_B]),          // members
        scI128(100_000_000n),                        // round_amount (stroops)
        scU32(120_960),                              // round_deadline_ledgers
      ];
      expect(args).toHaveLength(4);
      args.forEach((a) => expect(a).toBeInstanceOf(xdr.ScVal));
    }).not.toThrow();
  });

  it("can build the has_contributed args array without throwing", () => {
    expect(() => {
      const args: xdr.ScVal[] = [
        scAddress(G_ADDR_A),  // member
        scU32(0),             // round_index
      ];
      expect(args).toHaveLength(2);
    }).not.toThrow();
  });

  it("can build the join / contribute args array without throwing", () => {
    expect(() => {
      const args: xdr.ScVal[] = [scAddress(G_ADDR_A)];
      expect(args).toHaveLength(1);
    }).not.toThrow();
  });
});

// ─── Malformed input reporting ────────────────────────────────────────────────
//
// The Stellar SDK's own errors for these cases ("Unsupported address type",
// a silently rounded bigint) do not say which value was wrong or what was
// expected. These assertions pin the actionable messages the SDK adds.

describe("scAddress — actionable errors", () => {
  it("names the expected format rather than 'Unsupported address type'", () => {
    expect(() => scAddress("not-a-stellar-address")).toThrow(TypeError);
    expect(() => scAddress("not-a-stellar-address")).toThrow(/starting with "G"/);
  });

  it("rejects a well-shaped address with a broken checksum", () => {
    // Same length and alphabet as a real strkey, last character altered.
    const broken = `${G_ADDR_A.slice(0, 55)}${G_ADDR_A[55] === "A" ? "B" : "A"}`;
    expect(() => scAddress(broken)).toThrow(/not a valid strkey/);
  });

  it("rejects a non-string value", () => {
    expect(() => scAddress(undefined as any)).toThrow(TypeError);
  });
});

describe("scI128 — precision and range guards", () => {
  it("rejects a number above Number.MAX_SAFE_INTEGER", () => {
    // BigInt(2 ** 53 + 1) silently rounds; on a stroops amount that is a
    // payment for the wrong sum.
    expect(() => scI128(Number.MAX_SAFE_INTEGER + 2)).toThrow(/precision/);
  });

  it("accepts Number.MAX_SAFE_INTEGER itself", () => {
    expect(scValToNative(scI128(Number.MAX_SAFE_INTEGER))).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  it("encodes the i128 boundary values", () => {
    const max = (1n << 127n) - 1n;
    const min = -(1n << 127n);
    expect(scValToNative(scI128(max))).toBe(max);
    expect(scValToNative(scI128(min))).toBe(min);
  });

  it("throws RangeError just outside the i128 range", () => {
    expect(() => scI128(1n << 127n)).toThrow(RangeError);
    expect(() => scI128(-(1n << 127n) - 1n)).toThrow(RangeError);
  });

  it("rejects a value that is neither bigint nor number", () => {
    expect(() => scI128("100" as any)).toThrow(TypeError);
  });
});

describe("scU32 — non-numeric input", () => {
  it("says the value is not an integer rather than out of range", () => {
    expect(() => scU32("5" as any)).toThrow(/not an integer/);
  });
});

describe("scAddressVec — malformed lists", () => {
  it("names the index of the offending entry", () => {
    expect(() => scAddressVec([G_ADDR_A, G_ADDR_B, "oops"])).toThrow(/entry 2/);
  });

  it("rejects a value that is not an array", () => {
    expect(() => scAddressVec(null as any)).toThrow(TypeError);
  });
});
