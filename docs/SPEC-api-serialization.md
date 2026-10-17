# API Serialization & Type Safety Specification

## Problem Statement

The indexer API queries assemble read models from database rows containing nullable values and numeric strings. A query change can alter the JSON response shape without compiler feedback to consumers, leading to runtime failures in SDK and UI code that expects specific field types.

## Goals

1. Define typed serializers/runtimes schemas for each public API endpoint
2. Validate database-derived values at serialization boundaries
3. Test empty datasets and cross-check responses against SDK parsers
4. Ensure invalid database values cannot escape as malformed success responses

## Implementation

### 1.1 Response Shape Registry

Create `indexer/src/api/schemas.ts` containing Zod schemas for each endpoint response:

```typescript
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Circle List Endpoint
// ─────────────────────────────────────────────────────────────────────────────

/** Serialization boundary: validates and transforms a raw circle row */
const CircleRowSchema = z.object({
  address: StellarAddressSchema,        // Required, validated G/C prefix
  creator: StellarAddressSchema,        // Required
  round_amount: NumericStringSchema,    // Postgres bigint → string
  member_count: NonNegativeIntegerSchema,
  status: CircleStatusSchema,
  current_round: NonNegativeIntegerSchema,
  total_rounds: NonNegativeIntegerSchema,
  created_ledger: LedgerSequenceSchema, // u64 from Postgres → number
  updated_at: IsoTimestampSchema,
});

/** Paginated circle list response */
const CircleListResponseSchema = z.object({
  circles: z.array(CircleRowSchema),
  pagination: PaginationSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Circle Detail Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const MemberRowSchema = z.object({
  circle_address: StellarAddressSchema,
  member_address: StellarAddressSchema,
  payout_order: NonNegativeIntegerSchema,
  join_order: Nullable(NonNegativeIntegerSchema),
  collateral: NumericStringSchema,     // bigint → string
  defaults: NonNegativeIntegerSchema,
  joined_at: Nullable(IsoTimestampSchema),
  reputation_score: Nullable(NonNegativeIntegerSchema),
});

const CircleDetailResponseSchema = z.object({
  circle: CircleRowSchema.extend({
    deadline_ledger: Nullable(LedgerSequenceSchema),
  }),
  members: z.array(MemberRowSchema),
  latestLedger: Nullable(LedgerSequenceSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// Members List Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const CircleMembersResponseSchema = z.object({
  members: z.array(MemberRowSchema.extend({
    total_contributions: NonNegativeIntegerSchema,
  })),
  totals: z.object({
    memberCount: NonNegativeIntegerSchema,
    totalCollateral: NumericStringSchema,
    totalContributions: NonNegativeIntegerSchema,
  }),
  roundDeadlineLedgers: Nullable(NonNegativeIntegerSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// Rounds History Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const ContributionRowSchema = z.object({
  circle_address: StellarAddressSchema,
  member_address: StellarAddressSchema,
  round_index: NonNegativeIntegerSchema,
  amount: NumericStringSchema,
  tx_hash: TxHashSchema,
  ledger: LedgerSequenceSchema,
  created_at: IsoTimestampSchema,
});

const PayoutRowSchema = z.object({
  circle_address: StellarAddressSchema,
  recipient: StellarAddressSchema,
  round_index: NonNegativeIntegerSchema,
  amount: NumericStringSchema,
  tx_hash: TxHashSchema,
  ledger: LedgerSequenceSchema,
  created_at: IsoTimestampSchema,
});

const DefaultRowSchema = z.object({
  circle_address: StellarAddressSchema,
  member_address: StellarAddressSchema,
  round_index: NonNegativeIntegerSchema,
  penalty: NumericStringSchema,
  tx_hash: TxHashSchema,
  ledger: LedgerSequenceSchema,
  created_at: IsoTimestampSchema,
});

const GroupedRoundSchema = z.object({
  roundIndex: NonNegativeIntegerSchema,
  payouts: z.array(PayoutRowSchema),
  contributions: z.array(ContributionRowSchema),
  defaults: z.array(DefaultRowSchema),
  status: z.enum(["completed", "current", "cancelled", "open"]),
  deadlineLedger: Nullable(LedgerSequenceSchema),
});

const CircleRoundsResponseSchema = z.object({
  rounds: z.array(GroupedRoundSchema),
  currentRound: Nullable(GroupedRoundSchema),
  openRounds: z.array(GroupedRoundSchema),
  pendingDefaults: z.array(DefaultRowSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// Member Contributions Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const MemberContributionsResponseSchema = z.object({
  member: StellarAddressSchema,
  circle: Nullable(StellarAddressSchema),
  contributions: z.array(ContributionRowSchema),
  totalAmount: NumericStringSchema,
  pagination: PaginationSchema.extend({
    hasMore: z.boolean(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Reputation Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const ContributionSummarySchema = z.object({
  circle_address: StellarAddressSchema,
  contributions: NonNegativeIntegerSchema,
  total_rounds: NonNegativeIntegerSchema,
});

const DefaultSummarySchema = z.object({
  circle_address: StellarAddressSchema,
  count: NonNegativeIntegerSchema,
});

const ReputationResponseSchema = z.object({
  member: StellarAddressSchema,
  found: z.boolean(),
  detail: Nullable(z.string()),
  score: NonNegativeIntegerSchema,
  contributions: z.array(ContributionSummarySchema),
  defaults: z.array(DefaultSummarySchema),
  updatedAt: Nullable(IsoTimestampSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// Indexer State Endpoint
// ─────────────────────────────────────────────────────────────────────────────

const IndexerStateResponseSchema = z.object({
  lastLedger: LedgerSequenceSchema,
  updatedAt: IsoTimestampSchema,
  totalEvents: NonNegativeIntegerSchema,
  eventCounts: z.record(z.string(), NonNegativeIntegerSchema),
  entityCounts: z.object({
    circles: NonNegativeIntegerSchema,
    members: NonNegativeIntegerSchema,
    contributions: NonNegativeIntegerSchema,
    payouts: NonNegativeIntegerSchema,
    defaults: NonNegativeIntegerSchema,
    circlesByStatus: z.record(z.string(), NonNegativeIntegerSchema),
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Common Primitives
// ─────────────────────────────────────────────────────────────────────────────

const StellarAddressSchema = z.string().regex(/^[GC][A-Z2-7]{55}$/, 
  "Must be a valid Stellar address (G or C prefix, 56 base32 chars)"
);

const NumericStringSchema = z.string().regex(/^\d+$/, 
  "Must be a non-negative numeric string"
).transform((val) => BigInt(val));

const NonNegativeIntegerSchema = z.number().int().min(0);

const LedgerSequenceSchema = z.number().int().min(0).max(0xFFFFFFFFFFFF); // u64 max

const TxHashSchema = z.string().regex(/^[0-9A-Za-z]{64}$/,
  "Must be a 64-character transaction hash"
);

const IsoTimestampSchema = z.string().datetime({ offset: true });

const PaginationSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive().max(100),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});

const CircleStatusSchema = z.enum([
  "Pending", "Active", "Completed", "Cancelled", "Closed"
]);

function Nullable<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullable();
}
```

### 1.2 Serialization Boundary

Create `indexer/src/api/serialize.ts` with validation at the API-database boundary:

```typescript
import { z } from "zod";
import type { CircleRow, CircleMemberRow, ContributionRow, PayoutRow, DefaultRow } from "../db/types";
import * as schemas from "./schemas";

/**
 * Serialization boundary: validates and transforms database rows into
 * wire-safe response objects. Throws if any invariant is violated,
 * ensuring malformed data never reaches clients.
 */
export function serializeCircle(row: CircleRow): z.infer<typeof schemas.CircleRowSchema> {
  return schemas.CircleRowSchema.parse(row);
}

export function serializeCircles(rows: CircleRow[]): z.infer<typeof schemas.CircleRowSchema>[] {
  return rows.map(serializeCircle);
}

export function serializeMember(row: CircleMemberRow): z.infer<typeof schemas.MemberRowSchema> {
  return schemas.MemberRowSchema.parse(row);
}

export function serializeContribution(row: ContributionRow): z.infer<typeof schemas.ContributionRowSchema> {
  return schemas.ContributionRowSchema.parse(row);
}

export function serializePayout(row: PayoutRow): z.infer<typeof schemas.PayoutRowSchema> {
  return schemas.PayoutRowSchema.parse(row);
}

export function serializeDefault(row: DefaultRow): z.infer<typeof schemas.DefaultRowSchema> {
  return schemas.DefaultRowSchema.parse(row);
}

/**
 * Safely serialize with fallback. Returns null on validation failure
 * rather than throwing, to prevent one bad row from crashing the whole response.
 */
export function serializeCircleSafe(row: CircleRow): z.infer<typeof schemas.CircleRowSchema> | null {
  const result = schemas.CircleRowSchema.safeParse(row);
  if (!result.success) {
    console.error("[api] Invalid circle row:", result.error.issues);
    return null;
  }
  return result.data;
}
```

### 1.3 Integration with API Routes

Update each endpoint in `api.ts` to use serializers:

```typescript
// Before:
res.json({ circles });

// After:
res.json({
  circles: circles.map(serializeCircle),
  pagination: { /* ... */ },
});
```

### 1.4 Test Coverage

Create `indexer/src/api.serialization.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { serializeCircle, serializeCircleSafe } from "./serialize";
import { schemas } from "./schemas";

describe("Circle serialization", () => {
  it("accepts valid database row", () => {
    const validRow = {
      address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEB4",
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      round_amount: "10000000", // 1 USDC in stroops
      member_count: 5,
      status: "Active",
      current_round: 2,
      total_rounds: 5,
      created_ledger: "1000",
      updated_at: "2024-01-15T10:30:00Z",
    };
    const result = serializeCircle(validRow);
    expect(result.address).toBe(validRow.address);
    expect(result.round_amount).toBe(10000000n);
  });

  it("rejects invalid address prefix", () => {
    const invalidRow = {
      ...validRow,
      address: "XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    expect(() => serializeCircle(invalidRow)).toThrow();
  });

  it("rejects non-numeric round_amount", () => {
    const invalidRow = {
      ...validRow,
      round_amount: "not-a-number",
    };
    expect(() => serializeCircle(invalidRow)).toThrow();
  });

  it("reject negative member_count", () => {
    const invalidRow = {
      ...validRow,
      member_count: -1,
    };
    expect(() => serializeCircle(invalidRow)).toThrow();
  });

  it("serializeCircleSafe returns null for invalid rows", () => {
    const invalidRow = { address: "invalid" };
    expect(serializeCircleSafe(invalidRow as any)).toBeNull();
  });
});

describe("Empty datasets", () => {
  it("handles empty circles array", () => {
    const result = schemas.CircleListResponseSchema.parse({
      circles: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    expect(result.circles).toHaveLength(0);
  });
});
```

### 1.5 SDK Cross-Check

Add tests in SDK that parse indexer responses:

```typescript
// sdk/src/indexer.test.ts
import { parseCircleList, parseCircleDetail } from "./indexer";
import { validCircleListResponse, validCircleDetailResponse } from "./fixtures/indexer";

describe("IndexerClient response parsing", () => {
  it("parses valid circle list response", () => {
    const result = parseCircleList(validCircleListResponse);
    expect(result.circles[0].roundAmount).toBe(10000000n);
  });

  it("throws on missing required field", () => {
    const { address, ...invalid } = validCircleListResponse.circles[0];
    expect(() => parseCircleList({ circles: [invalid], pagination: {} })).toThrow();
  });
});
```

## Acceptance Criteria

- [ ] Every public endpoint has a Zod schema documenting its wire shape
- [ ] Each schema validates required fields, types, and value ranges
- [ ] Invalid database values (malformed addresses, negative counts, non-numeric strings) throw at serialization boundary
- [ ] Empty datasets (zero rows) produce valid empty arrays in responses
- [ ] Tests cover valid rows, invalid rows, and empty datasets
- [ ] SDK fixtures match API response schemas for cross-check testing

## Priority

**High** - This is a correctness foundation. Without typed serialization, invalid database values can corrupt client state.