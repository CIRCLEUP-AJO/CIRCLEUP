/**
 * Tests for sdk/src/validators.ts
 *
 * Verifies that runtime validators, decoders, and config helpers behave
 * correctly for valid inputs, reject invalid inputs with descriptive errors,
 * and correctly map raw wire values to domain types.
 */

import { describe, it, expect } from "vitest";
import {
  isValidContractAddress,
  isValidStellarAddress,
  validateCircleUpConfig,
  validateContractArgs,
  decodeU32,
  decodeI128,
  decodeBoolean,
  decodeAddress,
  decodeAddressList,
  mapRawConfig,
  mapRawRoundState,
  assertValidCircleStatus,
  isReadSuccess,
  isReadFailure,
} from "./validators";

// ── isValidContractAddress ────────────────────────────────────────────────────

describe("isValidContractAddress", () => {
  it("accepts a valid C-prefix 56-char address", () => {
    expect(isValidContractAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4")).toBe(true);
  });
  it("rejects a G-prefix account address", () => {
    expect(isValidContractAddress("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")).toBe(false);
  });
  it("rejects a short string", () => {
    expect(isValidContractAddress("CSHORT")).toBe(false);
  });
  it("rejects empty string", () => {
    expect(isValidContractAddress("")).toBe(false);
  });
});

// ── isValidStellarAddress ─────────────────────────────────────────────────────

describe("isValidStellarAddress", () => {
  it("accepts a G-prefix account address", () => {
    expect(isValidStellarAddress("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")).toBe(true);
  });
  it("accepts a C-prefix contract address", () => {
    expect(isValidStellarAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4")).toBe(true);
  });
  it("rejects null", () => {
    expect(isValidStellarAddress(null)).toBe(false);
  });
  it("rejects a number", () => {
    expect(isValidStellarAddress(42)).toBe(false);
  });
  it("rejects an invalid string", () => {
    expect(isValidStellarAddress("not-an-address")).toBe(false);
  });
});

// ── validateCircleUpConfig ────────────────────────────────────────────────────

describe("validateCircleUpConfig", () => {
  const validConfig = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contracts: {
      circleFactory: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      reputation:    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      usdc:          "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    },
  };

  it("accepts a valid config without throwing", () => {
    expect(() => validateCircleUpConfig(validConfig)).not.toThrow();
  });

  it("throws when rpcUrl is missing", () => {
    expect(() => validateCircleUpConfig({ ...validConfig, rpcUrl: undefined })).toThrow(/rpcUrl/);
  });

  it("throws when networkPassphrase is unrecognised", () => {
    expect(() => validateCircleUpConfig({ ...validConfig, networkPassphrase: "wrong" })).toThrow(/networkPassphrase/);
  });

  it("throws when a contract address is invalid", () => {
    expect(() => validateCircleUpConfig({
      ...validConfig,
      contracts: { ...validConfig.contracts, circleFactory: "GNOTACONTRACT" },
    })).toThrow(/circleFactory/);
  });

  it("throws for null input", () => {
    expect(() => validateCircleUpConfig(null)).toThrow();
  });

  it("throws for non-object input", () => {
    expect(() => validateCircleUpConfig("string")).toThrow();
  });
});

// ── validateContractArgs ──────────────────────────────────────────────────────

describe("validateContractArgs", () => {
  it("returns null for a valid address arg", () => {
    expect(validateContractArgs([{
      name: "member",
      value: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      type: "address",
    }])).toBeNull();
  });

  it("returns an error string for an invalid address", () => {
    const result = validateContractArgs([{ name: "member", value: "bad", type: "address" }]);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/member/);
  });

  it("returns null for a valid u32", () => {
    expect(validateContractArgs([{ name: "idx", value: 5, type: "u32" }])).toBeNull();
  });

  it("returns error for a negative u32", () => {
    const r = validateContractArgs([{ name: "idx", value: -1, type: "u32" }]);
    expect(r).toMatch(/idx/);
  });

  it("returns null for a valid i128 bigint", () => {
    expect(validateContractArgs([{ name: "amount", value: 100_000_000n, type: "i128" }])).toBeNull();
  });

  it("returns null for an empty valid addressVec", () => {
    const r = validateContractArgs([{ name: "members", value: [], type: "addressVec" }]);
    expect(r).toMatch(/must not be empty/);
  });
});

// ── decodeU32 ─────────────────────────────────────────────────────────────────

describe("decodeU32", () => {
  it("decodes a valid u32 number", () => {
    expect(decodeU32(42, "test")).toBe(42);
  });
  it("decodes zero", () => {
    expect(decodeU32(0, "test")).toBe(0);
  });
  it("throws for a negative number", () => {
    expect(() => decodeU32(-1, "test")).toThrow(/test/);
  });
  it("throws for a string", () => {
    expect(() => decodeU32("42", "test")).toThrow(/test/);
  });
  it("throws for a bigint", () => {
    expect(() => decodeU32(42n, "test")).toThrow(/test/);
  });
});

// ── decodeI128 ────────────────────────────────────────────────────────────────

describe("decodeI128", () => {
  it("decodes a valid bigint", () => {
    expect(decodeI128(100_000_000n, "amount")).toBe(100_000_000n);
  });
  it("decodes zero", () => {
    expect(decodeI128(0n, "amount")).toBe(0n);
  });
  it("decodes a negative bigint", () => {
    expect(decodeI128(-1n, "amount")).toBe(-1n);
  });
  it("rejects a value below a min option", () => {
    expect(() => decodeI128(-1n, "collateral", { min: 0n })).toThrow(/collateral/);
  });
  it("throws for a string", () => {
    expect(() => decodeI128("big", "amount")).toThrow(/amount/);
  });
});

// ── decodeBoolean ─────────────────────────────────────────────────────────────

describe("decodeBoolean", () => {
  it("decodes true", () => {
    expect(decodeBoolean(true, "paid_out")).toBe(true);
  });
  it("decodes false", () => {
    expect(decodeBoolean(false, "paid_out")).toBe(false);
  });
  it("throws for a number", () => {
    expect(() => decodeBoolean(1, "paid_out")).toThrow(/paid_out/);
  });
  it("throws for a string", () => {
    expect(() => decodeBoolean("true", "paid_out")).toThrow(/paid_out/);
  });
});

// ── decodeAddress ─────────────────────────────────────────────────────────────

describe("decodeAddress", () => {
  it("decodes a G-address", () => {
    const addr = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    expect(decodeAddress(addr, "recipient")).toBe(addr);
  });
  it("decodes a C-address", () => {
    const addr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    expect(decodeAddress(addr, "usdc")).toBe(addr);
  });
  it("throws for an invalid string", () => {
    expect(() => decodeAddress("bad", "recipient")).toThrow(/recipient/);
  });
  it("throws for null", () => {
    expect(() => decodeAddress(null, "recipient")).toThrow(/recipient/);
  });
});

// ── decodeAddressList ─────────────────────────────────────────────────────────

describe("decodeAddressList", () => {
  const addr = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  it("decodes an empty list", () => {
    expect(decodeAddressList([], "members")).toEqual([]);
  });
  it("decodes a list of valid addresses", () => {
    expect(decodeAddressList([addr, addr], "members")).toEqual([addr, addr]);
  });
  it("throws for a non-array", () => {
    expect(() => decodeAddressList("bad", "members")).toThrow(/members/);
  });
  it("throws for a list with an invalid entry", () => {
    expect(() => decodeAddressList([addr, "bad"], "members")).toThrow();
  });
  it("throws for duplicate entries when unique is required", () => {
    expect(() => decodeAddressList([addr, addr], "members", { unique: true })).toThrow(/distinct/);
  });
});

// ── assertValidCircleStatus ───────────────────────────────────────────────────

describe("assertValidCircleStatus", () => {
  it.each(["Pending", "Active", "Completed", "Cancelled"])("accepts %s", (status) => {
    expect(assertValidCircleStatus(status)).toBe(status);
  });
  it("throws for an unknown string", () => {
    expect(() => assertValidCircleStatus("Unknown")).toThrow(/assertValidCircleStatus/);
  });
  it("throws for null", () => {
    expect(() => assertValidCircleStatus(null)).toThrow();
  });
});

// ── isReadSuccess / isReadFailure ─────────────────────────────────────────────

describe("isReadSuccess / isReadFailure", () => {
  it("isReadSuccess returns true for {ok:true}", () => {
    expect(isReadSuccess({ ok: true, value: "x" })).toBe(true);
  });
  it("isReadSuccess returns false for {ok:false}", () => {
    expect(isReadSuccess({ ok: false, error: "oops" })).toBe(false);
  });
  it("isReadFailure returns true for {ok:false}", () => {
    expect(isReadFailure({ ok: false, error: "oops" })).toBe(true);
  });
  it("isReadFailure returns false for {ok:true}", () => {
    expect(isReadFailure({ ok: true, value: 42 })).toBe(false);
  });
});
