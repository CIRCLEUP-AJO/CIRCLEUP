/**
 * Validates the form-level rules embedded in CreateClient without rendering
 * the full component. Extracts the same logic functions so they can be tested
 * deterministically without a live wallet or router.
 */
import { describe, it, expect } from "vitest";

// ── Extracted logic (mirrors CreateClient.tsx) ────────────────────────────────

function getFilledMembers(members: string[]): string[] {
  return members.map((m) => m.trim()).filter((m) => m.length > 0);
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

function isValidStellarAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
}

// 56-char base32 G-addresses (G + 55 uppercase letters, all in valid [A-Z2-7] range)
const VALID_ADDR_A = "G" + "A".repeat(55);
const VALID_ADDR_B = "G" + "B".repeat(55);
const VALID_ADDR_C = "G" + "C".repeat(55);

describe("getFilledMembers", () => {
  it("filters out blank entries", () => {
    expect(getFilledMembers(["", "  ", VALID_ADDR_A])).toEqual([VALID_ADDR_A]);
  });

  it("trims whitespace from addresses", () => {
    expect(getFilledMembers([`  ${VALID_ADDR_A}  `])).toEqual([VALID_ADDR_A]);
  });

  it("returns empty array when all inputs are blank", () => {
    expect(getFilledMembers(["", "", ""])).toEqual([]);
  });
});

describe("findDuplicateAddress", () => {
  it("returns null when all addresses are unique", () => {
    expect(findDuplicateAddress([VALID_ADDR_A, VALID_ADDR_B])).toBeNull();
  });

  it("returns the duplicated address", () => {
    expect(
      findDuplicateAddress([VALID_ADDR_A, VALID_ADDR_B, VALID_ADDR_A])
    ).toBe(VALID_ADDR_A);
  });

  it("returns null for an empty list", () => {
    expect(findDuplicateAddress([])).toBeNull();
  });

  it("detects duplicates case-insensitively", () => {
    const lowerA = VALID_ADDR_A.toLowerCase();
    expect(findDuplicateAddress([VALID_ADDR_A, lowerA])).toBe(lowerA);
  });
});

describe("isValidStellarAddress", () => {
  it("accepts a valid G-address of 56 characters", () => {
    expect(isValidStellarAddress(VALID_ADDR_A)).toBe(true);
    expect(isValidStellarAddress(VALID_ADDR_B)).toBe(true);
  });

  it("rejects addresses that don't start with G", () => {
    expect(isValidStellarAddress("C" + VALID_ADDR_A.slice(1))).toBe(false);
  });

  it("rejects addresses that are too short", () => {
    expect(isValidStellarAddress("GAAZI4TCR3")).toBe(false);
  });

  it("rejects addresses that are too long", () => {
    expect(isValidStellarAddress(VALID_ADDR_A + "X")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidStellarAddress("")).toBe(false);
  });

  it("rejects lowercase characters", () => {
    expect(isValidStellarAddress(VALID_ADDR_A.toLowerCase())).toBe(false);
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

    const badAddr = valid.find((m) => !isValidStellarAddress(m));
    if (badAddr) return { error: `Invalid Stellar address: "${badAddr.slice(0, 4)}…${badAddr.slice(-4)}".` };

    const amount = parseFloat(roundUSDC);
    if (isNaN(amount) || amount <= 0) return { error: "Enter a valid round amount greater than zero." };
    if (amount > MAX_ROUND_USDC) return { error: `Round amount exceeds the maximum of $${MAX_ROUND_USDC.toLocaleString()}.` };

    const days = parseInt(roundDays, 10);
    if (isNaN(days) || days < 1) return { error: "Enter a valid round duration of at least 1 day." };
    if (days > MAX_ROUND_DAYS) return { error: `Round duration cannot exceed ${MAX_ROUND_DAYS} days.` };

    return { error: null };
  }

  it("passes with valid input", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_B], "100", "30");
    expect(error).toBeNull();
  });

  it("blocks with fewer than 2 filled members", () => {
    const { error } = validate([VALID_ADDR_A, ""], "100", "30");
    expect(error).toMatch(/at least 2 members/);
  });

  it("blocks with duplicate addresses", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_A], "100", "30");
    expect(error).toMatch(/duplicate/i);
  });

  it("blocks with case-insensitive duplicate addresses", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_A.toLowerCase()], "100", "30");
    expect(error).toMatch(/duplicate/i);
  });

  it("blocks with an invalid Stellar address", () => {
    const { error } = validate([VALID_ADDR_A, "not-an-address"], "100", "30");
    expect(error).toMatch(/invalid stellar address/i);
  });

  it("blocks with zero round amount", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_B], "0", "30");
    expect(error).toMatch(/valid round amount/i);
  });

  it("blocks with negative round amount", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_B], "-50", "30");
    expect(error).toMatch(/valid round amount/i);
  });

  it("blocks with zero round days", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_B], "100", "0");
    expect(error).toMatch(/valid round duration/i);
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
    const { error } = validate(addrs, "100", "30");
    expect(error).toMatch(/more than 20 members/i);
  });

  it("accepts exactly 3 valid members", () => {
    const { error } = validate([VALID_ADDR_A, VALID_ADDR_B, VALID_ADDR_C], "50", "14");
    expect(error).toBeNull();
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
