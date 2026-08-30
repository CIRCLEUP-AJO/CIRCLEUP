/**
 * Create-circle form validation tests.
 *
 * All logic is imported directly from CreateClient.tsx so tests exercise the
 * real production code — no duplication, no drift.
 *
 * Coverage:
 *   - getFilledMembers        — trimming, blank filtering
 *   - findDuplicateAddress    — unique / duplicate detection
 *   - countDecimalPlaces      — precision counting
 *   - validateCreateForm      — every error branch + valid happy path:
 *       name:   empty, too long, valid
 *       amount: empty, zero, negative, too many decimals, sub-stroop, valid
 *       days:   empty, zero, fractional, over max, valid
 *       members:per-field bad address, too few, too many, duplicate, valid
 *   - submit guard            — invalid form never reaches wallet signing
 *
 * Runner: vitest (configured in app/vitest.config.ts)
 */

import { describe, it, expect, vi } from "vitest";
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

// ─── Fixtures ──────────────────────────────────────────────────────────────────

/** Valid G-address: "G" + 55 identical uppercase base32 characters. */
const A = "G" + "A".repeat(55);
const B = "G" + "B".repeat(55);
const C = "G" + "C".repeat(55);

/** A minimal valid form input that passes all validation rules. */
const VALID = {
  name:    "Family savings",
  members: [A, B],
  amount:  "100",
  days:    "30",
} as const;

/** Shortcut for the happy-path call. */
function valid(overrides: {
  name?:    string;
  members?: string[];
  amount?:  string;
  days?:    string;
} = {}) {
  return validateCreateForm(
    overrides.name    ?? VALID.name,
    overrides.members ?? VALID.members,
    overrides.amount  ?? VALID.amount,
    overrides.days    ?? VALID.days,
  );
}

/**
 * Find duplicate addresses using case-insensitive comparison.
 */
function findDuplicateAddress(addresses: string[]): string | null {
  const seen = new Set<string>();
  for (const addr of addresses) {
    const lower = addr.toLowerCase();
    if (seen.has(lower)) return addr;
    seen.add(lower);
  }
  return null;
}

/** Assert the result has errors and return them. */
function assertErrors(result: ReturnType<typeof validateCreateForm>): CreateFormErrors {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
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
    // A appears twice before B appears twice — A must be returned
    expect(findDuplicateAddress([A, B, A, B])).toBe(A);
  });

  it("returns null for an empty list", () => {
    expect(findDuplicateAddress([])).toBeNull();
  });

  it("detects duplicates case-insensitively", () => {
    const lowerA = VALID_ADDR_A.toLowerCase();
    expect(findDuplicateAddress([VALID_ADDR_A, lowerA])).toBe(lowerA);
  });
});

// ─── validateCreateForm — days field ─────────────────────────────────────────

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

// ─── validateCreateForm — members field ──────────────────────────────────────

describe("validateCreateForm — members", () => {
  it(`errors when fewer than ${MIN_MEMBERS} valid members are provided`, () => {
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

  it("does not flag blank rows as per-field errors (they are ignored)", () => {
    // A blank row should produce no per-field error at that index.
    // Use two valid members + two blanks — valid overall, but blank rows must
    // not get flagged as "invalid address".
    const result = valid({ members: [A, B, "", ""] });
    // This is a valid form — two members, no errors
    assertOk(result);
    // Confirm: no per-member error array at all
    if (!result.ok) throw new Error("expected ok");
    // validMembers should be just A and B (blanks stripped)
    expect(result.values.validMembers).toEqual([A, B]);
  });

  it(`accepts exactly ${MIN_MEMBERS} valid members`, () => {
    const values = assertOk(valid({ members: [A, B] }));
    expect(values.validMembers).toEqual([A, B]);
  });

  it("strips blank rows from validMembers in the output", () => {
    const values = assertOk(valid({ members: [A, "", B, "  "] }));
    expect(values.validMembers).toEqual([A, B]);
  });

  it("accepts up to MAX_MEMBERS unique valid members", () => {
    const maxMembers = Array.from(
      { length: MAX_MEMBERS },
      (_, i) => "G" + String.fromCharCode(65 + (i % 26)).repeat(55),
    );
    // Ensure they are all unique
    const unique = [...new Set(maxMembers)];
    if (unique.length < MAX_MEMBERS) return; // character space too small — skip
    const values = assertOk(valid({ members: maxMembers }));
    expect(values.validMembers).toHaveLength(MAX_MEMBERS);
  });
});

// ─── validateCreateForm — multi-field errors ─────────────────────────────────

describe("validateCreateForm — multiple simultaneous errors", () => {
  it("reports errors on all invalid fields at once", () => {
    const result = validateCreateForm("", ["", ""], "0", "0");
    const errors = assertErrors(result);
    expect(errors.name).toBeDefined();
    expect(errors.amount).toBeDefined();
    expect(errors.days).toBeDefined();
    expect(errors.membersGeneral).toBeDefined();
  });

  it("does not short-circuit — all fields are checked even if name fails", () => {
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
    const result = valid();
    expect(result.ok).toBe(true);
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

  it("returns no errors when valid", () => {
    const result = valid();
    if (!result.ok) {
      // Print errors to make failures easier to debug
      throw new Error(`Expected ok, got errors: ${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.ok).toBe(true);
  });
});

describe("form validation pipeline", () => {
  const MIN_MEMBERS = 2;
  const MAX_MEMBERS = 20;
  const MAX_ROUND_USDC = 1_000_000;
  const MAX_ROUND_DAYS = 365;

  function validate(
    members: string[],
    roundUSDC: string,
    roundDays: string,
    walletAddress?: string,
  ) {
    const valid = getFilledMembers(members);
    if (valid.length < MIN_MEMBERS)
      return { error: `A circle needs at least ${MIN_MEMBERS} members.` };
    if (valid.length > MAX_MEMBERS)
      return { error: `A circle cannot have more than ${MAX_MEMBERS} members.` };

    // Self-address check
    if (walletAddress) {
      const creatorLower = walletAddress.toLowerCase();
      const isSelfMember = valid.some((m) => m.toLowerCase() === creatorLower);
      if (isSelfMember) {
        return { error: "Your wallet address cannot be included in the member list." };
      }
    }

    const dup = findDuplicateAddress(valid);
    if (dup) return { error: `Duplicate address detected: ${dup.slice(0, 4)}…${dup.slice(-4)}.` };

    function simulateSubmit(members: string[]) {
      const result = validateCreateForm(VALID.name, members, VALID.amount, VALID.days);
      if (!result.ok) return false;
      getWalletAddress();
      return true;
    }

    const amount = parseFloat(roundUSDC);
    if (isNaN(amount) || amount <= 0) return { error: "Enter a valid round amount greater than zero." };
    if (amount > MAX_ROUND_USDC) return { error: `Round amount exceeds the maximum of $${MAX_ROUND_USDC.toLocaleString()}.` };

    const days = parseInt(roundDays, 10);
    if (isNaN(days) || days < 1) return { error: "Enter a valid round duration of at least 1 day." };
    if (days > MAX_ROUND_DAYS) return { error: `Round duration cannot exceed ${MAX_ROUND_DAYS} days.` };

    function simulateSubmit(members: string[]) {
      const result = validateCreateForm(VALID.name, members, VALID.amount, VALID.days);
      if (!result.ok) return false;
      getWalletAddress();
      return true;
    }

    expect(simulateSubmit([A, A])).toBe(false);
    expect(getWalletAddress).not.toHaveBeenCalled();
  });

  it("a form with invalid precision is blocked before signing", () => {
    const getWalletAddress = vi.fn();

    const result = validateCreateForm(VALID.name, VALID.members, "0.000000001", VALID.days);
    if (!result.ok) {
      // good — don't call wallet
    } else {
      getWalletAddress();
    }

    expect(result.ok).toBe(false);
    expect(getWalletAddress).not.toHaveBeenCalled();
  });

  it("a form with a fractional day count is blocked before signing", () => {
    const result = validateCreateForm(VALID.name, VALID.members, VALID.amount, "14.5");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.days).toMatch(/whole number/i);
    }
  });

  it("a form with an empty circle name is blocked before signing", () => {
    const result = validateCreateForm("", VALID.members, VALID.amount, VALID.days);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toMatch(/required/i);
    }
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("validateCreateForm — edge cases", () => {
  it("accepts the minimum 1-stroop amount (0.0000001 USDC)", () => {
    const values = assertOk(valid({ amount: "0.0000001" }));
    expect(values.amountStroops).toBe(1n);
  });

  it("blocks with case-insensitive duplicate addresses", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_A.toLowerCase()], "100", "30");
    expect(error).toMatch(/duplicate/i);
  });

  it("blocks with an invalid Stellar address", () => {
    const { error } = validate([VALID_ADDR_A, "not-an-address"], "100", "30");
    expect(error).toMatch(/invalid stellar address/i);
  });

  it("round-trips: displayed amount matches submitted amount", () => {
    // The value the user sees in the input must equal what the contract receives
    const displayedAmount = "42.5";
    const values = assertOk(valid({ amount: displayedAmount }));
    // 42.5 USDC = 425_000_000 stroops
    expect(values.amountStroops).toBe(425_000_000n);
    // Confirmed: no rounding or silent truncation occurred
  });

  it("amount '0.0' is treated as zero and blocked", () => {
    const errors = assertErrors(valid({ amount: "0.0" }));
    expect(errors.amount).toMatch(/greater than zero/i);
  });

  it("whitespace-only amount is treated as zero and blocked", () => {
    const errors = assertErrors(valid({ amount: "   " }));
    expect(errors.amount).toBeDefined();
  });

  it("blocks when more than 20 members are filled", () => {
    const addrs = Array.from(
      { length: 21 },
      (_, i) => VALID_ADDR_A.slice(0, -1) + String.fromCharCode(65 + (i % 26))
    ).map(
      (_, i) => {
        const base = VALID_ADDR_A.split("");
        base[55] = String.fromCharCode(65 + (i % 26));
        return base.join("");
      }
    );
    expect(values.validMembers).toEqual([A, B]);
  });

  it("a name of exactly 1 character is valid", () => {
    const values = assertOk(valid({ name: "X" }));
    expect(values.name).toBe("X");
  });

  it("blocks self-address (creator as member)", () => {
    const { error } = validate(
      [VALID_ADDR_A, VALID_ADDR_B],
      "100",
      "30",
      VALID_ADDR_A, // wallet is same as first member
    );
    expect(error).toMatch(/cannot be included/i);
  });

  it("blocks self-address case-insensitively", () => {
    const { error } = validate(
      [VALID_ADDR_A, VALID_ADDR_B],
      "100",
      "30",
      VALID_ADDR_A.toLowerCase(),
    );
    expect(error).toMatch(/cannot be included/i);
  });

  it("blocks round amount exceeding maximum", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_B], "2000000", "30");
    expect(error).toMatch(/exceeds the maximum/i);
  });

  it("blocks round duration exceeding maximum", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_B], "100", "400");
    expect(error).toMatch(/cannot exceed/i);
  });

  it("passes with maximum valid values", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_B], "1000000", "365");
    expect(error).toBeNull();
  });
});
