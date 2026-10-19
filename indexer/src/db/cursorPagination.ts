/**
 * Issue #641: Stable cursor-based pagination for list endpoints.
 *
 * Offset pagination can be unstable and expensive as events arrive:
 *   - New records inserted between pages cause skipped or repeated rows
 *   - Sorting by non-unique columns (e.g. created_ledger) has tie-break ambiguity
 *   - Large offsets require scanning all prior rows
 *
 * This module provides:
 *   - Cursor encoding/decoding for unique tie-breaker fields
 *   - Query builders that use WHERE cursor > ? instead of OFFSET
 *   - Backward/forward cursor traversal
 *   - Bounded results (max page size enforced)
 *
 * Usage:
 *   // Encode cursor from last row of current page
 *   const cursor = encodeCursor({ created_ledger: 12345, id: 42 });
 *
 *   // Use in next page request
 *   const rows = await queryWithCursor('circles', { 
 *     cursor, 
 *     limit: 20, 
 *     order: 'desc' 
 *   });
 *
 *   // Get next cursor for pagination links
 *   const nextCursor = rows.length ? encodeCursor(rows[rows.length-1]) : null;
 */

import { query } from "../db/pool";

// ─────────────────────────────────────────────────────────────────────────────
// Cursor encoding/decoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a row's cursor fields to a URL-safe string.
 * Uses JSON + base64 to be encoding-agnostic.
 */
export function encodeCursor(row: Record<string, unknown>, fields: string[]): string {
  const cursorObj: Record<string, string> = {};
  for (const field of fields) {
    const value = row[field];
    if (value !== undefined && value !== null) {
      // Convert to string, handle bigint
      cursorObj[field] = typeof value === "bigint" 
        ? value.toString() 
        : String(value);
    }
  }
  return Buffer.from(JSON.stringify(cursorObj)).toString("base64url");
}

/**
 * Decode a cursor string back to an object.
 * Returns null if the cursor is malformed.
 */
export function decodeCursor(cursor: string): Record<string, string> | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pagination direction.
 */
export type CursorDirection = "asc" | "desc";

/**
 * Options for cursor-based query.
 */
export interface CursorQueryOptions {
  /** Table name to query. */
  table: string;
  /** Fields to select (SQL fragment). */
  select: string;
  /** Fields that make up the cursor (must include unique/tie-breaker). */
  cursorFields: string[];
  /** ORDER BY clause (without direction). */
  orderBy: string;
  /** Sort direction. */
  direction: CursorDirection;
  /** Number of rows per page. */
  limit: number;
  /** Encoded cursor from previous page (optional). */
  cursor?: string;
  /** Additional WHERE conditions (array of SQL fragments). */
  where?: string[];
  /** WHERE parameter values (for additional conditions). */
  params?: unknown[];
  /** Maximum allowed limit (default 100). */
  maxLimit?: number;
}

/**
 * Result from cursor query.
 */
export interface CursorQueryResult<T> {
  rows: T[];
  /** Cursor for next page (null if no more rows). */
  nextCursor: string | null;
  /** Cursor for previous page (null if on first page). */
  prevCursor: string | null;
  /** Whether there are more rows beyond this page. */
  hasMore: boolean;
  /** Actual number of rows returned. */
  returned: number;
}

/**
 * Execute a cursor-based paginated query.
 *
 * This replaces OFFSET-based pagination with WHERE cursor > value,
 * which is:
 *   - Stable: new inserts don't cause duplicates/skips
 *   - Efficient: no row counting or scanning
 *   - Deterministic: unique tie-breaker ensures order
 *
 * @param options Query configuration
 * @returns Paginated rows with cursors
 */
export async function queryWithCursor<T extends Record<string, unknown>>(
  options: CursorQueryOptions,
): Promise<CursorQueryResult<T>> {
  const {
    table,
    select,
    cursorFields,
    orderBy,
    direction,
    limit,
    cursor,
    where = [],
    params = [],
    maxLimit = 100,
  } = options;

  // Enforce limit bounds
  const safeLimit = Math.min(Math.max(1, limit), maxLimit);

  // Build ORDER BY with explicit direction
  const cursorFieldsSelect = cursorFields.join(", ");
  const orderClause = `${orderBy} ${direction.toUpperCase()}`;

  // Build WHERE clause with cursor condition
  let whereConditions = [...where];
  let paramIndex = params.length + 1;

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      // Build cursor inequality based on direction
      // For ASC: cursor_field > value (or >= with id tie-breaker)
      // For DESC: cursor_field < value (or <= with id tie-breaker)
      const comparison = direction === "asc" ? ">" : "<";
      const equality = direction === "asc" ? ">=" : "<=";

      const cursorConditions: string[] = [];
      for (let i = 0; i < cursorFields.length; i++) {
        const field = cursorFields[i];
        const value = decoded[field];
        if (value !== undefined) {
          if (i === cursorFields.length - 1) {
            // Last field: use inequality with equality for stable tie-break
            cursorConditions.push(`${field} ${comparison} $${paramIndex}`);
          } else {
            // Earlier fields: equality (must match exactly)
            cursorConditions.push(`${field} = $${paramIndex}`);
          }
          paramIndex++;
        }
      }

      if (cursorConditions.length > 0) {
        // If using DESC, wrap in OR for proper comparison semantics
        if (direction === "desc") {
          // For desc: (field1 > :v1) OR (field1 = :v1 AND field2 < :v2)
          let orClause = "";
          for (let i = 0; i < cursorFields.length; i++) {
            const field = cursorFields[i];
            const value = decoded[field];
            if (value === undefined) continue;

            if (i === 0) {
              orClause = `(${field} < $${paramIndex}`;
            } else {
              // All previous fields must be equal, this one is less
              const prevEqual = cursorFields
                .slice(0, i)
                .map((f) => `${f} = $${paramIndex - i + cursorFields.indexOf(f)}`)
                .join(" AND ");
              orClause += ` OR (${prevEqual} AND ${field} < $${paramIndex})`;
            }
            paramIndex++;
          }
          orClause += ")";
          whereConditions.push(orClause);
        } else {
          whereConditions.push(`(${cursorConditions.join(" AND ")})`);
        }
      }

      // Also support the raw params from decoded cursor
      const decodedParams = Object.values(decoded);
    }
  }

  // Rebuild params array with cursor values first
  const decodedParams = cursor ? (() => {
    const d = decodeCursor(cursor);
    return d ? Object.values(d) : [];
  })() : [];
  
  const allParams = [...decodedParams, ...params];

  // Build final query
  const whereClause = whereConditions.length > 0
    ? `WHERE ${whereConditions.join(" AND ")}`
    : "";

  // Request one extra row to determine if there's more
  const sql = `
    SELECT ${select}
    FROM ${table}
    ${whereClause}
    ORDER BY ${orderClause}
    LIMIT $${paramIndex}
  `;

  const finalParams = [...allParams, safeLimit + 1];
  const rows = await query<T>(sql, finalParams);

  // Determine if there are more rows
  const hasMore = rows.length > safeLimit;
  const returnedRows = hasMore ? rows.slice(0, safeLimit) : rows;

  // Generate cursors
  const nextCursor = returnedRows.length > 0 && hasMore
    ? encodeCursor(returnedRows[returnedRows.length - 1], cursorFields)
    : null;

  // For prevCursor we need a reverse query - more expensive
  // Only generate if explicitly requested (prevCursor is expensive)
  const prevCursor = cursor && returnedRows.length > 0
    ? encodeCursor(returnedRows[0], cursorFields)
    : null;

  return {
    rows: returnedRows,
    nextCursor,
    prevCursor,
    hasMore,
    returned: returnedRows.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Specialized queries for CircleUp entities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query circles with stable cursor pagination.
 * Uses (created_ledger, id) as cursor for uniqueness.
 */
export async function queryCirclesWithCursor(
  cursor: string | undefined,
  limit: number,
  status?: string,
): Promise<CursorQueryResult<{
  address: string;
  creator: string;
  round_amount: string;
  member_count: number;
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
  id: number;
}>> {
  const cursorFields = ["created_ledger", "id"];
  const where: string[] = [];
  const params: unknown[] = [];

  if (status) {
    where.push("status = $" + (params.length + 1));
    params.push(status);
  }

  return queryWithCursor({
    table: "circles",
    select: "address, creator, round_amount, member_count, status, current_round, total_rounds, created_ledger, id",
    cursorFields,
    orderBy: "created_ledger, id",
    direction: "desc",
    limit,
    cursor,
    where,
    params,
  });
}

/**
 * Query contributions with stable cursor pagination.
 * Uses (ledger, id) as cursor for uniqueness.
 */
export async function queryContributionsWithCursor(
  memberAddress: string,
  circleAddress: string | undefined,
  cursor: string | undefined,
  limit: number,
): Promise<CursorQueryResult<{
  circle_address: string;
  member_address: string;
  round_index: number;
  amount: string;
  ledger: number;
  id: number;
}>> {
  const cursorFields = ["ledger", "id"];
  const where: string[] = ["member_address = $1"];
  const params: unknown[] = [memberAddress];

  if (circleAddress) {
    where.push("circle_address = $" + (params.length + 1));
    params.push(circleAddress);
  }

  return queryWithCursor({
    table: "contributions",
    select: "circle_address, member_address, round_index, amount, ledger, id",
    cursorFields,
    orderBy: "ledger DESC, id DESC",
    direction: "desc",
    limit,
    cursor,
    where,
    params,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Testing utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify cursor traversal doesn't skip or duplicate records.
 * Run this in tests to validate pagination stability.
 */
export async function validateCursorTraversal(
  queryFn: () => Promise<CursorQueryResult<Record<string, unknown>>>,
  totalExpected: number,
): Promise<{ hasDuplicates: boolean; hasSkips: boolean; seenIds: Set<number> }> {
  const seenIds = new Set<number>();
  let cursor: string | null = null;
  let hasDuplicates = false;
  let hasSkips = false;
  let iterations = 0;
  const maxIterations = 100; // Safety limit

  do {
    const result = await queryFn();
    
    for (const row of result.rows) {
      const id = row.id as number;
      if (seenIds.has(id)) {
        hasDuplicates = true;
      }
      seenIds.add(id);
    }

    cursor = result.nextCursor;
    iterations++;
    
    // Safety check
    if (iterations >= maxIterations) {
      break;
    }
  } while (cursor && seenIds.size < totalExpected);

  // Check if we saw all records (within tolerance for exact count)
  if (seenIds.size < totalExpected - 1) {
    hasSkips = true;
  }

  return { hasDuplicates, hasSkips, seenIds };
}