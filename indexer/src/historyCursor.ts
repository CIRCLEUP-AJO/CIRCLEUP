/**
 * Issue #898: opaque keyset cursors for large history scans.
 *
 * Offset pagination (`?page=`) re-scans every earlier row and shifts when rows
 * are inserted between requests, which can duplicate or skip records. The
 * history endpoints below also accept `?cursor=`, which continues strictly
 * after the last row of the previous page using that endpoint's full,
 * unique ORDER BY key:
 *
 * | Endpoint                          | Order (= keyset)                                        | Unique because |
 * |-----------------------------------|---------------------------------------------------------|----------------|
 * | GET /circles/:address/activity    | ledger ASC, event_position ASC, sort_id ASC             | event_position names the source table, sort_id is that table's SERIAL id |
 * | GET /members/:member/contributions| ledger DESC, round_index DESC, created_at DESC, id DESC | id is the contributions SERIAL id |
 *
 * The page-based ordering of each endpoint is identical, so a client can read
 * page 1 with `?page=1` and continue with the `nextCursor` it returns.
 *
 * Mutation model: indexed history rows are append-only and new events arrive
 * at ledgers at or above the indexer's checkpoint. Under that model every row
 * that existed when a scan started is returned exactly once:
 *   • activity (ascending): rows inserted between page fetches sort after the
 *     cursor and appear on a later page;
 *   • contributions (newest first): rows inserted between page fetches sort
 *     before the cursor and are not part of the running scan — start a new
 *     scan to see them.
 * A backfill that inserts rows at ledgers *older* than an ascending cursor is
 * outside this model; those rows are only seen by a new scan.
 *
 * Cursor tokens are opaque: base64url JSON carrying a format version, the
 * endpoint scope, the query filter it was issued for, and the key values of
 * the last row. Column names and SQL never appear in a token. A token is
 * rejected (HTTP 400) when it is malformed, from another format version, or
 * was issued for a different endpoint or filter. A token whose row has since
 * been deleted (e.g. replay after a reorg) is still a valid position — keyset
 * comparison does not need the row to exist.
 *
 * Wire contract and deprecation policy (see docs/api-deprecation-policy.md):
 * the cursor token is a versioned wire format. `HISTORY_CURSOR_VERSION` is the
 * version of the token layout that this build *emits*, and it is part of the
 * public API contract exactly like a field name or status value.
 *
 *   • The token layout (payload keys, key ordering, value encoding) and each
 *     endpoint's keyset are frozen for a given version. Any change to them —
 *     adding/removing/renaming a payload field, reordering keys, changing how
 *     a key value is encoded, or changing an endpoint's ORDER BY — requires a
 *     new `HISTORY_CURSOR_VERSION`; the existing version must never be mutated
 *     in place, because tokens already handed to clients are still in flight.
 *   • A version bump is a wire-breaking change and follows the API deprecation
 *     policy: it is announced with a deprecation notice and a migration window
 *     before tokens of the old version stop being accepted. During the
 *     transition the parser accepts both the old and the new version (see
 *     {@link SUPPORTED_CURSOR_VERSIONS}) so a scan started before the rollout
 *     can finish after it.
 *   • Minimum support window: a superseded cursor version remains accepted for
 *     at least {@link CURSOR_VERSION_MIN_SUPPORT_DAYS} days after the new
 *     version is generally available, and never less than one full release
 *     cycle. Only after that window may the old version be rejected (HTTP 400
 *     with {@link INVALID_CURSOR_ERROR}, which already tells clients to restart
 *     the scan without a cursor).
 *   • Clients must treat tokens as opaque and must not construct, inspect, or
 *     persist them across a version change; restarting a scan without a cursor
 *     is always a valid recovery path.
 */

/** Bumped whenever the token layout or an endpoint's keyset changes. */
export const HISTORY_CURSOR_VERSION = 1;

/**
 * Minimum number of days a superseded cursor version stays accepted after the
 * replacement version is generally available (see the wire contract above).
 */
export const CURSOR_VERSION_MIN_SUPPORT_DAYS = 90;

/**
 * Cursor token versions this build accepts. Contains the current version and,
 * during a transition, the previous version(s) still inside their support
 * window. A token whose `v` is not listed here is rejected as invalid.
 */
export const SUPPORTED_CURSOR_VERSIONS: readonly number[] = [HISTORY_CURSOR_VERSION];

/** Upper bound on an accepted token, to keep validation cheap. */
export const MAX_CURSOR_LENGTH = 512;

export type HistoryCursorScope = "activity" | "contributions";

/** Type of one key component, used to validate decoded values. */
export type CursorKeyPart = "uint" | "int" | "timestamp";

/** Key layout of each cursor-capable endpoint (must match its ORDER BY). */
export const HISTORY_CURSOR_KEYS: Record<HistoryCursorScope, readonly CursorKeyPart[]> = {
  // ledger, event_position, sort_id
  activity: ["uint", "int", "int"],
  // ledger, round_index, created_at, id
  contributions: ["uint", "int", "timestamp", "int"],
};

interface CursorPayload {
  v: number;
  s: HistoryCursorScope;
  f: string;
  k: string[];
}

const UINT_RE = /^(0|[1-9][0-9]{0,18})$/;
const INT_RE = /^(0|[1-9][0-9]{0,9})$/;
// Postgres timestamptz text output (e.g. "2026-01-02 00:00:00.123456+00") or ISO-8601.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;
const INT32_MAX = 2_147_483_647;
const BIGINT_MAX = 9_223_372_036_854_775_807n;

function validPart(kind: CursorKeyPart, value: unknown): value is string {
  if (typeof value !== "string") return false;
  switch (kind) {
    case "uint":
      return UINT_RE.test(value) && BigInt(value) <= BIGINT_MAX;
    case "int":
      return INT_RE.test(value) && Number(value) <= INT32_MAX;
    case "timestamp":
      return TIMESTAMP_RE.test(value);
  }
}

/**
 * Encode the key of the last row on a page as an opaque cursor.
 *
 * @param scope  Endpoint the cursor belongs to.
 * @param filter Canonical description of the query filter (e.g. the circle
 *               address); a cursor only continues the query it came from.
 * @param key    Key values of the last row, in {@link HISTORY_CURSOR_KEYS} order.
 */
export function encodeHistoryCursor(
  scope: HistoryCursorScope,
  filter: string,
  key: ReadonlyArray<string | number | bigint>,
): string {
  const payload: CursorPayload = {
    v: HISTORY_CURSOR_VERSION,
    s: scope,
    f: filter,
    k: key.map((part) => String(part)),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Result of {@link parseHistoryCursor}. */
export type ParsedHistoryCursor =
  /** No `?cursor=` parameter: page-based mode. */
  | { mode: "page" }
  /** `?cursor=` (empty): start a cursor scan from the first row. */
  | { mode: "cursor"; after: null }
  /** `?cursor=<token>`: continue strictly after `after`. */
  | { mode: "cursor"; after: string[] }
  | { error: string };

export const INVALID_CURSOR_ERROR =
  "cursor is invalid, expired, or was issued for a different query; restart the scan without a cursor";

/**
 * Validate a `?cursor=` query value for `scope` / `filter`.
 *
 * Never throws: every malformed input yields `{ error }` so the endpoint can
 * answer HTTP 400 without exposing decoding details.
 */
export function parseHistoryCursor(
  raw: unknown,
  scope: HistoryCursorScope,
  filter: string,
): ParsedHistoryCursor {
  if (raw === undefined) return { mode: "page" };
  if (typeof raw !== "string") return { error: "cursor must be a single string value" };
  if (raw === "") return { mode: "cursor", after: null };
  if (raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return { error: INVALID_CURSOR_ERROR };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { error: INVALID_CURSOR_ERROR };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: INVALID_CURSOR_ERROR };
  }
  const p = payload as Partial<CursorPayload>;
  const layout = HISTORY_CURSOR_KEYS[scope];
  if (
    typeof p.v !== "number" ||
    !SUPPORTED_CURSOR_VERSIONS.includes(p.v) ||
    p.s !== scope ||
    p.f !== filter ||
    !Array.isArray(p.k) ||
    p.k.length !== layout.length ||
    !layout.every((kind, i) => validPart(kind, p.k![i]))
  ) {
    return { error: INVALID_CURSOR_ERROR };
  }
  return { mode: "cursor", after: p.k as string[] };
}
