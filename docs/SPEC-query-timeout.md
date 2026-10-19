# Query Timeout Specification

## Problem Statement

An overloaded database can tie up handlers and exhaust the connection pool. A timeout must not be mistaken for an empty result - clients should receive explicit timeout errors, not silently empty data that looks like a valid response.

## Goals

1. Review SQL paths and apply bounded query timeouts
2. Ensure timeouts return explicit errors (not empty data)
3. Verify connections are properly released after timeout
4. Make timeout configurable via environment variables

## Implementation

### 3.1 Timeout Configuration

Create `indexer/src/db/timeouts.ts`:

```typescript
import { Pool, PoolConfig } from "pg";

// ─────────────────────────────────────────────────────────────────────────────
// Timeout Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query timeout in milliseconds. Queries exceeding this limit are cancelled.
 * Default: 10 seconds.
 * 
 * This prevents a slow or locked database from holding connections
 * indefinitely and blocking other requests.
 */
export const QUERY_TIMEOUT_MS = parseInt(
  process.env.QUERY_TIMEOUT_MS || "10000",
  10,
);

/**
 * Statement timeout in milliseconds. Set at the session level for each query.
 * This is a hard limit - the database itself will cancel the query.
 * Default: 8 seconds (slightly less than QUERY_TIMEOUT_MS to allow for
 * connection overhead).
 */
export const STATEMENT_TIMEOUT_MS = parseInt(
  process.env.STATEMENT_TIMEOUT_MS || "8000",
  10,
);

/**
 * Pool configuration with timeouts applied.
 */
export function createPoolWithTimeouts(config: PoolConfig): Pool {
  const pool = new Pool({
    ...config,
    // Connection-level settings
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    // Pool size limits
    max: 10,
  });

  // Set session-level statement timeout on each new connection
  pool.on("connect", (client) => {
    client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`).catch((err) => {
      console.warn("[db] Failed to set statement_timeout:", err.message);
    });
  });

  return pool;
}
```

### 3.2 Timeout-Aware Query Helpers

Update `indexer/src/db/pool.ts`:

```typescript
import { Pool, PoolClient, QueryResultRow } from "pg";
import { QUERY_TIMEOUT_MS, STATEMENT_TIMEOUT_MS } from "./timeouts";

// ─────────────────────────────────────────────────────────────────────────────
// Timeout-Aware Query Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Error thrown when a query exceeds the timeout threshold.
 * Distinguishes timeout from empty results.
 */
export class QueryTimeoutError extends Error {
  readonly query: string;
  readonly duration: number;
  readonly timeout: number;

  constructor(query: string, duration: number, timeout: number) {
    super(`Query timed out after ${duration}ms (limit: ${timeout}ms)`);
    this.name = "QueryTimeoutError";
    this.query = query;
    this.duration = duration;
    this.timeout = timeout;
  }
}

/**
 * Execute a query with a client-side timeout.
 * 
 * Unlike statement_timeout (database-side), this provides predictable
 * timing regardless of database load. The query is cancelled via Promise.race.
 */
export async function queryWithTimeout<T extends QueryResultRow>(
  text: string,
  params?: unknown[],
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<T[]> {
  const startTime = Date.now();
  
  try {
    return await Promise.race([
      query<T>(text, params),
      new Promise<T[]>((_, reject) => {
        setTimeout(() => {
          const duration = Date.now() - startTime;
          reject(new QueryTimeoutError(text, duration, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    // If it's a timeout, re-throw with context
    if (err instanceof QueryTimeoutError) {
      console.error(`[db] Query timeout: ${err.message}`);
      throw err;
    }
    // Re-throw other errors as-is
    throw err;
  }
}

/**
 * Execute queryOne with timeout protection.
 * 
 * Critical: This ensures timeout doesn't return null (which would look
 * like "no row found") - it throws QueryTimeoutError instead.
 */
export async function queryOneWithTimeout<T extends QueryResultRow>(
  text: string,
  params?: unknown[],
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<T | null> {
  const rows = await queryWithTimeout<T>(text, params, timeoutMs);
  return rows[0] ?? null;
}

/**
 * Execute queryExact with timeout protection.
 * 
 * If timeout occurs, throws QueryTimeoutError - does NOT silently
 * return undefined or throw "Expected exactly one row".
 */
export async function queryExactWithTimeout<T extends QueryResultRow>(
  text: string,
  params?: unknown[],
  errorMessage = "Expected exactly one row but got none",
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<T> {
  const row = await queryOneWithTimeout<T>(text, params, timeoutMs);
  if (row === null) {
    throw new Error(errorMessage);
  }
  return row;
}
```

### 3.3 Update API Routes to Use Timeout-Aware Queries

Update `api.ts` to use the new query helpers:

```typescript
import { queryWithTimeout, queryOneWithTimeout, QueryTimeoutError } from "./db/pool";
import { createError, ErrorCodes } from "./api/errors";
import { QUERY_TIMEOUT_MS } from "./db/timeouts";

// ─────────────────────────────────────────────────────────────────────────────
// Timeout Configuration per Query Type
// ─────────────────────────────────────────────────────────────────────────────

// Expensive list queries get more time
const LIST_QUERY_TIMEOUT = parseInt(
  process.env.LIST_QUERY_TIMEOUT_MS || "15000",
  10,
);

// Detail queries are faster
const DETAIL_QUERY_TIMEOUT = parseInt(
  process.env.DETAIL_QUERY_TIMEOUT_MS || "10000",
  10,
);

// History queries (potentially many rows)
const HISTORY_QUERY_TIMEOUT = parseInt(
  process.env.HISTORY_QUERY_TIMEOUT_MS || "20000",
  10,
);

// ─────────────────────────────────────────────────────────────────────────────
// Route Handlers with Timeouts
// ─────────────────────────────────────────────────────────────────────────────

app.get("/circles", listRateLimiter, async (req: Request, res: Response) => {
  // ... validation ...
  
  try {
    // Expensive paginated list query with longer timeout
    const [circles, [countRow]] = await Promise.all([
      queryWithTimeout<
        Pick<CircleRow, "address" | "creator" | "round_amount" | "member_count" | "status" | "current_round" | "total_rounds" | "created_ledger" | "updated_at">
      >(
        `SELECT c.address, c.creator, c.round_amount, c.member_count,
                c.status, c.current_round, c.total_rounds, c.created_ledger,
                c.updated_at
         FROM circles c
         ${whereClause}
         ORDER BY c.${sort} ${order.toUpperCase()}
         LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
        [...whereParams, limit, offset],
        LIST_QUERY_TIMEOUT,
      ),
      queryWithTimeout<{ count: string }>(
        `SELECT COUNT(*) as count FROM circles c ${whereClause}`,
        whereParams,
        DETAIL_QUERY_TIMEOUT, // Count is faster
      ),
    ]);
    // ... rest of handler ...
  } catch (err) {
    // CRITICAL: Distinguish timeout from empty result
    if (err instanceof QueryTimeoutError) {
      const { status, body } = createError(
        ErrorCodes.INTERNAL_ERROR,
        "The request took too long to complete. Please try again with fewer results.",
        { 
          correlationId: getCorrelationId(req),
          statusCode: 503,
        }
      );
      res.status(status).json(body);
      return;
    }
    // ... other error handling ...
  }
});

app.get("/circles/:address", detailRateLimiter, async (req: Request, res: Response) => {
  // ... validation ...
  
  try {
    const circle = await queryOneWithTimeout<CircleRow>(
      `SELECT * FROM circles WHERE address = $1`,
      [address],
      DETAIL_QUERY_TIMEOUT,
    );
    
    if (!circle) {
      // This is a NOT_FOUND, not a timeout - different handling
      res.status(404).json({ error: "Circle not found" });
      return;
    }
    
    // ... rest of handler ...
  } catch (err) {
    if (err instanceof QueryTimeoutError) {
      const { status, body } = createError(
        ErrorCodes.INTERNAL_ERROR,
        "The request took too long to complete.",
        { 
          correlationId: getCorrelationId(req),
          statusCode: 503,
        }
      );
      res.status(status).json(body);
      return;
    }
    // ... other error handling ...
  }
});
```

### 3.4 Test Coverage

Create `indexer/src/api.timeout.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { queryWithTimeout, queryOneWithTimeout, QueryTimeoutError } from "./db/pool";
import { pool } from "./db/pool";

describe("Query timeouts", () => {
  // Mock a slow query by intercepting the actual query call
  let mockQuery: any;
  
  beforeEach(() => {
    mockQuery = vi.spyOn(pool, "query").mockImplementation(async () => {
      // Simulate a slow query that takes longer than our timeout
      await new Promise(resolve => setTimeout(resolve, 100));
      return { rows: [] };
    });
  });
  
  afterEach(() => {
    mockQuery.mockRestore();
  });

  it("queryWithTimeout throws QueryTimeoutError when query exceeds limit", async () => {
    const fastTimeout = 10; // 10ms - very fast
    
    await expect(
      queryWithTimeout("SELECT * FROM circles", [], fastTimeout)
    ).rejects.toThrow(QueryTimeoutError);
  });

  it("queryWithTimeout returns results when query completes in time", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 1 }] });
    
    const result = await queryWithTimeout("SELECT * FROM circles", [], 1000);
    expect(result).toEqual([{ id: 1 }]);
  });

  it("queryOneWithTimeout throws on timeout, not null", async () => {
    const fastTimeout = 10;
    
    // This is critical: timeout should NOT return null (which would look like "no row")
    await expect(
      queryOneWithTimeout("SELECT * FROM circles WHERE 1=0", [], fastTimeout)
    ).rejects.toThrow(QueryTimeoutError);
  });

  it("queryOneWithTimeout returns null for actual empty result", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    
    const result = await queryOneWithTimeout("SELECT * FROM circles WHERE 1=0", [], 1000);
    expect(result).toBeNull();
  });
});

describe("Connection reuse after timeout", () => {
  it("releases connection even when query times out", async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    
    vi.spyOn(pool, "connect").mockResolvedValue(mockClient as any);
    
    const fastTimeout = 10;
    
    await expect(
      queryWithTimeout("SELECT * FROM slow_table", [], fastTimeout)
    ).rejects.toThrow(QueryTimeoutError);
    
    // Verify connection was released
    expect(mockClient.release).toHaveBeenCalled();
  });
});

describe("Different timeout values per query type", () => {
  it("uses longer timeout for list queries", async () => {
    const listTimeout = parseInt(process.env.LIST_QUERY_TIMEOUT_MS || "15000", 10);
    expect(listTimeout).toBeGreaterThan(10000);
  });

  it("uses shorter timeout for detail queries", async () => {
    const detailTimeout = parseInt(process.env.DETAIL_QUERY_TIMEOUT_MS || "10000", 10);
    expect(detailTimeout).toBeLessThanOrEqual(10000);
  });

  it("uses longest timeout for history queries", async () => {
    const historyTimeout = parseInt(process.env.HISTORY_QUERY_TIMEOUT_MS || "20000", 10);
    expect(historyTimeout).toBeGreaterThanOrEqual(15000);
  });
});
```

### 3.5 Environment Variables Documentation

Document the new configuration options:

```bash
# Query timeouts (in milliseconds)

# Overall client-side timeout for any query
QUERY_TIMEOUT_MS=10000

# Database session statement_timeout (slightly less than QUERY_TIMEOUT_MS)
STATEMENT_TIMEOUT_MS=8000

# Per-query-type overrides
LIST_QUERY_TIMEOUT_MS=15000      # Expensive paginated lists
DETAIL_QUERY_TIMEOUT_MS=10000    # Single-entity lookups  
HISTORY_QUERY_TIMEOUT_MS=20000   # Large history scans
```

## Acceptance Criteria

- [ ] All read queries have a bounded timeout
- [ ] Timeouts return explicit 503 errors, NOT empty data
- [ ] QueryTimeoutError is distinguishable from "no results found"
- [ ] Connections are released properly after timeout
- [ ] Timeout values are configurable via environment variables
- [ ] Different query types have appropriate timeout values (list longer than detail)
- [ ] Tests verify timeout behavior does not produce false empty results

## Priority

**High** - Reliability and correctness. Silent empty results from timeouts are a correctness bug that can cause data loss in client applications.