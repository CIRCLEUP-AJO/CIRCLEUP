/**
 * Representative indexer response bodies, one per public endpoint (issue #661).
 *
 * Each fixture mirrors what `indexer/src/api.ts` actually serialises,
 * including the Postgres wire quirks that the TypeScript interfaces alone do
 * not capture:
 *   • NUMERIC columns (amounts, collateral) arrive as decimal strings.
 *   • BIGINT columns (ledger sequences, round_deadline_ledgers) arrive as
 *     decimal strings, while values computed in JS (deadline_ledger,
 *     latestLedger) arrive as numbers.
 *   • TIMESTAMPTZ columns arrive as ISO-8601 strings.
 *   • COUNT(*) aggregates are converted to numbers by the API before
 *     serialising.
 *
 * When the indexer response shape changes, update the fixture here and the
 * matching schema in `sdk/src/indexerSchema.ts` in the same change, following
 * docs/INDEXER_API_COMPATIBILITY.md.
 */

const CIRCLE = "CCIRCLEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CREATOR = "GCREATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MEMBER_A = "GMEMBERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MEMBER_B = "GMEMBERBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TX_A = "a".repeat(64);
const TX_B = "b".repeat(64);
const TX_C = "c".repeat(64);

/** A circle row as listed by GET /circles. */
const CIRCLE_LIST_ROW = {
  address: CIRCLE,
  creator: CREATOR,
  round_amount: "100000000",
  member_count: 2,
  status: "Active",
  current_round: 1,
  total_rounds: 2,
  created_ledger: "1200000",
  updated_at: "2026-01-01T00:00:00.000Z",
};

/** GET /circles */
export const CIRCLES_LIST_FIXTURE = {
  circles: [CIRCLE_LIST_ROW],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

/** GET /circles/:address */
export const CIRCLE_DETAIL_FIXTURE = {
  circle: {
    id: 7,
    ...CIRCLE_LIST_ROW,
    round_deadline_ledgers: "120960",
    deadline_ledger: 1_441_920,
  },
  members: [
    {
      id: 11,
      circle_address: CIRCLE,
      member_address: MEMBER_A,
      payout_order: 0,
      join_order: 1,
      collateral: "100000000",
      defaults: 0,
      joined_at: "2026-01-01T00:00:00.000Z",
      reputation_score: 3,
    },
    {
      id: 12,
      circle_address: CIRCLE,
      member_address: MEMBER_B,
      payout_order: 1,
      join_order: null,
      collateral: "0",
      defaults: 0,
      joined_at: null,
      reputation_score: null,
    },
  ],
  latestLedger: 1_300_000,
};

/** GET /circles/:address/members */
export const MEMBERS_FIXTURE = {
  members: [
    {
      member_address: MEMBER_A,
      payout_order: 0,
      join_order: 1,
      collateral: "100000000",
      defaults: 0,
      joined_at: "2026-01-01T00:00:00.000Z",
      reputation_score: 3,
      total_contributions: 2,
    },
  ],
  totals: {
    memberCount: 1,
    totalCollateral: "100000000",
    totalContributions: 2,
  },
  roundDeadlineLedgers: "120960",
};

/** GET /circles/:address/rounds */
export const ROUNDS_FIXTURE = {
  rounds: [
    {
      roundIndex: 0,
      status: "completed",
      recipient: MEMBER_A,
      amount: "200000000",
      txHash: TX_A,
      ledger: "1250000",
      deadlineLedger: 1_320_960,
      contributions: [
        {
          id: 1,
          circle_address: CIRCLE,
          member_address: MEMBER_A,
          round_index: 0,
          amount: "100000000",
          tx_hash: TX_B,
          ledger: "1240000",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      defaults: [],
    },
  ],
  currentRound: {
    roundIndex: 1,
    status: "current",
    recipient: null,
    amount: null,
    txHash: null,
    ledger: null,
    deadlineLedger: 1_441_920,
    contributions: [],
    defaults: [],
  },
  openRounds: [],
  pendingDefaults: [
    {
      id: 3,
      circle_address: CIRCLE,
      member_address: MEMBER_B,
      round_index: 1,
      penalty: "10000000",
      tx_hash: TX_C,
      ledger: "1290000",
      created_at: "2026-01-03T00:00:00.000Z",
    },
  ],
};

/** GET /members/:member/contributions (history) */
export const MEMBER_CONTRIBUTIONS_FIXTURE = {
  member: MEMBER_A,
  circle: null,
  contributions: [
    {
      circle_address: CIRCLE,
      member_address: MEMBER_A,
      round_index: 0,
      amount: "100000000",
      tx_hash: TX_B,
      ledger: "1240000",
      created_at: "2026-01-02T00:00:00.000Z",
    },
  ],
  totalAmount: "100000000",
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false },
};

/** GET /reputation/:member */
export const REPUTATION_FIXTURE = {
  member: MEMBER_A,
  found: true,
  score: 3,
  contributions: [{ circle_address: CIRCLE, contributions: 2, total_rounds: 2 }],
  defaults: [{ circle_address: CIRCLE, count: 0 }],
  updatedAt: "2026-01-02T00:00:00.000Z",
};

/** GET /reputation/:member for a member the indexer has never seen. */
export const REPUTATION_UNKNOWN_MEMBER_FIXTURE = {
  member: MEMBER_B,
  found: false,
  detail: `Member '${MEMBER_B}' has no reputation record in the indexer.`,
  score: 0,
  contributions: [],
  defaults: [],
  updatedAt: null,
};

/** GET /circles/:address/audit */
export const AUDIT_EVENTS_FIXTURE = {
  circle_address: CIRCLE,
  events: [
    {
      id: 1,
      circle_address: CIRCLE,
      event_type: "closed",
      triggered_by: CREATOR,
      ledger: "1500000",
      tx_hash: TX_A,
      total_released: "190000000",
      total_expected_collateral: "200000000",
      close_reason: "completed",
      created_at: "2026-02-01T00:00:00.000Z",
    },
  ],
};

/** GET /health (component breakdown abbreviated — it is not part of the SDK contract). */
export const HEALTH_FIXTURE = {
  status: "ok",
  serviceStatus: "healthy",
  timestamp: "2026-01-01T00:00:00.000Z",
  db: { status: "ok" },
  rpc: { status: "ok" },
};

/** GET /indexer/state */
export const INDEXER_STATE_FIXTURE = {
  lastLedger: 1_300_000,
  updatedAt: "2026-01-01T00:00:00.000Z",
  totalEvents: 5,
  eventCounts: { circle_created: 1, contribution: 3, payout: 1 },
  entityCounts: {
    circles: 1,
    members: 2,
    contributions: 3,
    payouts: 1,
    defaults: 1,
    circlesByStatus: { Active: 1 },
  },
};

/** GET /members/:member/circles — member dashboard */
export const MEMBER_CIRCLES_FIXTURE = {
  circles: [
    {
      circle: {
        address: CIRCLE,
        creator: CREATOR,
        round_amount: "100000000",
        member_count: 2,
        status: "Active",
        current_round: 1,
        total_rounds: 2,
        created_ledger: "1200000",
        updated_at: "2026-01-01T00:00:00.000Z",
        deadline_ledger: 1_441_920,
        round_deadline_ledgers: "120960",
      },
      member: {
        payout_order: 0,
        join_order: 1,
        collateral: "100000000",
        defaults: 0,
        joined_at: "2026-01-01T00:00:00.000Z",
        reputation_score: 3,
        total_contributions: 2,
      },
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false },
};

/** GET /members/:member/circles — member with no circles */
export const MEMBER_CIRCLES_EMPTY_FIXTURE = {
  circles: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
};

/** GET /circles/:address/activity — circle event timeline */
export const CIRCLE_ACTIVITY_FIXTURE = {
  circle_address: CIRCLE,
  events: [
    {
      type: "circle_contribute",
      actor: MEMBER_A,
      round: 0,
      amount: "100000000",
      penalty: null,
      tx_hash: TX_B,
      ledger: 1_240_000,
      event_position: 0,
      id: "1240000-0-1",
      timestamp: "2026-01-02T00:00:00.000Z",
    },
    {
      type: "circle_payout",
      actor: MEMBER_A,
      round: 0,
      amount: "200000000",
      penalty: null,
      tx_hash: TX_A,
      ledger: 1_250_000,
      event_position: 2,
      id: "1250000-2-2",
      timestamp: "2026-01-02T01:00:00.000Z",
    },
    {
      type: "circle_default",
      actor: MEMBER_B,
      round: 1,
      amount: null,
      penalty: "10000000",
      tx_hash: TX_C,
      ledger: 1_290_000,
      event_position: 1,
      id: "1290000-1-3",
      timestamp: "2026-01-03T00:00:00.000Z",
    },
  ],
  pagination: { page: 1, limit: 50, total: 3, totalPages: 1, hasMore: false },
};

/** GET /circles/:address/activity — circle with no recorded events */
export const CIRCLE_ACTIVITY_EMPTY_FIXTURE = {
  circle_address: CIRCLE,
  events: [],
  pagination: { page: 1, limit: 50, total: 0, totalPages: 0, hasMore: false },
};

// ── Keyset (cursor) pages — issue #898 ────────────────────────────────────────
//
// Cursor pages skip COUNT(*), so their envelope is { limit, hasMore,
// nextCursor } instead of the page/total metadata. Tokens are opaque.

/** GET /members/:member/contributions?cursor= — a middle page. */
export const MEMBER_CONTRIBUTIONS_CURSOR_FIXTURE = {
  member: MEMBER_A,
  circle: null,
  contributions: MEMBER_CONTRIBUTIONS_FIXTURE.contributions,
  totalAmount: "100000000",
  pagination: { limit: 1, hasMore: true, nextCursor: "eyJ2IjoxfQ" },
};

/** GET /circles/:address/activity?cursor=<token> — the final page. */
export const CIRCLE_ACTIVITY_CURSOR_FIXTURE = {
  circle_address: CIRCLE,
  events: CIRCLE_ACTIVITY_FIXTURE.events.slice(2),
  pagination: { limit: 2, hasMore: false, nextCursor: null },
};

// ── Legacy (pre-deprecation) response forms — issue #149 ─────────────────────
//
// During a deprecation window the indexer serves both the legacy and the
// current form of a changed field/endpoint. The fixtures below capture the
// legacy wire shape so the compatibility tests can assert that both forms
// parse. Each legacy fixture carries the deprecation metadata documented in
// docs/INDEXER_API_COMPATIBILITY.md (since / sunset / replacement) and is
// removed once its sunset date has passed.

/** Deprecation metadata attached to every legacy fixture. */
export interface LegacyFixtureDeprecation {
  /** ISO-8601 date the legacy form was first marked deprecated. */
  since: string;
  /** ISO-8601 date after which the legacy form may be removed. */
  sunset: string;
  /** The current field/endpoint that replaces the legacy form. */
  replacement: string;
}

/** A legacy fixture plus the deprecation metadata describing its window. */
export interface LegacyFixture<T> {
  deprecation: LegacyFixtureDeprecation;
  body: T;
}

/**
 * GET /circles — legacy form.
 *
 * Before the pagination envelope was standardised, `GET /circles` returned a
 * bare array of circle rows and used `page`/`per_page` query parameters.
 * The current form wraps the rows in `{ circles, pagination }`.
 */
export const CIRCLES_LIST_LEGACY_FIXTURE: LegacyFixture<{
  circles: (typeof CIRCLE_LIST_ROW)[];
}> = {
  deprecation: {
    since: "2026-01-01",
    sunset: "2026-07-01",
    replacement: "GET /circles with { circles, pagination } envelope",
  },
  body: {
    circles: [CIRCLE_LIST_ROW],
  },
};

/**
 * GET /circles/:address/members — legacy form.
 *
 * The legacy response exposed the member list under `data` and reported the
 * round deadline as a JS number (`roundDeadlineLedgers`) rather than the
 * decimal string used for BIGINT columns today.
 */
export const MEMBERS_LEGACY_FIXTURE: LegacyFixture<{
  data: (typeof MEMBERS_FIXTURE.members)[];
  totals: typeof MEMBERS_FIXTURE.totals;
  roundDeadlineLedgers: number;
}> = {
  deprecation: {
    since: "2026-01-01",
    sunset: "2026-07-01",
    replacement: "GET /circles/:address/members with `members` and string roundDeadlineLedgers",
  },
  body: {
    data: MEMBERS_FIXTURE.members,
    totals: MEMBERS_FIXTURE.totals,
    roundDeadlineLedgers: 120_960,
  },
};

/**
 * GET /members/:member/contributions — legacy offset pagination.
 *
 * Before keyset pagination (issue #898) the endpoint always returned the
 * page/total envelope; cursor pages add `nextCursor` and drop `page`/`total`.
 * The legacy form remains valid when no `cursor` parameter is supplied.
 */
export const MEMBER_CONTRIBUTIONS_LEGACY_FIXTURE: LegacyFixture<
  typeof MEMBER_CONTRIBUTIONS_FIXTURE
> = {
  deprecation: {
    since: "2026-01-01",
    sunset: "2026-07-01",
    replacement: "GET /members/:member/contributions?cursor=<token> keyset pagination",
  },
  body: MEMBER_CONTRIBUTIONS_FIXTURE,
};

/**
 * GET /reputation/:member — legacy form.
 *
 * The legacy response used `reputationScore` instead of `score` and omitted
 * `found`; unknown members were reported with a 404 rather than `found: false`.
 */
export const REPUTATION_LEGACY_FIXTURE: LegacyFixture<{
  member: string;
  reputationScore: number;
  contributions: typeof REPUTATION_FIXTURE.contributions;
  defaults: typeof REPUTATION_FIXTURE.defaults;
  updatedAt: string | null;
}> = {
  deprecation: {
    since: "2026-01-01",
    sunset: "2026-07-01",
    replacement: "GET /reputation/:member with `score` and `found`",
  },
  body: {
    member: MEMBER_A,
    reputationScore: 3,
    contributions: REPUTATION_FIXTURE.contributions,
    defaults: REPUTATION_FIXTURE.defaults,
    updatedAt: REPUTATION_FIXTURE.updatedAt,
  },
};

/** All legacy fixtures, keyed by the endpoint they describe. */
export const LEGACY_FIXTURES = {
  circlesList: CIRCLES_LIST_LEGACY_FIXTURE,
  members: MEMBERS_LEGACY_FIXTURE,
  memberContributions: MEMBER_CONTRIBUTIONS_LEGACY_FIXTURE,
  reputation: REPUTATION_LEGACY_FIXTURE,
} as const;
