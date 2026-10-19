# Numeric Precision Specification

## Problem Statement

Postgres BIGINT and NUMERIC values may exceed JavaScript's safe integer range (2^53 - 1). Converting stroops, ledger values, or IDs through JavaScript's `Number` can silently change values, causing incorrect monetary calculations or corrupted data.

## Goals

1. Audit numeric fields from database through API to SDK and UI
2. Document which fields should be strings vs numbers
3. Validate safe integer bounds where numbers are used
4. Test boundary conditions and monetary precision

## Implementation

### 4.1 Numeric Field Inventory

Create `indexer/src/api/numeric-fields.ts` documenting all numeric fields:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Numeric Field Inventory
// ─────────────────────────────────────────────────────────────────────────────
//
// This module documents the numeric type expectations for every field
// that flows from the database through the API to clients.
//
// JavaScript Number limits:
//   - MAX_SAFE_INTEGER: 2^53 - 1 = 9,007,199,254,740,991 (~9 quadrillion)
//   - MIN_SAFE_INTEGER: -(2^53 - 1)
//
// Postgres types:
//   - BIGINT: -9,223,372,036,854,775,808 to 9,223,372,036,854,775,807
//   - INTEGER: -2,147,483,648 to 2,147,483,647
//   - NUMERIC/Decimal: arbitrary precision (use string)
//
// Stellar values:
//   - Stroops: 1 USDC = 10,000,000 stroops (max ~10^15 for reasonable amounts)
//   - Ledger sequence: u64, currently ~80M, max ~1.8×10^19
//   - Transaction IDs: u64 hash

// ─────────────────────────────────────────────────────────────────────────────
// Field Categories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fields that MUST be serialized as strings (arbitrary precision).
 * These are monetary values or numbers that could exceed safe integer bounds.
 */
export const STRING_FIELDS = [
  // Circle
  "round_amount",      // i128 stroops - monetary value
  "collateral",        // i128 stroops - member collateral
  "total_collateral",  // Aggregate of collateral
  "amount",            // Contribution/payout amounts
  "penalty",           // Default penalties
  "total_released",    // Audit event release amounts
  "total_expected_collateral", // Audit event expected amounts
  "totalAmount",       // Response aggregation
] as const;

/**
 * Fields that are safe as numbers (within JavaScript safe integer range).
 * These are counts, indices, and ledger sequences within known bounds.
 */
export const NUMBER_FIELDS = [
  // Counts (max ~10^6, well within safe range)
  "member_count",
  "total_rounds", 
  "current_round",
  "payout_order",
  "join_order",
  "defaults",                 // Count of defaults (max rounds)
  "contributions",            // Count of contributions
  "total_contributions",      // Count aggregate
  
  // Ledger sequences (current ~80M, max u64 ~1.8×10^19 - exceeds safe range!)
  // NOTE: ledger sequences should use bigint internally but can be number 
  // for current Stellar ledgers (expected to stay under 2^53)
  "created_ledger",
  "ledger",
  "last_ledger",
  "deadline_ledger",
  
  // Indices
  "round_index",
  "id",                       // Internal DB IDs
] as const;

/**
 * Fields that require special handling (bigint serialization).
 */
export const BIGINT_FIELDS = [
  "round_amount",
  "collateral", 
  "amount",
  "penalty",
  "total_released",
  "total_expected_collateral",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Marks a field as requiring string serialization (for monetary values).
 * The string contains a decimal representation of the number.
 */
export type NumericString<T extends string = string> = T & {
  __numericString: true;
};

/**
 * Marks a field as a ledger sequence.
 * Currently fits in number but explicitly tracked for future growth.
 */
export type LedgerSequence = number & {
  __ledgerSequence: true;
};

/**
 * Marks a field as a monetary amount in stroops.
 * Always serialized as string to preserve precision.
 */
export type Stroops = string & {
  __stroops: true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Validation Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum safe integer in JavaScript.
 * Values above this cannot be precisely represented.
 */
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER; // 2^53 - 1

/**
 * Maximum ledger sequence we expect to handle as number.
 * Current Stellar ledgers are ~80M. Even at 1 ledgers/sec, 
 * this won't exceed 2^53 for ~285 years.
 */
export const MAX_SAFE_LEDGER = 10_000_000_000; // 10 billion

/**
 * Maximum value for a u32 field (common in XDR).
 */
export const MAX_U32 = 0xffffffff; // 4,294,967,295

/**
 * Maximum value for a u64 field.
 */
export const MAX_U64 = 18446744073709551615n; // 2^64 - 1

/**
 * Validates that a value is within JavaScript's safe integer range.
 * Throws if the value would lose precision when converted to Number.
 */
export function validateSafeInteger(value: bigint, fieldName: string): void {
  if (value > MAX_SAFE_INTEGERn || value < -MAX_SAFE_INTEGERn) {
    throw new TypeError(
      `${fieldName}: value ${value} exceeds JavaScript's MAX_SAFE_INTEGER ` +
      `(${MAX_SAFE_INTEGER}). Serialize as string instead.`
    );
  }
}

/**
 * Validates that a number is within u32 range.
 */
export function validateU32(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new TypeError(
      `${fieldName}: value ${value} is not a valid u32 (0-${MAX_U32})`
    );
  }
}

/**
 * Validates that a ledger sequence is within expected bounds.
 */
export function validateLedgerSequence(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName}: ledger sequence must be non-negative`);
  }
  // Warn if exceeding expected range (but don't fail - Stellar might surprise us)
  if (value > MAX_SAFE_LEDGER) {
    console.warn(
      `${fieldName}: ledger sequence ${value} exceeds typical range. ` +
      `Consider using bigint for future-proofing.`
    );
  }
}

/**
 * Serializes a stroops value to a numeric string.
 * Ensures precision is preserved across the wire.
 */
export function serializeStroops(value: bigint | string | number): string {
  if (typeof value === "string") {
    // Already a string - validate it looks numeric
    if (!/^\d+$/.test(value)) {
      throw new TypeError(`Invalid stroops value: ${value}`);
    }
    return value;
  }
  
  if (typeof value === "bigint") {
    return value.toString();
  }
  
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`Stroops must be non-negative integer, got ${value}`);
    }
    // Warn if precision loss occurred
    if (!Number.isSafeInteger(value)) {
      console.warn(
        `Precision loss: converting ${value} to integer may have altered the value`
      );
    }
    return String(value);
  }
  
  throw new TypeError(`Expected bigint, number, or string for stroops, got ${typeof value}`);
}
```

### 4.2 Numeric Serialization in API Response

Update the serialization layer in `api.ts`:

```typescript
import { 
  serializeStroops, 
  validateSafeInteger, 
  validateLedgerSequence,
  type Stroops,
  type LedgerSequence 
} from "./api/numeric-fields";

// ─────────────────────────────────────────────────────────────────────────────
// Serialization with Numeric Safety
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a circle row, ensuring numeric fields are properly typed.
 * Monetary values (round_amount) are strings; counts are numbers.
 */
function serializeCircleRow(row: CircleRow): SerializedCircle {
  // Validate ledger sequences
  if (row.created_ledger) {
    validateLedgerSequence(Number(row.created_ledger), "created_ledger");
  }
  
  return {
    address: row.address,
    creator: row.creator,
    // CRITICAL: Monetary value as string
    round_amount: serializeStroops(row.round_amount),
    member_count: row.member_count,
    status: row.status,
    current_round: row.current_round,
    total_rounds: row.total_rounds,
    created_ledger: Number(row.created_ledger),
    updated_at: row.updated_at,
  };
}

type SerializedCircle = {
  address: string;
  creator: string;
  round_amount: string;  // Monetary - always string
  member_count: number;
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
  updated_at: string;
};

/**
 * Serialize a member row with proper numeric types.
 */
function serializeMemberRow(row: CircleMemberRow): SerializedMember {
  return {
    circle_address: row.circle_address,
    member_address: row.member_address,
    payout_order: row.payout_order,
    join_order: row.join_order,
    // CRITICAL: Collateral is monetary - serialize as string
    collateral: serializeStroops(row.collateral),
    defaults: row.defaults,
    joined_at: row.joined_at,
    reputation_score: row.reputation_score,
  };
}

type SerializedMember = {
  circle_address: string;
  member_address: string;
  payout_order: number;
  join_order: number | null;
  collateral: string;  // Monetary - always string
  defaults: number;
  joined_at: string | null;
  reputation_score: number | null;
};
```

### 4.3 SDK Parser Updates

Update SDK to handle numeric strings:

```typescript
// sdk/src/types.ts - add numeric string handling

/**
 * Parse a numeric string from the API response.
 * Returns bigint for precise calculations, or number if safe.
 */
export function parseNumericString(value: unknown, fieldName: string): bigint {
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      throw new TypeError(`${fieldName}: expected numeric string, got "${value}"`);
    }
    return BigInt(value);
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(`${fieldName}: expected integer, got ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `${fieldName}: ${value} exceeds MAX_SAFE_INTEGER. ` +
        `API should send this value as a string.`
      );
    }
    return BigInt(value);
  }
  throw new TypeError(`${fieldName}: expected number or string, got ${typeof value}`);
}

/**
 * Circle from API response - round_amount is a string (stroops).
 */
export interface ApiCircle {
  address: string;
  creator: string;
  round_amount: string;  // Numeric string - parse with parseNumericString
  member_count: number;
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
  updated_at: string;
}

/**
 * Parse API circle response into domain type.
 */
export function parseCircleFromApi(raw: ApiCircle): Circle {
  return {
    address: raw.address,
    creator: raw.creator,
    roundAmount: parseNumericString(raw.round_amount, "round_amount"),
    memberCount: raw.member_count,
    status: raw.status as CircleStatus,
    currentRound: raw.current_round,
    totalRounds: raw.total_rounds,
    createdLedger: raw.created_ledger,
    updatedAt: raw.updated_at,
  };
}

/**
 * Member from API response - collateral is a string (stroops).
 */
export interface ApiMember {
  circle_address: string;
  member_address: string;
  payout_order: number;
  join_order: number | null;
  collateral: string;  // Numeric string
  defaults: number;
  joined_at: string | null;
  reputation_score: number | null;
}
```

### 4.4 Test Coverage

Create `indexer/src/api.numeric.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { 
  serializeStroops, 
  validateSafeInteger, 
  validateLedgerSequence,
  MAX_SAFE_INTEGER,
  MAX_U32,
} from "./numeric-fields";

describe("Numeric field serialization", () => {
  describe("serializeStroops", () => {
    it("accepts bigint and converts to string", () => {
      expect(serializeStroops(10000000n)).toBe("10000000");
    });

    it("accepts string and validates format", () => {
      expect(serializeStroops("10000000")).toBe("10000000");
    });

    it("accepts safe integer number", () => {
      expect(serializeStroops(10000000)).toBe("10000000");
    });

    it("rejects negative numbers", () => {
      expect(() => serializeStroops(-1)).toThrow();
    });

    it("rejects non-numeric strings", () => {
      expect(() => serializeStroops("not-a-number")).toThrow();
    });

    it("rejects floats", () => {
      expect(() => serializeStroops(10.5)).toThrow();
    });

    it("warns on unsafe integer conversion", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      
      // This exceeds MAX_SAFE_INTEGER
      const unsafeNumber = Number.MAX_SAFE_INTEGER + 1;
      serializeStroops(unsafeNumber);
      
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("validateSafeInteger", () => {
    it("accepts values within safe range", () => {
      expect(() => validateSafeInteger(1000n, "test")).not.toThrow();
      expect(() => validateSafeInteger(MAX_SAFE_INTEGERn, "test")).not.toThrow();
    });

    it("rejects values exceeding safe range", () => {
      expect(() => validateSafeInteger(MAX_SAFE_INTEGERn + 1n, "test")).toThrow();
      expect(() => validateSafeInteger(-(MAX_SAFE_INTEGERn + 1n), "test")).toThrow();
    });
  });

  describe("validateLedgerSequence", () => {
    it("accepts current ledger ranges", () => {
      expect(() => validateLedgerSequence(80_000_000, "test")).not.toThrow();
    });

    it("rejects negative values", () => {
      expect(() => validateLedgerSequence(-1, "test")).toThrow();
    });

    it("warns on unexpectedly high values", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      
      validateLedgerSequence(11_000_000_000, "test");
      
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});

describe("Round-trip numeric precision", () => {
  it("preserves stroops through serialize → parse", () => {
    const original = 10000000n; // 1 USDC
    const serialized = serializeStroops(original);
    const parsed = BigInt(serialized);
    expect(parsed).toBe(original);
  });

  it("preserves large monetary values", () => {
    // 1 million USDC in stroops
    const original = 10000000000000n;
    const serialized = serializeStroops(original);
    const parsed = BigInt(serialized);
    expect(parsed).toBe(original);
  });

  it("preserves boundary values", () => {
    // Test MAX_SAFE_INTEGER as bigint
    const maxSafe = BigInt(MAX_SAFE_INTEGER);
    const serialized = serializeStroops(maxSafe);
    const parsed = BigInt(serialized);
    expect(parsed).toBe(maxSafe);
  });
});

describe("API response shape matches SDK expectations", () => {
  it("circle response has string round_amount", () => {
    const apiResponse = {
      circles: [{
        address: "CAAA...",
        creator: "GAAA...",
        round_amount: "10000000",  // String, not number
        member_count: 5,
        status: "Active",
        current_round: 1,
        total_rounds: 5,
        created_ledger: 1000,
        updated_at: "2024-01-01T00:00:00Z",
      }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    };
    
    // This is the shape the API should produce
    expect(typeof apiResponse.circles[0].round_amount).toBe("string");
  });

  it("member response has string collateral", () => {
    const apiResponse = {
      members: [{
        circle_address: "CAAA...",
        member_address: "GAAA...",
        payout_order: 0,
        join_order: null,
        collateral: "10000000",  // String, not number
        defaults: 0,
        joined_at: "2024-01-01T00:00:00Z",
        reputation_score: 100,
      }],
    };
    
    expect(typeof apiResponse.members[0].collateral).toBe("string");
  });
});
```

### 4.5 Documentation

Document numeric wire types in API documentation:

```markdown
# Numeric Wire Types

## Overview

The API uses different numeric representations depending on the value type and magnitude:

| Field Type | JSON Type | Example | Notes |
|------------|-----------|---------|-------|
| Monetary amounts | string | `"10000000"` | Stroops - always string to preserve precision |
| Counts/indices | number | `5` | Within safe integer range |
| Ledger sequences | number | `12345678` | Currently within safe range |
| IDs | number | `1` | Internal DB IDs |

## Monetary Values (String)

The following fields are serialized as JSON strings to preserve precision:

- `circle.round_amount` - Circle's round amount in stroops
- `member.collateral` - Member's locked collateral
- `contribution.amount` - Contribution amount in stroops
- `payout.amount` - Payout amount in stroops
- `default.penalty` - Default penalty amount

**Why?** Stroops represent USDC fractions (1 USDC = 10,000,000 stroops). While current values fit in JavaScript's safe integer, future large circles could exceed `Number.MAX_SAFE_INTEGER`. Serializing as strings guarantees precision.

## Counts and Indices (Number)

The following fields are serialized as JSON numbers:

- `member_count`, `total_rounds`, `current_round`
- `payout_order`, `join_order`
- `defaults`, `contributions`
- `round_index`

These values are bounded (max ~256 for members, ~10^9 for rounds) and safely fit in JavaScript numbers.

## Client Handling

```typescript
// Always use bigint for monetary calculations
const roundAmount = BigInt(circle.round_amount);
const collateral = BigInt(member.collateral);
const myPayout = roundAmount - collateral;

// For display, convert to human-readable USDC
const usdc = Number(roundAmount) / 10_000_000;
```

## Boundary Testing

The test suite verifies:
- Values up to MAX_SAFE_INTEGER round-trip correctly
- Values above MAX_SAFE_INTEGER fail validation (should use string)
- Empty arrays don't cause type errors
- Null values in optional fields are preserved
```

## Acceptance Criteria

- [ ] All monetary fields (amounts, collateral, penalties) serialized as strings
- [ ] Count/index fields remain as numbers
- [ ] Ledger sequences validated for reasonable bounds
- [ ] Tests verify bigint round-trip through JSON serialization
- [ ] Tests verify unsafe integer detection
- [ ] SDK parses numeric strings into bigint
- [ ] Documentation describes wire types for each field

## Priority

**High** - Monetary precision is critical. Silent rounding of financial values is a correctness and potential legal/compliance issue.