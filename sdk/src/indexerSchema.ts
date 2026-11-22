// ─── Indexer response wire contracts ──────────────────────────────────────────
//
// Runtime descriptions of the JSON bodies returned by the public indexer
// endpoints, used to detect silent wire drift — renamed fields, changed
// nullability, or a numeric field switching between a JSON number and a
// string — that still arrives as HTTP 200.
//
// The compatibility fixtures in __tests__/indexerResponseFixtures.ts are
// validated against these schemas, and IndexerClient performs a shallow
// envelope check on every response. See docs/INDEXER_API_COMPATIBILITY.md for
// the policy that distinguishes safe additions from breaking changes.
//
// Compatibility rules encoded here:
//   • Unknown fields are ignored by `validateIndexerResponse` — adding a field
//     is a compatible change. `listUnknownFields` reports them so the fixtures
//     and schemas can be kept in sync deliberately.
//   • A required field that disappears, becomes null without `nullable`, or
//     changes wire type is a violation — that is a breaking change.

/**
 * Wire representation of a single JSON value.
 *
 * | Type        | Accepted JSON                                              |
 * |-------------|------------------------------------------------------------|
 * | `string`    | any string                                                 |
 * | `integer`   | a JSON number that is a safe integer                       |
 * | `boolean`   | `true` / `false`                                           |
 * | `stroops`   | a decimal integer **string** (e.g. `"100000000"`) — monetary amounts must never be JSON numbers, which lose precision above 2^53 |
 * | `uint_string` | a non-negative decimal integer **string** (e.g. `"1200000"`) — persisted Postgres BIGINT columns (row-level ledger sequences, `round_deadline_ledgers`) |
 * | `bigint`    | **legacy, lenient** — a non-negative integer as a JSON number *or* decimal string. No built-in schema uses it any more (issue #897); kept so external schemas that reference it keep compiling |
 * | `timestamp` | an ISO-8601 string that `Date.parse` accepts               |
 * | `object`    | a JSON object validated against `fields`                   |
 * | `array`     | a JSON array whose elements match `items`                  |
 * | `record`    | a JSON object with arbitrary keys whose values match `values` |
 */
export type IndexerWireType =
  | "string"
  | "integer"
  | "boolean"
  | "stroops"
  | "uint_string"
  | "bigint"
  | "timestamp"
  | "object"
  | "array"
  | "record";

/**
 * Deprecation metadata for a field or endpoint (issue #149).
 *
 * A deprecated field stays accepted by `validateIndexerResponse` for the whole
 * migration window, so old and new response forms both validate. The marker is
 * documentation plus an observable sunset signal; it never makes a response
 * invalid on its own.
 */
export interface IndexerDeprecation {
  /** Version (or date) in which the field/endpoint was first deprecated. */
  since: string;
  /** Last version (or date) in which the field/endpoint is still served. */
  sunset: string;
  /** Field name (or endpoint) that replaces it, when there is one. */
  replacement?: string;
}

/** Contract for one field (or array element / record value). */
export interface IndexerFieldSpec {
  type: IndexerWireType;
  /** `null` is an accepted value. */
  nullable?: boolean;
  /** The key may be absent (or `undefined`, which JSON omits). */
  optional?: boolean;
  /** For `string`: the closed set of accepted values. */
  enum?: readonly string[];
  /** For `object`: the nested field contracts. */
  fields?: IndexerObjectSchema;
  /** For `array`: the contract every element must satisfy. */
  items?: IndexerFieldSpec;
  /** For `record`: the contract every value must satisfy. */
  values?: IndexerFieldSpec;
  /** Deprecation window — the field is still accepted while set. */
  deprecated?: IndexerDeprecation;
  /**
   * Legacy wire forms still accepted during a transition (issue #149).
   *
   * When present, a value that fails the primary `type` check is retried
   * against each alternative spec; the field is only a violation when every
   * form fails. Use this to accept both the old and new encoding of a field
   * while it is marked `deprecated`.
   */
  legacy?: readonly IndexerFieldSpec[];
}

/** Field contracts for a JSON object, keyed by field name. */
export type IndexerObjectSchema = Record<string, IndexerFieldSpec>;

/**
 * An endpoint schema entry: the field contracts plus optional endpoint-level
 * deprecation metadata (issue #149).
 */
export type IndexerEndpointSchema = {
  [key: string]: IndexerFieldSpec | IndexerDeprecation | undefined;
  /** Deprecation window for the whole endpoint, when it is being retired. */
  deprecated?: IndexerDeprecation;
};

/** One mismatch between a response body and its schema. */
export interface IndexerSchemaViolation {
  /** JSONPath-style location, e.g. `$.circles[0].round_amount`. */
  path: string;
  /** What the schema requires at `path`. */
  expected: string;
  /** What was found (a type name, never the raw value). */
  actual: string;
}

// ── Spec builders ──────────────────────────────────────────────────────────────

const str = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "string", ...extra });
const int = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "integer", ...extra });
const bool = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "boolean", ...extra });
const stroops = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "stroops", ...extra });
/** Persisted BIGINT column — always a decimal string on the wire. */
const seq = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "uint_string", ...extra });
const ts = (extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({ type: "timestamp", ...extra });
const obj = (fields: IndexerObjectSchema, extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({
  type: "object",
  fields,
  ...extra,
});
const arr = (items: IndexerFieldSpec, extra?: Partial<IndexerFieldSpec>): IndexerFieldSpec => ({
  type: "array",
  items,
  ...extra,
});
const rec = (values: IndexerFieldSpec): IndexerFieldSpec => ({ type: "record", values });

// ── Shared row schemas ─────────────────────────────────────────────────────────

const CIRCLE_STATUSES = ["Pending", "Active", "Completed", "Cancelled", "Closed"] as const;
const ROUND_PHASES = ["completed", "current", "cancelled", "open"] as const;

const PAGINATION = obj({
  page: int(),
  limit: int(),
  total: int(),
  totalPages: int(),
  hasMore: bool({ optional: true }),
  // Opaque keyset continuation token (issue #898). Sent by the cursor-capable
  // history endpoints only; `null` on the last page.
  nextCursor: str({ optional: true, nullable: true }),
});

/**
 * Envelope of a keyset (cursor) page — issue #898. Cursor pages skip the
 * COUNT(*) so they carry no `page` / `total` / `totalPages`.
 */
const CURSOR_PAGINATION = obj({
  limit: int(),
  hasMore: bool(),
  nextCursor: str({ nullable: true }),
});

/** ApiCircleRow — GET /circles rows and the `circle` of GET /circles/:address. */
const CIRCLE_ROW: IndexerObjectSchema = {
  address: str(),
  creator: str(),
  round_amount: stroops(),
  member_count: int(),
  status: str({ enum: CIRCLE_STATUSES }),
  current_round: int(),
  total_rounds: int(),
  created_ledger: seq(),
  updated_at: ts(),
  // Detail-only fields (the detail endpoint selects every column).
  id: int({ optional: true }),
  // Computed in JS from created_ledger — a JSON integer.
  deadline_ledger: int({ optional: true, nullable: true }),
  round_deadline_ledgers: seq({ optional: true, nullable: true }),
};

/** ApiMemberRow — GET /circles/:address and GET /circles/:address/members. */
const MEMBER_ROW: IndexerObjectSchema = {
  member_address: str(),
  payout_order: int(),
  join_order: int({ nullable: true }),
  collateral: stroops(),
  defaults: int(),
  joined_at: ts({ nullable: true }),
  // LEFT JOIN on reputation: null for members with no reputation row yet.
  reputation_score: int({ nullable: true }),
  // Present on the members endpoint, which aggregates contributions.
  total_contributions: int({ optional: true }),
  // `SELECT cm.*` on the detail endpoint also exposes the row identity.
  id: int({ optional: true }),
  circle_address: str({ optional: true }),
};

/** A contribution row nested in a round (`SELECT * FROM contributions`). */
const ROUND_CONTRIBUTION = obj({
  member_address: str(),
  amount: stroops(),
  tx_hash: str(),
  id: int({ optional: true }),
  circle_address: str({ optional: true }),
  round_index: int({ optional: true }),
  ledger: seq({ optional: true }),
  created_at: ts({ optional: true }),
});

/** A default row (`SELECT * FROM defaults`). */
const DEFAULT_ROW = obj({
  member_address: str(),
  penalty: stroops(),
  id: int({ optional: true }),
  circle_address: str({ optional: true }),
  round_index: int({ optional: true }),
  tx_hash: str({ optional: true }),
  ledger: seq({ optional: true }),
  created_at: ts({ optional: true }),
});

/** ApiRoundRow — one grouped round from GET /circles/:address/rounds. */
const ROUND_ROW = obj({
  roundIndex: int(),
  status: str({ enum: ROUND_PHASES }),
  recipient: str({ nullable: true }),
  amount: stroops({ nullable: true }),
  txHash: str({ nullable: true }),
  ledger: seq({ optional: true, nullable: true }),
  // Computed in JS — a JSON integer.
  deadlineLedger: int({ optional: true, nullable: true }),
  contributions: arr(ROUND_CONTRIBUTION),
  defaults: arr(DEFAULT_ROW),
});

/** One row of GET /members/:member/contributions. */
const MEMBER_CONTRIBUTION_ROW = obj({
  circle_address: str(),
  member_address: str(),
  round_index: int(),
  amount: stroops(),
  tx_hash: str(),
  ledger: seq(),
  created_at: ts(),
});

/** One event of GET /circles/:address/activity. */
const ACTIVITY_EVENT = obj({
  type:           str(),
  actor:          str(),
  round:          int(),
  amount:         stroops({ nullable: true }),
  penalty:        stroops({ nullable: true }),
  tx_hash:        str(),
  // toSafeInteger(ledger) in the handler — a JSON integer.
  ledger:         int(),
  event_position: int(),
  id:             str(),
  timestamp:      ts({ nullable: true }),
});

// ── Endpoint schemas ───────────────────────────────────────────────────────────

/**
 * Response contracts for every public indexer endpoint the SDK or app reads.
 *
 * Keys are stable identifiers; the comment on each names its route.
 */
export const INDEXER_RESPONSE_SCHEMAS = {
  /** GET /circles */
  circlesList: {
    circles: arr(obj(CIRCLE_ROW)),
    pagination: PAGINATION,
  },
  /** GET /circles/:address */
  circleDetail: {
    circle: obj(CIRCLE_ROW),
    members: arr(obj(MEMBER_ROW)),
    // Number(indexer_state.last_ledger) — a JSON integer.
    latestLedger: int({ nullable: true }),
  },
  /** GET /circles/:address/members */
  members: {
    members: arr(obj(MEMBER_ROW)),
    totals: obj(
      {
        memberCount: int(),
        totalCollateral: stroops(),
        totalContributions: int(),
      },
      { optional: true },
    ),
    roundDeadlineLedgers: seq({ optional: true, nullable: true }),
  },
  /** GET /circles/:address/rounds */
  rounds: {
    rounds: arr(ROUND_ROW),
    openRounds: arr(ROUND_ROW),
    pendingDefaults: arr(DEFAULT_ROW),
    currentRound: { ...ROUND_ROW, nullable: true },
  },
  /** GET /members/:member/contributions */
  memberContributions: {
    member: str(),
    circle: str({ nullable: true }),
    contributions: arr(MEMBER_CONTRIBUTION_ROW),
    totalAmount: stroops({ optional: true }),
    pagination: PAGINATION,
  },
  /** GET /members/:member/contributions?cursor= (issue #898) */
  memberContributionsCursor: {
    member: str(),
    circle: str({ nullable: true }),
    contributions: arr(MEMBER_CONTRIBUTION_ROW),
    totalAmount: stroops({ optional: true }),
    pagination: CURSOR_PAGINATION,
  },
  /** GET /reputation/:member */
  reputation: {
    member: str(),
    found: bool(),
    score: int({ nullable: true }),
    detail: str({ optional: true }),
    contributions: arr(
      obj({ circle_address: str(), contributions: int(), total_rounds: int() }),
    ),
    defaults: arr(obj({ circle_address: str(), count: int() })),
    events: arr(obj({ type: str(), delta: int() }), { optional: true }),
    updatedAt: ts({ nullable: true }),
  },
  /** GET /circles/:address/audit */
  auditEvents: {
    circle_address: str(),
    events: arr(
      obj({
        id: int(),
        circle_address: str(),
        event_type: str({ enum: ["cancelled", "closed"] }),
        triggered_by: str({ nullable: true }),
        ledger: seq({ nullable: true }),
        tx_hash: str({ nullable: true }),
        total_released: stroops({ nullable: true }),
        total_expected_collateral: stroops({ nullable: true }),
        close_reason: str({ nullable: true }),
        created_at: ts(),
      }),
    ),
  },
  /**
   * GET /health — only the fields the SDK's ApiHealthResponse relies on are
   * required; the component breakdown is operator-facing and may evolve.
   */
  health: {
    status: str({ enum: ["ok", "degraded"] }),
    timestamp: ts(),
    serviceStatus: str({ optional: true, enum: ["healthy", "degraded", "unavailable"] }),
  },
  /** GET /indexer/state */
  indexerState: {
    // Number(indexer_state.last_ledger) — a JSON integer.
    lastLedger: int(),
    updatedAt: ts(),
    totalEvents: int(),
    eventCounts: rec(int()),
    entityCounts: obj({
      circles: int(),
      members: int(),
      contributions: int(),
      payouts: int(),
      defaults: int(),
      circlesByStatus: rec(int()),
    }),
  },
  /** GET /members/:member/circles */
  memberCircles: {
    circles: arr(
      obj({
        circle: obj(CIRCLE_ROW),
        member: obj({
          payout_order:        int(),
          join_order:          int({ nullable: true }),
          collateral:          stroops(),
          defaults:            int(),
          joined_at:           ts({ nullable: true }),
          reputation_score:    int({ nullable: true }),
          total_contributions: int(),
        }),
      }),
    ),
    pagination: PAGINATION,
  },
  /** GET /circles/:address/activity */
  circleActivity: {
    circle_address: str(),
    events: arr(ACTIVITY_EVENT),
    pagination: PAGINATION,
  },
  /** GET /circles/:address/activity?cursor= (issue #898) */
  circleActivityCursor: {
    circle_address: str(),
    events: arr(ACTIVITY_EVENT),
    pagination: CURSOR_PAGINATION,
  },
} satisfies Record<string, IndexerEndpointSchema>;

/** Identifier of a schema in {@link INDEXER_RESPONSE_SCHEMAS}. */
export type IndexerEndpointName = keyof typeof INDEXER_RESPONSE_SCHEMAS;

// ── Validation ─────────────────────────────────────────────────────────────────

const STROOPS_RE = /^-?\d+$/;
const UINT_STRING_RE = /^\d+$/;

/** Describe a value's JSON type without echoing the value itself. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkField(
  spec: IndexerFieldSpec,
  value: unknown,
  path: string,
  out: IndexerSchemaViolation[],
): void {
  if (value === undefined) {
    if (!spec.optional) out.push({ path, expected: spec.type, actual: "missing" });
    return;
  }
  if (value === null) {
    if (!spec.nullable) out.push({ path, expected: spec.type, actual: "null" });
    return;
  }

  // Transition window (issue #149): a deprecated field may still arrive in a
  // legacy wire form. Accept it when any alternative form validates.
  if (spec.legacy && spec.legacy.length > 0) {
    const primary: IndexerSchemaViolation[] = [];
    checkField({ ...spec, legacy: undefined }, value, path, primary);
    if (primary.length === 0) return;
    for (const alt of spec.legacy) {
      const altOut: IndexerSchemaViolation[] = [];
      checkField(alt, value, path, altOut);
      if (altOut.length === 0) return;
    }
    out.push(...primary);
    return;
  }

  const mismatch = (expected: string, actual = describe(value)): void => {
    out.push({ path, expected, actual });
  };

  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return mismatch("string");
      if (spec.enum && !spec.enum.includes(value)) {
        return mismatch(`one of ${spec.enum.join(" | ")}`, "unlisted string");
      }
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return mismatch("integer");
      return;
    case "boolean":
      if (typeof value !== "boolean") return mismatch("boolean");
      return;
    case "stroops":
      if (typeof value !== "string") return mismatch("decimal integer string");
      if (!STROOPS_RE.test(value)) return mismatch("decimal integer string", "non-numeric string");
      return;
    case "uint_string":
      if (typeof value !== "string") return mismatch("decimal integer string");
      if (!UINT_STRING_RE.test(value)) return mismatch("decimal integer string", "non-numeric string");
      return;
    case "bigint":
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) return mismatch("non-negative integer");
        return;
      }
      if (typeof value === "string") {
        if (!UINT_STRING_RE.test(value)) return mismatch("non-negative integer", "non-numeric string");
        return;
      }
      return mismatch("non-negative integer");
    case "timestamp":
      if (typeof value !== "string") return mismatch("ISO-8601 timestamp");
      if (Number.isNaN(Date.parse(value))) return mismatch("ISO-8601 timestamp", "unparseable string");
      return;
    case "object":
      if (!isPlainObject(value)) return mismatch("object");
      checkObject(spec.fields ?? {}, value, path, out);
      return;
    case "array":
      if (!Array.isArray(value)) return mismatch("array");
      if (spec.items) {
        value.forEach((item, i) => checkField(spec.items!, item, `${path}[${i}]`, out));
      }
      return;
    case "record":
      if (!isPlainObject(value)) return mismatch("object");
      if (spec.values) {
        for (const [key, item] of Object.entries(value)) {
          checkField(spec.values, item, `${path}.${key}`, out);
        }
      }
      return;
  }
}

function checkObject(
  schema: IndexerObjectSchema,
  value: Record<string, unknown>,
  path: string,
  out: IndexerSchemaViolation[],
): void {
  for (const [key, spec] of Object.entries(schema)) {
    // Endpoint-level `deprecated` metadata is not a field contract.
    if (key === "deprecated") continue;
    checkField(spec, value[key], `${path}.${key}`, out);
  }
}

/**
 * Validate a decoded JSON body against an endpoint schema.
 *
 * Returns every violation found (empty when the body is compatible). Fields
 * the schema does not mention are ignored, so additive server changes pass.
 * Violation entries describe types only and never include response values,
 * so they are safe to log.
 *
 * @example
 * const problems = validateIndexerResponse("circlesList", await res.json());
 * if (problems.length > 0) console.warn("indexer drift", problems);
 */
export function validateIndexerResponse(
  endpoint: IndexerEndpointName,
  body: unknown,
): IndexerSchemaViolation[] {
  const out: IndexerSchemaViolation[] = [];
  if (!isPlainObject(body)) {
    out.push({ path: "$", expected: "object", actual: describe(body) });
    return out;
  }
  checkObject(INDEXER_RESPONSE_SCHEMAS[endpoint], body, "$", out);
  return out;
}

/**
 * List fields present in `body` that the endpoint schema does not describe.
 *
 * Unknown fields are compatible by policy; this helper exists so fixture
 * tests can require every new field to be documented in the schema before
 * clients start depending on it. Record-typed values are not descended into
 * since their keys are data, not contract.
 */
export function listUnknownFields(endpoint: IndexerEndpointName, body: unknown): string[] {
  const out: string[] = [];
  const walk = (schema: IndexerObjectSchema, value: unknown, path: string) => {
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "deprecated") continue;
      const spec = schema[key];
      const childPath = `${path}.${key}`;
      if (!spec) {
        out.push(childPath);
        continue;
      }
      walkSpec(spec, child, childPath);
    }
  };
  const walkSpec = (spec: IndexerFieldSpec, value: unknown, path: string) => {
    if (spec.type === "object" && spec.fields) walk(spec.fields, value, path);
    if (spec.type === "array" && spec.items && Array.isArray(value)) {
      value.forEach((item, i) => walkSpec(spec.items!, item, `${path}[${i}]`));
    }
  };
  walk(INDEXER_RESPONSE_SCHEMAS[endpoint], body, "$");
  return out;
}

/**
 * List the deprecation markers declared by an endpoint schema (issue #149).
 *
 * Returns one entry per deprecated field (with its JSONPath-style location)
 * plus an entry for the endpoint itself when it is deprecated. Used by the
 * compatibility tests and by tooling that reports upcoming sunsets.
 */
export function listDeprecations(
  endpoint: IndexerEndpointName,
): Array<{ path: string; deprecated: IndexerDeprecation }> {
  const out: Array<{ path: string; deprecated: IndexerDeprecation }> = [];
  const walk = (schema: IndexerObjectSchema, path: string) => {
    for (const [key, spec] of Object.entries(schema)) {
      if (key === "deprecated") {
        const marker = (schema as IndexerEndpointSchema).deprecated;
        if (marker) out.push({ path, deprecated: marker });
        continue;
      }
      const childPath = `${path}.${key}`;
      if (spec.deprecated) out.push({ path: childPath, deprecated: spec.deprecated });
      if (spec.type === "object" && spec.fields) walk(spec.fields, childPath);
      if (spec.type === "array" && spec.items) walkSpec(spec.items, `${childPath}[]`);
    }
  };
  const walkSpec = (spec: IndexerFieldSpec, path: string) => {
    if (spec.deprecated) out.push({ path, deprecated: spec.deprecated });
    if (spec.type === "object" && spec.fields) walk(spec.fields, path);
    if (spec.type === "array" && spec.items) walkSpec(spec.items, `${path}[]`);
  };
  walk(INDEXER_RESPONSE_SCHEMAS[endpoint], "$");
  return out;
}
