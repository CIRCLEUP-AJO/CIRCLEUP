/**
 * API response fixtures derived from canonical OpenAPI v1 specification (Issue #911).
 *
 * Source contract: docs/api/v1/openapi.json
 * Wire rules: docs/INDEXER_NUMERIC_WIRE_FORMAT.md
 *
 * Every fixture here mirrors a documented response family in openapi.json.
 * These fixtures validate both against OpenAPI component schemas and against
 * the SDK's runtime parsers and TypeScript types.
 */

import type {
  ApiCirclesListResponse,
  ApiCircleDetailResponse,
  ApiMembersResponse,
  ApiMemberContributionsResponse,
  ApiAuditEventsResponse,
  ApiHealthResponse,
} from "../types";

export const FIXTURE_CONSTANTS = {
  CIRCLE: "CCIRCLEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  CREATOR: "GCREATORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  MEMBER_A: "GMEMBERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  MEMBER_B: "GMEMBERBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  TX_HASH: "0000000000000000000000000000000000000000000000000000000000000001",
  TIMESTAMP: "2026-01-01T00:00:00.000Z",
} as const;

// ─── 1. Success Families ──────────────────────────────────────────────────────

/** GET /circles — 200 Success */
export const OPENAPI_CIRCLES_LIST_FIXTURE: ApiCirclesListResponse = {
  circles: [
    {
      address: FIXTURE_CONSTANTS.CIRCLE,
      creator: FIXTURE_CONSTANTS.CREATOR,
      round_amount: "100000000",
      member_count: 2,
      status: "Active",
      current_round: 1,
      total_rounds: 2,
      created_ledger: "1200000",
      updated_at: FIXTURE_CONSTANTS.TIMESTAMP,
    },
  ],
  pagination: {
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    hasMore: false,
    nextCursor: null,
  },
};

/** GET /circles/:address — 200 Success */
export const OPENAPI_CIRCLE_DETAIL_FIXTURE: ApiCircleDetailResponse = {
  circle: {
    address: FIXTURE_CONSTANTS.CIRCLE,
    creator: FIXTURE_CONSTANTS.CREATOR,
    round_amount: "100000000",
    member_count: 2,
    status: "Active",
    current_round: 1,
    total_rounds: 2,
    created_ledger: "1200000",
    updated_at: FIXTURE_CONSTANTS.TIMESTAMP,
    round_deadline_ledgers: "120960",
    deadline_ledger: 1320960,
  },
  members: [
    {
      member_address: FIXTURE_CONSTANTS.MEMBER_A,
      payout_order: 0,
      join_order: 1,
      collateral: "100000000",
      defaults: 0,
      joined_at: FIXTURE_CONSTANTS.TIMESTAMP,
      reputation_score: 5,
    },
    {
      member_address: FIXTURE_CONSTANTS.MEMBER_B,
      payout_order: 1,
      join_order: null,
      collateral: "0",
      defaults: 0,
      joined_at: null,
      reputation_score: null,
    },
  ],
  latestLedger: 1250000,
};

/** GET /circles/:address/members — 200 Success */
export const OPENAPI_MEMBERS_FIXTURE: ApiMembersResponse = {
  members: [
    {
      member_address: FIXTURE_CONSTANTS.MEMBER_A,
      payout_order: 0,
      join_order: 1,
      collateral: "100000000",
      defaults: 0,
      joined_at: FIXTURE_CONSTANTS.TIMESTAMP,
      reputation_score: 5,
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

/** GET /circles/:address/rounds — 200 Success */
export const OPENAPI_ROUNDS_FIXTURE = {
  rounds: [
    {
      roundIndex: 0,
      status: "completed",
      recipient: FIXTURE_CONSTANTS.MEMBER_A,
      amount: "100000000",
      txHash: FIXTURE_CONSTANTS.TX_HASH,
      ledger: "1200100",
      deadlineLedger: 1320960,
      contributions: [
        {
          member_address: FIXTURE_CONSTANTS.MEMBER_A,
          amount: "100000000",
          tx_hash: FIXTURE_CONSTANTS.TX_HASH,
          ledger: "1200100",
          created_at: FIXTURE_CONSTANTS.TIMESTAMP,
        },
      ],
      defaults: [],
    },
  ],
  openRounds: [],
  pendingDefaults: [],
  currentRound: null,
};

/** GET /members/:member/contributions — 200 Success */
export const OPENAPI_MEMBER_CONTRIBUTIONS_FIXTURE: ApiMemberContributionsResponse = {
  member: FIXTURE_CONSTANTS.MEMBER_A,
  circle: FIXTURE_CONSTANTS.CIRCLE,
  contributions: [
    {
      circle_address: FIXTURE_CONSTANTS.CIRCLE,
      member_address: FIXTURE_CONSTANTS.MEMBER_A,
      round_index: 0,
      amount: "100000000",
      tx_hash: FIXTURE_CONSTANTS.TX_HASH,
      ledger: "1200100",
      created_at: FIXTURE_CONSTANTS.TIMESTAMP,
    },
  ],
  totalAmount: "100000000",
  pagination: {
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    hasMore: false,
    nextCursor: null,
  },
};

/** GET /reputation/:member — 200 Success */
export const OPENAPI_REPUTATION_FIXTURE = {
  member: FIXTURE_CONSTANTS.MEMBER_A,
  found: true,
  score: 10,
  detail: "2 circles completed",
  contributions: [
    {
      circle_address: FIXTURE_CONSTANTS.CIRCLE,
      contributions: 2,
      total_rounds: 2,
    },
  ],
  defaults: [
    {
      circle_address: FIXTURE_CONSTANTS.CIRCLE,
      count: 0,
    },
  ],
  events: [
    {
      type: "completed",
      delta: 1,
    },
  ],
  updatedAt: FIXTURE_CONSTANTS.TIMESTAMP,
};

/** GET /circles/:address/audit — 200 Success */
export const OPENAPI_AUDIT_EVENTS_FIXTURE: ApiAuditEventsResponse = {
  circle_address: FIXTURE_CONSTANTS.CIRCLE,
  events: [
    {
      id: 1,
      circle_address: FIXTURE_CONSTANTS.CIRCLE,
      event_type: "closed",
      triggered_by: FIXTURE_CONSTANTS.CREATOR,
      ledger: "1200100",
      tx_hash: FIXTURE_CONSTANTS.TX_HASH,
      total_released: "100000000",
      total_expected_collateral: "100000000",
      close_reason: "completed",
      created_at: FIXTURE_CONSTANTS.TIMESTAMP,
    },
  ],
  pagination: {
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    hasMore: false,
    nextCursor: null,
  },
};

/** GET /health — 200 Success */
export const OPENAPI_HEALTH_FIXTURE: ApiHealthResponse & Record<string, unknown> = {
  status: "ok",
  serviceStatus: "healthy",
  timestamp: FIXTURE_CONSTANTS.TIMESTAMP,
  db: { status: "ok", latencyMs: 2 },
  rpc: { status: "ok", latestLedger: 1250000, latencyMs: 20 },
  indexerLag: { status: "ok", latestLedger: 1250000, headLedger: 1250000, diff: 0 },
  schema: { status: "ok", applied: true, migrationVersion: 3 },
  contractDrift: { status: "ok", ok: true },
  eventFailures: { status: "ok", recentCount: 0 },
};

/** GET /indexer/health — 200 Success */
export const OPENAPI_INDEXER_HEALTH_FIXTURE = {
  status: "healthy",
  running: true,
  backfill: false,
  events: 42,
  pollCycles: 100,
  lastPoll: FIXTURE_CONSTANTS.TIMESTAMP,
  backoff: { failures: 0, waitMs: 0 },
};

/** GET /indexer/state — 200 Success */
export const OPENAPI_INDEXER_STATE_FIXTURE = {
  lastLedger: 1250000,
  updatedAt: FIXTURE_CONSTANTS.TIMESTAMP,
  totalEvents: 42,
  eventCounts: {
    circle_created: 1,
    member_joined: 2,
    contributed: 2,
    payout: 1,
  },
  entityCounts: {
    circles: 1,
    members: 2,
    contributions: 2,
    payouts: 1,
    defaults: 0,
    circlesByStatus: {
      Active: 1,
      Pending: 0,
      Completed: 0,
    },
  },
};

/** GET /circles/summary — 200 Success */
export const OPENAPI_SUMMARY_FIXTURE = {
  total: 1,
  byStatus: {
    Active: 1,
    Pending: 0,
    Completed: 0,
    Cancelled: 0,
  },
};

/** GET /circles/:address/history — 200 Success */
export const OPENAPI_HISTORY_FIXTURE = {
  circle_address: FIXTURE_CONSTANTS.CIRCLE,
  events: [
    {
      id: 1,
      circle_address: FIXTURE_CONSTANTS.CIRCLE,
      round_index: 0,
      ledger: "1200100",
      tx_hash: FIXTURE_CONSTANTS.TX_HASH,
      created_at: FIXTURE_CONSTANTS.TIMESTAMP,
      member_address: FIXTURE_CONSTANTS.MEMBER_A,
      amount: "100000000",
      is_exceptional: false,
    },
  ],
  pagination: {
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    hasMore: false,
    nextCursor: null,
  },
};

/** GET /circles/:address/reconciliation — 200 Success */
export const OPENAPI_RECONCILIATION_FIXTURE = {
  circleAddress: FIXTURE_CONSTANTS.CIRCLE,
  generatedAt: FIXTURE_CONSTANTS.TIMESTAMP,
  outcome: "reconciled",
  ledgerContext: {
    dbLedger: 1250000,
    rpcLedger: 1250000,
  },
  checked: {
    rounds: 1,
    members: 2,
    contributions: 2,
  },
  mismatches: [],
  unavailable: false,
  truncated: false,
};

/** GET /indexer/failures — 200 Success */
export const OPENAPI_FAILURES_FIXTURE = {
  failures: [],
  count: 0,
  limit: 50,
};

/** GET /indexer/schema — 200 Success */
export const OPENAPI_SCHEMA_FIXTURE = {
  state: "clean",
  summary: "Database schema is up to date",
  canStartSafely: true,
  currentVersion: "3",
  applied: ["001_initial.sql", "002_reputation.sql", "003_events.sql"],
  pending: [],
  missingOnDisk: [],
  modified: [],
};

// ─── 2. Error Families ────────────────────────────────────────────────────────

/** Legacy error envelope (HTTP 400) */
export const OPENAPI_ERROR_LEGACY_FIXTURE = {
  error: "Invalid query parameter: page must be a positive integer",
};

/** Structured error envelope (HTTP 400) */
export const OPENAPI_ERROR_STRUCTURED_FIXTURE = {
  error: {
    message: "Invalid request payload",
    details: {
      parameter: "address",
      value: "invalid-address",
    },
  },
};

/** Not Found error envelope (HTTP 404) */
export const OPENAPI_ERROR_NOT_FOUND_FIXTURE = {
  error: "Circle not found",
  address: FIXTURE_CONSTANTS.CIRCLE,
};

/** Payload Too Large error envelope (HTTP 413) */
export const OPENAPI_ERROR_PAYLOAD_TOO_LARGE_FIXTURE = {
  error: "Grouped rounds payload exceeds 100 rows per category. Query /history for complete flat records.",
};

/** Unprocessable Entity error envelope (HTTP 422) */
export const OPENAPI_ERROR_UNPROCESSABLE_ENTITY_FIXTURE = {
  error: "Reconciliation found on-chain vs indexed state mismatch",
  detail: "Contradiction detected in ledger sequence",
};

/** Too Many Requests error envelope (HTTP 429) */
export const OPENAPI_ERROR_RATE_LIMIT_FIXTURE = {
  error: "Too many requests. Please retry with exponential backoff.",
};

/** Internal Server Error envelope (HTTP 500) */
export const OPENAPI_ERROR_SERVER_FIXTURE = {
  error: "Internal server error occurred",
};

/** Service Unavailable error envelope (HTTP 503) */
export const OPENAPI_ERROR_SERVICE_UNAVAILABLE_FIXTURE = {
  error: "Indexer service is synchronizing with network",
  status: "degraded",
};

/** Canonical dictionary of all OpenAPI fixtures mapped to their schema name */
export const ALL_OPENAPI_RESPONSE_FIXTURES = {
  circlesList: OPENAPI_CIRCLES_LIST_FIXTURE,
  circleDetail: OPENAPI_CIRCLE_DETAIL_FIXTURE,
  members: OPENAPI_MEMBERS_FIXTURE,
  rounds: OPENAPI_ROUNDS_FIXTURE,
  memberContributions: OPENAPI_MEMBER_CONTRIBUTIONS_FIXTURE,
  reputation: OPENAPI_REPUTATION_FIXTURE,
  auditEvents: OPENAPI_AUDIT_EVENTS_FIXTURE,
  health: OPENAPI_HEALTH_FIXTURE,
  indexerState: OPENAPI_INDEXER_STATE_FIXTURE,
  summary: OPENAPI_SUMMARY_FIXTURE,
  Summary: OPENAPI_SUMMARY_FIXTURE,
  history: OPENAPI_HISTORY_FIXTURE,
  History: OPENAPI_HISTORY_FIXTURE,
  reconciliation: OPENAPI_RECONCILIATION_FIXTURE,
  Reconciliation: OPENAPI_RECONCILIATION_FIXTURE,
  failures: OPENAPI_FAILURES_FIXTURE,
  Failures: OPENAPI_FAILURES_FIXTURE,
  Schema: OPENAPI_SCHEMA_FIXTURE,
  schema: OPENAPI_SCHEMA_FIXTURE,
  IndexerHealth: OPENAPI_INDEXER_HEALTH_FIXTURE,
  errorLegacy: OPENAPI_ERROR_LEGACY_FIXTURE,
  errorStructured: OPENAPI_ERROR_STRUCTURED_FIXTURE,
  errorNotFound: OPENAPI_ERROR_NOT_FOUND_FIXTURE,
  errorPayloadTooLarge: OPENAPI_ERROR_PAYLOAD_TOO_LARGE_FIXTURE,
  errorUnprocessable: OPENAPI_ERROR_UNPROCESSABLE_ENTITY_FIXTURE,
  errorRateLimit: OPENAPI_ERROR_RATE_LIMIT_FIXTURE,
  errorServer: OPENAPI_ERROR_SERVER_FIXTURE,
  errorServiceUnavailable: OPENAPI_ERROR_SERVICE_UNAVAILABLE_FIXTURE,
} as const;
