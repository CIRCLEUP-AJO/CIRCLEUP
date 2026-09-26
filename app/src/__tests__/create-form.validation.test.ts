/**
 * Create-circle form validation tests (Issue #472, #471, #477).
 *
 * All logic imported directly from CreateClient.tsx — no duplication, no drift.
 *
 * Coverage:
 *   getFilledMembers        — trimming, blank filtering
 *   findDuplicateAddress    — unique / duplicate / case-insensitive detection
 *   countDecimalPlaces      — precision counting
 *   validateCreateForm      — every error branch + happy path:
 *       name:    empty, too long, valid, whitespace-only
 *       amount:  empty, zero, negative, too many decimals, sub-stroop, max, valid
 *       days:    empty, zero, fractional, over max, valid
 *       members: per-field bad address, lowercase, contract, muxed,
 *                checksum-invalid (Issue #477), too few, too many, duplicate, valid
 *   validateMemberEntry     — per-row messages for every failure mode
 *   submit guard            — invalid form never reaches wallet signing
 */

import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  getFilledMembers,
  findDuplicateAddress,
  countDecimalPlaces,
  validateCreateForm,
  validateMemberEntry,
  MIN_MEMBERS,
  MAX_MEMBERS,
  MAX_NAME_LENGTH,
  MAX_ROUND_DAYS,
  MAX_USDC_DECIMALS,
  type CreateFormErrors,
  type ValidatedCreateForm,
} from "../app/create/CreateClient";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Deterministic, checksum-valid G-addresses (Issue #477).
 *
 * Generated through the Stellar SDK so they satisfy *both* halves of address
 * validation: the base32 shape *and* the CRC16 strkey checksum.  A shape-only
 * fake such as `"G" + "A".repeat(55)` passes a regex but is rejected by
 * `validateCreateForm`.
 */
const addrFor = (seed: number): string =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();

const A = addrFor(1);
const B = addrFor(2);
const C = addrFor(3);

const VALID_ADDR_A = A;
const VALID_ADDR_B = B;

/** Same length and alphabet as `addr`, but one payload character mistyped. */
function withTypo(addr: string): string {
  const at = 20;
  return addr.slice(0, at) + (addr.charAt(at) === "A" ? "B" : "A") + addr.slice(at + 1);
}

/** Minimal valid form that passes all validation rules. */
const VALID = {
  name: "Family savings",
  members: [A, B],
  amount: "100",
  days: "30",
} as const;

function valid(overrides: {
  name?: string;
  members?: string[];
  amount?: string;
  days?: string;
} = {}) {
  return validateCreateForm(
    overrides.name ?? VALID.name,
    overrides.members ?? VALID.members,
    overrides.amount ?? VALID.amount,
    overrides.days ?? VALID.days,
  );
}

function assertErrors(result: ReturnType<typeof validateCreateForm>): CreateFormErrors {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

function assertOk(result: ReturnType<typeof validateCreateForm>): ValidatedCreateForm {
  if (!result.ok) {
    throw new Error(
      `Expected ok, got errors: ${JSON.stringify(result.errors, null, 2)}`,
    );
  }
  return result.values;
}

// ─── getFilledMembers ─────────────────────────────────────────────────────────

describe("getFilledMembers", () => {
  it("returns only non-blank entries", () => {
    expect(getFilledMembers(["", "  ", A])).toEqual([A]);
  });

  it("trims leading and trailing whitespace", () => {
    expect(getFilledMembers([`  ${A}  `])).toEqual([A]);
  });

  it("returns empty array when all inputs are blank", () => {
    expect(getFilledMembers(["", "", ""])).toEqual([]);
  });

  it("returns all entries when none are blank", () => {
    expect(getFilledMembers([A, B, C])).toEqual([A, B, C]);
  });

  it("preserves order", () => {
    expect(getFilledMembers([C, A, B])).toEqual([C, A, B]);
  });
});

// ─── findDuplicateAddress ─────────────────────────────────────────────────────

describe("findDuplicateAddress", () => {
  it("returns null when all addresses are unique", () => {
    expect(findDuplicateAddress([A, B, C])).toBeNull();
  });

  it("returns the first duplicated address", () => {
    expect(findDuplicateAddress([A, B, A])).toBe(A);
  });

  it("returns the first duplicate when multiple exist", () => {
    expect(findDuplicateAddress([A, B, A, B])).toBe(A);
  });

  it("returns null for an empty list", () => {
    expect(findDuplicateAddress([])).toBeNull();
  });

  it("detects duplicates case-insensitively", () => {
    const lowerA = VALID_ADDR_A.toLowerCase();
    // findDuplicateAddress returns the second occurrence which is lowerA
    expect(findDuplicateAddress([VALID_ADDR_A, lowerA])).toBe(lowerA);
  });

  it("returns null for a single address", () => {
    expect(findDuplicateAddress([A])).toBeNull();
  });
});

// ─── countDecimalPlaces ───────────────────────────────────────────────────────

describe("countDecimalPlaces", () => {
  it("returns 0 for an integer string", () => {
    expect(countDecimalPlaces("100")).toBe(0);
  });

  it("returns correct count for a decimal", () => {
    expect(countDecimalPlaces("1.5")).toBe(1);
  });

  it("strips trailing zeros before counting", () => {
    expect(countDecimalPlaces("1.5000")).toBe(1);
  });

  it("counts 7 significant decimal places", () => {
    expect(countDecimalPlaces("0.0000001")).toBe(7);
  });

  it("returns 0 for a string with no decimal point", () => {
    expect(countDecimalPlaces("42")).toBe(0);
  });
});

// ─── validateCreateForm — name ────────────────────────────────────────────────

describe("validateCreateForm — name", () => {
  it("errors when name is empty", () => {
    const errors = assertErrors(valid({ name: "" }));
    expect(errors.name).toMatch(/required/i);
  });

  it("errors when name is whitespace-only", () => {
    const errors = assertErrors(valid({ name: "   " }));
    expect(errors.name).toMatch(/required/i);
  });

  it(`errors when name exceeds ${MAX_NAME_LENGTH} characters`, () => {
    const errors = assertErrors(valid({ name: "A".repeat(MAX_NAME_LENGTH + 1) }));
    expect(errors.name).toMatch(/characters or fewer/i);
  });

  it(`accepts exactly ${MAX_NAME_LENGTH} characters`, () => {
    const values = assertOk(valid({ name: "A".repeat(MAX_NAME_LENGTH) }));
    expect(values.name).toBe("A".repeat(MAX_NAME_LENGTH));
  });

  it("accepts a name of 1 character", () => {
    const values = assertOk(valid({ name: "X" }));
    expect(values.name).toBe("X");
  });

  it("trims whitespace from the name", () => {
    const values = assertOk(valid({ name: "  My Circle  " }));
    expect(values.name).toBe("My Circle");
  });
});

// ─── validateCreateForm — amount ─────────────────────────────────────────────

describe("validateCreateForm — amount", () => {
  it("errors when amount is empty", () => {
    const errors = assertErrors(valid({ amount: "" }));
    expect(errors.amount).toMatch(/required/i);
  });

  it("errors when amount is zero", () => {
    const errors = assertErrors(valid({ amount: "0" }));
    expect(errors.amount).toMatch(/greater than zero/i);
  });

  it("errors when amount is 0.0", () => {
    const errors = assertErrors(valid({ amount: "0.0" }));
    expect(errors.amount).toMatch(/greater than zero/i);
  });

  it("errors when amount is whitespace", () => {
    const errors = assertErrors(valid({ amount: "   " }));
    expect(errors.amount).toBeDefined();
  });

  it(`errors when amount has more than ${MAX_USDC_DECIMALS} significant decimal places`, () => {
    const errors = assertErrors(valid({ amount: "1.12345678" }));
    expect(errors.amount).toMatch(/decimal places/i);
  });

  it("accepts the minimum 1-stroop amount (0.0000001 USDC)", () => {
    const values = assertOk(valid({ amount: "0.0000001" }));
    expect(values.amountStroops).toBe(1n);
  });

  it("accepts $100 and returns 1_000_000_000 stroops", () => {
    const values = assertOk(valid({ amount: "100" }));
    expect(values.amountStroops).toBe(1_000_000_000n);
  });

  it("accepts $42.5 and returns 425_000_000 stroops", () => {
    const values = assertOk(valid({ amount: "42.5" }));
    expect(values.amountStroops).toBe(425_000_000n);
  });

  it("errors when amount exceeds $1,000,000", () => {
    const errors = assertErrors(valid({ amount: "2000000" }));
    expect(errors.amount).toMatch(/exceeds/i);
  });
});

// ─── validateCreateForm — days ────────────────────────────────────────────────

describe("validateCreateForm — days", () => {
  it("errors when days is empty", () => {
    const errors = assertErrors(valid({ days: "" }));
    expect(errors.days).toMatch(/required/i);
  });

  it("errors when days is zero", () => {
    const errors = assertErrors(valid({ days: "0" }));
    expect(errors.days).toMatch(/at least 1/i);
  });

  it("errors when days is negative", () => {
    const errors = assertErrors(valid({ days: "-1" }));
    expect(errors.days).toBeDefined();
  });

  it("errors when days is fractional", () => {
    const errors = assertErrors(valid({ days: "14.5" }));
    expect(errors.days).toMatch(/whole number/i);
  });

  it(`errors when days exceeds ${MAX_ROUND_DAYS}`, () => {
    const errors = assertErrors(valid({ days: String(MAX_ROUND_DAYS + 1) }));
    expect(errors.days).toMatch(/cannot exceed/i);
  });

  it(`accepts exactly ${MAX_ROUND_DAYS} days`, () => {
    const values = assertOk(valid({ days: String(MAX_ROUND_DAYS) }));
    expect(values.roundDays).toBe(MAX_ROUND_DAYS);
  });

  it("accepts 1 day (minimum)", () => {
    const values = assertOk(valid({ days: "1" }));
    expect(values.roundDays).toBe(1);
  });

  it("passes the parsed integer through unmodified", () => {
    const values = assertOk(valid({ days: "30" }));
    expect(values.roundDays).toBe(30);
  });
});

// ─── validateCreateForm — members ────────────────────────────────────────────

describe("validateCreateForm — members", () => {
  it(`errors when fewer than ${MIN_MEMBERS} valid members provided`, () => {
    const errors = assertErrors(valid({ members: [A, ""] }));
    expect(errors.membersGeneral).toMatch(/at least/i);
  });

  it("errors when members list is entirely blank", () => {
    const errors = assertErrors(valid({ members: ["", ""] }));
    expect(errors.membersGeneral).toMatch(/at least/i);
  });

  it(`errors when more than ${MAX_MEMBERS} members are provided`, () => {
    const tooMany = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => addrFor(40 + i));
    const errors = assertErrors(valid({ members: tooMany }));
    expect(errors.membersGeneral).toMatch(/more than/i);
  });

  it("errors on a duplicate address", () => {
    const errors = assertErrors(valid({ members: [A, A] }));
    expect(errors.membersGeneral).toMatch(/duplicate/i);
  });

  it("errors when a filled address is not a valid G-address", () => {
    const errors = assertErrors(valid({ members: [A, "not-an-address"] }));
    expect(errors.members?.[1]).toMatch(/G-prefixed/i);
  });

  it("errors when a member address starts with C (contract ID, not a wallet)", () => {
    const contractAddr = "C" + "A".repeat(55);
    const errors = assertErrors(valid({ members: [A, contractAddr] }));
    expect(errors.members?.[1]).toMatch(/G-prefixed/i);
  });

  it("does not flag blank rows as per-field errors", () => {
    const result = valid({ members: [A, B, "", ""] });
    const values = assertOk(result);
    expect(values.validMembers).toEqual([A, B]);
  });

  it(`accepts exactly ${MIN_MEMBERS} valid members`, () => {
    const values = assertOk(valid({ members: [A, B] }));
    expect(values.validMembers).toEqual([A, B]);
  });

  it("strips blank rows from validMembers in the output", () => {
    const values = assertOk(valid({ members: [A, "", B, "  "] }));
    expect(values.validMembers).toEqual([A, B]);
  });

  it(`accepts up to ${MAX_MEMBERS} unique valid members`, () => {
    // MAX_MEMBERS distinct, checksum-valid addresses (Issue #477: shape alone
    // is not enough — every entry must carry a valid strkey checksum).
    const maxMembers = Array.from({ length: MAX_MEMBERS }, (_, i) => addrFor(20 + i));
    const values = assertOk(valid({ members: maxMembers }));
    expect(values.validMembers).toHaveLength(MAX_MEMBERS);
  });

  it("errors when a member address has a valid shape but a broken checksum", () => {
    // Same length, same alphabet, one payload character off: the regex passes,
    // the strkey checksum does not.
    const errors = assertErrors(valid({ members: [A, withTypo(B)] }));
    expect(errors.members?.[1]).toMatch(/checksum/i);
    expect(errors.members?.[0]).toBeUndefined();
  });

  it("errors when a member address is lowercase", () => {
    const errors = assertErrors(valid({ members: [A, B.toLowerCase()] }));
    expect(errors.members?.[1]).toMatch(/uppercase|case-sensitive/i);
  });

  it("errors when a member address is muxed (M…)", () => {
    const errors = assertErrors(valid({ members: [A, "M" + "A".repeat(55)] }));
    expect(errors.members?.[1]).toMatch(/muxed/i);
  });

  it("validates every member entry, not just the first", () => {
    const rows = [A, "nope", B, withTypo(C)];
    const errors = assertErrors(valid({ members: rows }));
    expect(errors.members).toHaveLength(4);
    expect(errors.members?.[0]).toBeUndefined();
    expect(errors.members?.[1]).toMatch(/^Member 2:/);
    expect(errors.members?.[2]).toBeUndefined();
    expect(errors.members?.[3]).toMatch(/^Member 4:/);
  });
});

// ─── validateCreateForm — multiple simultaneous errors ────────────────────────

describe("validateCreateForm — multiple simultaneous errors", () => {
  it("reports errors on all invalid fields at once", () => {
    const result = validateCreateForm("", ["", ""], "0", "0");
    const errors = assertErrors(result);
    expect(errors.name).toBeDefined();
    expect(errors.amount).toBeDefined();
    expect(errors.days).toBeDefined();
    expect(errors.membersGeneral).toBeDefined();
  });

  it("does not short-circuit — all fields checked even if name fails", () => {
    const result = validateCreateForm("", [A, "not-valid"], "-1", "abc");
    const errors = assertErrors(result);
    expect(errors.name).toBeDefined();
    expect(errors.amount).toBeDefined();
    expect(errors.days).toBeDefined();
    expect(errors.members?.[1]).toBeDefined();
  });
});

// ─── validateCreateForm — happy path ─────────────────────────────────────────

describe("validateCreateForm — valid submission", () => {
  it("returns ok:true with all valid inputs", () => {
    expect(valid().ok).toBe(true);
  });

  it("returns the trimmed name", () => {
    const values = assertOk(valid({ name: "  My Circle  " }));
    expect(values.name).toBe("My Circle");
  });

  it("returns the correct stroop amount for $100", () => {
    const values = assertOk(valid({ amount: "100" }));
    expect(values.amountStroops).toBe(1_000_000_000n);
  });

  it("returns the parsed round days integer", () => {
    const values = assertOk(valid({ days: "14" }));
    expect(values.roundDays).toBe(14);
  });

  it("returns only the filled members, trimmed", () => {
    const values = assertOk(valid({ members: [A, " ", B, ""] }));
    expect(values.validMembers).toEqual([A, B]);
  });
});

// ─── Submit-guard invariants ──────────────────────────────────────────────────

describe("validateCreateForm — submit guard invariants", () => {
  it("invalid form with duplicate addresses returns ok:false", () => {
    const result = validateCreateForm(VALID.name, [A, A], VALID.amount, VALID.days);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.membersGeneral).toMatch(/duplicate/i);
  });

  it("invalid precision is blocked — more than 7 decimal places", () => {
    const result = validateCreateForm(
      VALID.name,
      VALID.members,
      "0.000000001",
      VALID.days,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.amount).toMatch(/decimal places/i);
  });

  it("fractional day count is blocked", () => {
    const result = validateCreateForm(VALID.name, VALID.members, VALID.amount, "14.5");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.days).toMatch(/whole number/i);
  });

  it("empty circle name is blocked", () => {
    const result = validateCreateForm("", VALID.members, VALID.amount, VALID.days);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toMatch(/required/i);
  });

  it("round-trips: displayed amount matches submitted amount", () => {
    const values = assertOk(valid({ amount: "42.5" }));
    // 42.5 USDC = 425_000_000 stroops — no rounding or silent truncation
    expect(values.amountStroops).toBe(425_000_000n);
  });
});

// ─── validateMemberEntry — per-entry address validation (Issue #477) ──────────

describe("validateMemberEntry — every member entry is validated", () => {
  it("accepts a checksum-valid wallet address", () => {
    expect(validateMemberEntry(A, 0)).toBeUndefined();
  });

  it("ignores blank and whitespace-only rows", () => {
    expect(validateMemberEntry("", 0)).toBeUndefined();
    expect(validateMemberEntry("   ", 3)).toBeUndefined();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateMemberEntry(`  ${A}  `, 0)).toBeUndefined();
  });

  it("rejects a well-formed address with a broken checksum", () => {
    expect(validateMemberEntry(withTypo(A), 0)).toMatch(/checksum/i);
  });

  it("rejects a lowercase address", () => {
    expect(validateMemberEntry(A.toLowerCase(), 0)).toMatch(/uppercase/i);
  });

  it("rejects contract addresses with a namespace-specific message", () => {
    expect(validateMemberEntry("C" + "A".repeat(55), 0)).toMatch(/contract/i);
  });

  it("rejects muxed addresses with a namespace-specific message", () => {
    expect(validateMemberEntry("M" + "A".repeat(55), 0)).toMatch(/muxed/i);
  });

  it("rejects short or garbled input with the generic shape message", () => {
    expect(validateMemberEntry("not-an-address", 0)).toMatch(/G-prefixed.*56-character/i);
    expect(validateMemberEntry("GAAA1", 0)).toMatch(/G-prefixed.*56-character/i);
  });

  it("names the 1-based row of every problem", () => {
    expect(validateMemberEntry("nope", 0)).toMatch(/^Member 1:/);
    expect(validateMemberEntry("nope", 4)).toMatch(/^Member 5:/);
  });
});