/**
 * Create-circle form validation tests (Issue #472, #471).
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
 *       members: per-field bad address, too few, too many, duplicate, valid
 *   submit guard            — invalid form never reaches wallet signing
 */

import { describe, it, expect } from "vitest";
import {
  getFilledMembers,
  findDuplicateAddress,
  countDecimalPlaces,
  validateCreateForm,
  MIN_MEMBERS,
  MAX_MEMBERS,
  MAX_NAME_LENGTH,
  MAX_ROUND_DAYS,
  MAX_USDC_DECIMALS,
  type CreateFormErrors,
  type ValidatedCreateForm,
} from "../app/create/CreateClient";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Valid G-address: "G" + 55 identical uppercase base32 characters. */
const A = "G" + "A".repeat(55);
const B = "G" + "B".repeat(55);
const C = "G" + "C".repeat(55);

const VALID_ADDR_A = A;
const VALID_ADDR_B = B;

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
    const tooMany = Array.from(
      { length: MAX_MEMBERS + 1 },
      (_, i) => "G" + String.fromCharCode(65 + (i % 26)).repeat(55),
    );
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
    // Build MAX_MEMBERS unique addresses by varying the last character
    const maxMembers = Array.from(
      { length: MAX_MEMBERS },
      (_, i) => "G" + "A".repeat(54) + String.fromCharCode(65 + (i % 26)),
    );
    // Ensure uniqueness (character rotation may collide at 26+)
    const unique = [...new Set(maxMembers)];
    if (unique.length < MAX_MEMBERS) return; // skip if alphabet too small
    const values = assertOk(valid({ members: maxMembers }));
    expect(values.validMembers).toHaveLength(MAX_MEMBERS);
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
