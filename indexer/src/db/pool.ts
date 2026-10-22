import { Pool, PoolClient, QueryResultRow } from "pg";
import * as dotenv from "dotenv";
import {
  DB_CONNECT_MAX_RETRIES,
  DB_CONNECT_BASE_DELAY_MS,
  DB_POOL_MAX,
  DB_ACQUIRE_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS,
} from "../config";

dotenv.config();

// ── Pool backpressure policy ──────────────────────────────────────────────────
//
// Three parameters govern how the pool handles concurrency pressure:
//
//   DB_POOL_MAX             — maximum active connections (default 10).
//   DB_ACQUIRE_TIMEOUT_MS   — maximum wait before a caller receives a
//                             PoolSaturationError instead of queuing forever
//                             (default 5 000 ms, matches pg's default
//                             connectionTimeoutMillis so existing behaviour is
//                             preserved unless the operator overrides it).
//   DB_STATEMENT_TIMEOUT_MS — Postgres-level per-query time-box: Postgres
//                             cancels the query and returns an error to the
//                             client, releasing the connection within a
//                             bounded time (default 30 000 ms; 0 = disabled).
//
// These three together bound database demand, make overload explicit and
// observable (PoolSaturationError vs silent queue), and ensure the poller
// cannot advance a ledger checkpoint if a DB write times out.

/**
 * Thrown when all pool connections are checked out and a new `connect()` call
 * cannot acquire one within `DB_ACQUIRE_TIMEOUT_MS`.
 *
 * Callers must NOT retry silently on this error — surfacing it lets operators
 * see saturation via logs and the /health endpoint before it becomes an
 * outage.  The HTTP layer maps this to 503 Service Unavailable.
 */
export class PoolSaturationError extends Error {
  /** Total connections the pool is configured to hold. */
  readonly poolMax: number;
  /** Milliseconds the caller waited before giving up. */
  readonly acquireTimeoutMs: number;

  constructor(poolMax: number, acquireTimeoutMs: number) {
    super(
      `[db] Pool saturated: all ${poolMax} connection(s) are in use. ` +
        `Acquisition timed out after ${acquireTimeoutMs}ms. ` +
        `Increase DB_POOL_MAX or reduce concurrent DB consumers.`,
    );
    this.name = "PoolSaturationError";
    this.poolMax = poolMax;
    this.acquireTimeoutMs = acquireTimeoutMs;
  }
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  // pg's own connection-timeout is kept in sync with our acquisition timeout
  // so the two mechanisms agree on the wait budget.
  connectionTimeoutMillis: DB_ACQUIRE_TIMEOUT_MS,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err);
});

// Node surfaces a refused/unreachable TCP connection (the common case while
// Postgres is still starting) as an AggregateError whose own `.message` is
// "" — the useful text lives in `.errors[]` instead. Falling back to
// `String(err)` for that case would just print "AggregateError", so this
// unwraps it (and falls back to `.code`, e.g. "ECONNREFUSED") to keep the
// retry/failure logs actually readable.
function describeConnectionError(err: unknown): string {
  if (err && typeof err === "object") {
    const { message, code, errors } = err as {
      message?: string;
      code?: string;
      errors?: unknown[];
    };
    if (message) return message;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
    }
    if (code) return code;
  }
  return String(err);
}

// ── Pool stats ────────────────────────────────────────────────────────────────

/**
 * A snapshot of the pool's current connection state.
 *
 * Exposed so the health check can include pool saturation in its /health
 * response without importing the internal pg Pool fields directly.
 */
export interface PoolStats {
  /** Maximum configured connections. */
  max: number;
  /** Connections currently checked out to callers. */
  totalCount: number;
  /** Connections idle in the pool (checked in). */
  idleCount: number;
  /** Callers waiting for a connection to become available. */
  waitingCount: number;
}

/** Return a snapshot of the current pool connection counts. */
export function getPoolStats(): PoolStats {
  return {
    max: DB_POOL_MAX,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

// ── Connection acquisition with saturation detection ─────────────────────────

/**
 * Acquire a PoolClient, converting pg's generic connection-timeout error into
 * a typed PoolSaturationError so callers and the health check can distinguish
 * "pool is full" from other database errors.
 *
 * pg throws a plain Error("timeout exceeded") when
 * connectionTimeoutMillis elapses before a free slot appears.  We detect this
 * by the timeout message rather than by a specific error class because pg does
 * not export a typed error for it.
 */
async function acquireClient(): Promise<PoolClient> {
  try {
    const client = await pool.connect();
    return client;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // pg's internal connection-timeout message (stable across pg@8.x):
    if (/timeout exceeded|connection timeout/i.test(msg)) {
      throw new PoolSaturationError(DB_POOL_MAX, DB_ACQUIRE_TIMEOUT_MS);
    }
    throw err;
  }
}

/**
 * Apply the statement_timeout to a newly acquired client so every query it
 * runs is subject to the global budget.  A timeout of 0 leaves Postgres's
 * default in place (usually no limit).
 *
 * This is called inside every public helper and withTransaction before the
 * client is handed to the caller.  It adds one round-trip per checkout, which
 * is negligible compared to typical query latencies.
 */
async function applyStatementTimeout(client: PoolClient): Promise<void> {
  if (DB_STATEMENT_TIMEOUT_MS > 0) {
    await client.query(`SET statement_timeout = ${DB_STATEMENT_TIMEOUT_MS}`);
  }
}

/**
 * Verifies Postgres is reachable, retrying with exponential backoff.
 *
 * Postgres frequently isn't accepting connections yet the moment the indexer
 * starts (e.g. `docker compose up` racing the app against the DB container's
 * boot time), and the default single-shot `pool.connect()` would otherwise
 * fail the whole process on that first, likely-transient error. Call this
 * once at startup, before any query that assumes a live connection.
 *
 * The default `maxRetries` and `baseDelayMs` are read from the
 * `DB_CONNECT_MAX_RETRIES` and `DB_CONNECT_BASE_DELAY_MS` environment
 * variables (validated and exported by `../config`), so operators can tune
 * retry behaviour without a code change.
 */
export async function connectWithRetry({
  pool: targetPool = pool,
  maxRetries = DB_CONNECT_MAX_RETRIES,
  baseDelayMs = DB_CONNECT_BASE_DELAY_MS,
}: {
  pool?: Pick<Pool, "connect">;
  maxRetries?: number;
  baseDelayMs?: number;
} = {}): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await targetPool.connect();
      client.release();
      if (attempt > 1) {
        console.log(`[db] Connected to Postgres (attempt ${attempt}/${maxRetries})`);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[db] Postgres connection attempt ${attempt}/${maxRetries} failed: ` +
          `${describeConnectionError(err)} — retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `[db] Could not connect to Postgres after ${maxRetries} attempt(s): ` +
      describeConnectionError(lastErr),
  );
}

/**
 * Execute a parameterised SQL query and return all matching rows as a typed
 * array.
 *
 * Use this for queries that may legitimately return zero, one, or many rows.
 * For single-row lookups prefer {@link queryOne} (returns `T | null`) or
 * {@link queryExact} (throws when no row is found) — both communicate intent
 * more clearly at the call-site and eliminate the `const [row] = await
 * query(...)` pattern that silently discards type-safety on `undefined`.
 *
 * @param text   Parameterised SQL string — parameters are referenced as `$1`,
 *               `$2`, … (never interpolated directly).
 * @param params Query parameter values, in `$N` order.
 * @returns      Typed array of result rows; empty when no rows match.
 * @throws       PoolSaturationError when the pool is full and DB_ACQUIRE_TIMEOUT_MS
 *               elapses without a free connection becoming available.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const client = await acquireClient();
  try {
    await applyStatementTimeout(client);
    const res = await client.query<T>(text, params);
    return res.rows;
  } finally {
    client.release();
  }
}

/**
 * Execute a parameterised SQL query and return the first matching row, or
 * `null` when no rows are returned.
 *
 * This is the canonical helper for point lookups (e.g. `SELECT … WHERE id =
 * $1`) — it replaces the fragile `const [row] = await query(...)` pattern
 * that silently produces `undefined` (typed as `T`) when no row exists.
 *
 * **Invariant**: if the query returns more than one row, only the first is
 * returned; add a `LIMIT 1` clause when the query does not already guarantee
 * at most one row.
 *
 * @param text   Parameterised SQL string.
 * @param params Query parameter values, in `$N` order.
 * @returns      First row typed as `T`, or `null` if the result set is empty.
 * @throws       PoolSaturationError when the pool is full and DB_ACQUIRE_TIMEOUT_MS
 *               elapses without a free connection becoming available.
 */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Execute a parameterised SQL query and return the first matching row,
 * throwing a descriptive `Error` when the result set is empty.
 *
 * Use this helper when the caller has already confirmed (via a prior
 * constraint or business rule) that a row must exist — the thrown error
 * surfaces the problem immediately rather than letting `undefined` propagate
 * and produce a confusing downstream failure.
 *
 * @param text        Parameterised SQL string.
 * @param params      Query parameter values, in `$N` order.
 * @param errorMessage Optional message for the thrown error; defaults to
 *                    `"Expected exactly one row but got none"`.
 * @returns           First row typed as `T`.
 * @throws            `Error` when the query returns zero rows.
 * @throws            PoolSaturationError when the pool is full and
 *                    DB_ACQUIRE_TIMEOUT_MS elapses.
 */
export async function queryExact<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
  errorMessage = "Expected exactly one row but got none",
): Promise<T> {
  const row = await queryOne<T>(text, params);
  if (row === null) {
    throw new Error(errorMessage);
  }
  return row;
}

/**
 * Run `fn` inside a single Postgres transaction, committing on success and
 * rolling back on any error.
 *
 * Each event handler in the ingestion path wraps its writes in a SAVEPOINT
 * (see processLedger) rather than calling withTransaction directly for inner
 * retries — this outer transaction is the ledger-level atomicity boundary.
 *
 * The connection is always released in `finally` so a crash inside `fn`
 * cannot leak a connection.
 *
 * @throws PoolSaturationError when the pool is full and DB_ACQUIRE_TIMEOUT_MS
 *         elapses without a free connection.  The poller treats this as a
 *         transient error (classifyHandlerError returns "transient") so the
 *         ledger is retried after backoff without advancing the checkpoint.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await acquireClient();
  try {
    await applyStatementTimeout(client);
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
