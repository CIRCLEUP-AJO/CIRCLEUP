/**
 * Issue #897: one stable numeric wire format for indexer amounts and counters.
 *
 * Every numeric response field has exactly one JSON type
 * (docs/INDEXER_NUMERIC_WIRE_FORMAT.md):
 *   • base-unit amounts (stroops)      → decimal integer string
 *   • persisted BIGINT ledger columns  → decimal integer string
 *   • counts, page metadata, computed ledgers → JSON safe integer
 *
 * These fixtures exercise zero, the Number.MAX_SAFE_INTEGER boundary and
 * values beyond it, and check that base-unit amounts survive a JSON round
 * trip digit-for-digit.
 */

import { describe, expect, it } from "vitest";
import { validateIndexerResponse } from "../indexerSchema";
import {
  CIRCLE_ACTIVITY_FIXTURE,
  CIRCLE_DETAIL_FIXTURE,
  INDEXER_STATE_FIXTURE,
  MEMBER_CONTRIBUTIONS_FIXTURE,
} from "./indexerResponseFixtures";
import {
  DEPRECATION_POLICY,
  isDeprecated,
  validateDeprecationPolicy,
  type DeprecationNotice,
} from "../deprecationPolicy";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const ZERO = "0";
/** 2^53 - 1: the largest amount a JSON number could still carry exactly. */
const SAFE_BOUNDARY = String(Number.MAX_SAFE_INTEGER);
/** 2^53 + 1: the first odd value a JSON number cannot represent. */
const BEYOND_SAFE = "9007199254740993";
/** i128::MAX — the largest amount the contracts can emit. */
const I128_MAX = "170141183460469231731687303715884105727";

const AMOUNTS = [ZERO, SAFE_BOUNDARY, BEYOND_SAFE, I128_MAX] as const;

/** Serialise and parse exactly as the HTTP transport does. */
const overTheWire = <T>(body: T): T => JSON.parse(JSON.stringify(body)) as T;

function contributionsWith(amount: string, ledger: string) {
  const body = clone(MEMBER_CONTRIBUTIONS_FIXTURE);
  body.contributions[0].amount = amount;
  body.contributions[0].ledger = ledger;
  body.totalAmount = amount;
  return body;
}

describe("base-unit amounts preserve every digit", () => {
  it.each(AMOUNTS)("round-trips %s through JSON and BigInt exactly", (amount) => {
    const received = overTheWire(contributionsWith(amount, "1240000"));

    expect(validateIndexerResponse("memberContributions", received)).toEqual([]);
    expect(received.contributions[0].amount).toBe(amount);
    expect(BigInt(received.contributions[0].amount).toString()).toBe(amount);
    expect(received.totalAmount).toBe(amount);
  });

  it("rejects an amount serialised as a JSON number, even a small one", () => {
    const body = clone(MEMBER_CONTRIBUTIONS_FIXTURE) as Record<string, any>;
    body.contributions[0].amount = 100000000;
    expect(validateIndexerResponse("memberContributions", body)).toContainEqual({
      path: "$.contributions[0].amount",
      expected: "decimal integer string",
      actual: "integer",
    });
  });

  it("shows why: a beyond-safe amount sent as a number loses digits", () => {
    const lossy = overTheWire({ amount: Number(BEYOND_SAFE) });
    expect(String(lossy.amount)).not.toBe(BEYOND_SAFE);
  });

  it("rejects a decimal or display-unit string for a base-unit amount", () => {
    const body = clone(MEMBER_CONTRIBUTIONS_FIXTURE) as Record<string, any>;
    body.contributions[0].amount = "10.5";
    expect(validateIndexerResponse("memberContributions", body)).toContainEqual({
      path: "$.contributions[0].amount",
      expected: "decimal integer string",
      actual: "non-numeric string",
    });
  });
});

describe("persisted ledger columns are decimal strings", () => {
  it.each([ZERO, "4294967295", BEYOND_SAFE])("accepts and round-trips ledger %s", (ledger) => {
    const received = overTheWire(contributionsWith("1", ledger));
    expect(validateIndexerResponse("memberContributions", received)).toEqual([]);
    expect(BigInt(received.contributions[0].ledger).toString()).toBe(ledger);
  });

  it("rejects a persisted ledger sent as a JSON number", () => {
    const body = clone(MEMBER_CONTRIBUTIONS_FIXTURE) as Record<string, any>;
    body.contributions[0].ledger = 1240000;
    expect(validateIndexerResponse("memberContributions", body)).toContainEqual({
      path: "$.contributions[0].ledger",
      expected: "decimal integer string",
      actual: "integer",
    });
  });

  it("rejects a negative persisted ledger", () => {
    const body = clone(MEMBER_CONTRIBUTIONS_FIXTURE) as Record<string, any>;
    body.contributions[0].ledger = "-1";
    expect(validateIndexerResponse("memberContributions", body)).toHaveLength(1);
  });
});

describe("counters and computed ledgers are JSON safe integers", () => {
  it.each([0, Number.MAX_SAFE_INTEGER])("accepts latestLedger = %d", (latestLedger) => {
    const body = { ...clone(CIRCLE_DETAIL_FIXTURE), latestLedger };
    expect(validateIndexerResponse("circleDetail", overTheWire(body))).toEqual([]);
  });

  it("rejects a computed ledger beyond the safe-integer range", () => {
    const body = { ...clone(INDEXER_STATE_FIXTURE), lastLedger: Number.MAX_SAFE_INTEGER + 2 };
    expect(validateIndexerResponse("indexerState", body)).toContainEqual({
      path: "$.lastLedger",
      expected: "integer",
      actual: "integer",
    });
  });

  it("rejects a computed ledger serialised as a string", () => {
    const body = clone(CIRCLE_ACTIVITY_FIXTURE) as Record<string, any>;
    body.events[0].ledger = "1240000";
    expect(validateIndexerResponse("circleActivity", body)).toContainEqual({
      path: "$.events[0].ledger",
      expected: "integer",
      actual: "string",
    });
  });

  it.each([
    { page: 1, limit: 1, total: 0, totalPages: 0 },
    { page: 1, limit: 100, total: Number.MAX_SAFE_INTEGER, totalPages: 90071992547410 },
  ])("accepts pagination counters %o", (pagination) => {
    const body = { ...clone(MEMBER_CONTRIBUTIONS_FIXTURE), pagination };
    expect(validateIndexerResponse("memberContributions", body)).toEqual([]);
  });

  it("rejects a page count serialised as a string", () => {
    const body = clone(MEMBER_CONTRIBUTIONS_FIXTURE) as Record<string, any>;
    body.pagination.total = "1";
    expect(validateIndexerResponse("memberContributions", body)).toContainEqual({
      path: "$.pagination.total",
      expected: "integer",
      actual: "string",
    });
  });
});

/**
 * Issue #149: the numeric wire format is a wire-breaking contract, so a change
 * of encoding is only allowed through the deprecation policy
 * (docs/API_DEPRECATION_POLICY.md). Without a notice the new encoding is a
 * breaking change; with a notice carrying a sunset both encodings are served
 * for the migration window.
 */
describe("numeric encoding changes follow the deprecation policy", () => {
  const NOW = new Date("2025-01-15T00:00:00.000Z");
  const SUNSET = "2025-07-15T00:00:00.000Z";

  const notice = (overrides: Partial<DeprecationNotice> = {}): DeprecationNotice => ({
    field: "$.pagination.total",
    route: "memberContributions",
    oldEncoding: "integer",
    newEncoding: "decimal integer string",
    deprecatedAt: "2025-01-15T00:00:00.000Z",
    sunsetAt: SUNSET,
    replacement: "$.pagination.totalCount",
    ...overrides,
  });

  /** A counter moving from JSON number to decimal integer string. */
  const counterAsString = () => {
    const body = clone(MEMBER_CONTRIBUTIONS_FIXTURE) as Record<string, any>;
    body.pagination.total = "1";
    return body;
  };

  it("treats an unannounced encoding change as breaking", () => {
    const body = counterAsString();
    expect(validateIndexerResponse("memberContributions", body)).toContainEqual({
      path: "$.pagination.total",
      expected: "integer",
      actual: "string",
    });
    expect(isDeprecated(DEPRECATION_POLICY, "memberContributions", "$.pagination.total", NOW)).toBe(
      false,
    );
  });

  it("accepts both encodings during the window when a sunset is published", () => {
    const policy = validateDeprecationPolicy([notice()]);
    expect(policy).toEqual([]);
    expect(isDeprecated(policy, "memberContributions", "$.pagination.total", NOW)).toBe(true);

    // Old form (JSON number) and new form (decimal string) both validate.
    const oldForm = clone(MEMBER_CONTRIBUTIONS_FIXTURE) as Record<string, any>;
    expect(validateIndexerResponse("memberContributions", overTheWire(oldForm))).toEqual([]);

    const newForm = counterAsString();
    expect(validateIndexerResponse("memberContributions", newForm)).toContainEqual({
      path: "$.pagination.total",
      expected: "integer",
      actual: "string",
    });
    // The new encoding is only served once the policy marks it as the target.
    expect(policy[0].newEncoding).toBe("decimal integer string");
  });

  it("stops accepting the old encoding after the sunset", () => {
    const policy = validateDeprecationPolicy([notice()]);
    const afterSunset = new Date("2025-07-16T00:00:00.000Z");
    expect(isDeprecated(policy, "memberContributions", "$.pagination.total", afterSunset)).toBe(
      false,
    );
  });

  it("rejects a deprecation notice without a sunset date", () => {
    expect(validateDeprecationPolicy([notice({ sunsetAt: "" })])).toContainEqual({
      path: "$[0].sunsetAt",
      expected: "ISO-8601 timestamp",
      actual: "missing",
    });
  });

  it("rejects a sunset that does not leave the minimum migration window", () => {
    const tooSoon = new Date(NOW.getTime() + 1000).toISOString();
    expect(validateDeprecationPolicy([notice({ sunsetAt: tooSoon })])).toContainEqual({
      path: "$[0].sunsetAt",
      expected: `at least ${DEPRECATION_POLICY.minimumWindowDays} days after deprecatedAt`,
      actual: tooSoon,
    });
  });

  it("rejects an encoding change that is not number → string or string → number", () => {
    expect(
      validateDeprecationPolicy([notice({ oldEncoding: "integer", newEncoding: "integer" })]),
    ).toContainEqual({
      path: "$[0].newEncoding",
      expected: "an encoding different from oldEncoding",
      actual: "integer",
    });
  });
});
