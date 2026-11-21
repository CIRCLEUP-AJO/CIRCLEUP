import { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";
import * as dotenv from "dotenv";
import * as fs from "fs";
import {
  DB_CONNECT_MAX_RETRIES,
  DB_CONNECT_BASE_DELAY_MS,
  DB_POOL_MAX,
  DB_ACQUIRE_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS,
} from "../config";

dotenv.config();

// ── Database Transport Security & Configuration ──────────────────────────────
//
// Requirements (#936):
//  1. Transport security in production: When NODE_ENV=production or CIRCLEUP_PROFILE=production,
//     TLS is mandatory. Non-TLS connections are rejected at startup.
//  2. Explicit certificate verification: TLS must not silently disable certificate
//     verification (rejectUnauthorized: false is disallowed in production unless
//     an explicit insecure opt-in is configured).
//  3. Connection timeouts and application name: Explicit timeouts and a stable
//     application_name are passed into the pool for database-level query tracing.
//  4. Secret-safe error logging: Error messages, logs, and diagnostics NEVER
//     contain credentials or the unredacted DATABASE_URL.

/** Non-sensitive description of the active PostgreSQL connection policy. */
export interface ConnectionSecurityReport {
  host: string;
  port: number;
  database: string;
  sslEnabled: boolean;
  sslRejectUnauthorized: boolean | null;
  hasCustomCa: boolean;
  applicationName: string;
  connectionTimeoutMs: number;
  isProduction: boolean;
}

/**
 * Redacts passwords and credentials from a PostgreSQL connection string.
 *
 * @param rawUrl Unredacted or partially redacted connection string.
 * @returns Redacted URL where password is replaced by '***'.
 */
export function redactDatabaseUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    // Regex fallback for non-standard or malformed URLs
    return rawUrl.replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/i, "$1***$3");
  }
}

/**
 * Sanitizes any text string that might contain a PostgreSQL connection URL,
 * replacing the password with '***'.
 */
export function redactCredentialsInText(text: string): string {
  if (!text || typeof text !== "string") return "";
  return text.replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi, "$1***$3");
}

/**
 * Builds and validates PoolConfig from environment options and DATABASE_URL.
 *
 * Validates production security rules (TLS required, certificate verification
 * active) and generates a non-sensitive security report.
 */
export function buildPoolConfig(
  rawUrl: string | undefined = process.env.DATABASE_URL,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): { poolConfig: PoolConfig; security: ConnectionSecurityReport } {
  const isProduction =
    (env.NODE_ENV || "").toLowerCase() === "production" ||
    (env.CIRCLEUP_PROFILE || "").toLowerCase() === "production";

  let host = "localhost";
  let port = 5432;
  let database = "circleup";
  let sslmode: string | null = null;
  let sslParam: string | null = null;

  if (rawUrl && rawUrl.trim() !== "") {
    try {
      const parsed = new URL(rawUrl);
      if (!parsed.protocol.startsWith("postgres")) {
        throw new Error(
          `[db] Invalid database URL protocol: ${parsed.protocol}. Expected postgresql:// or postgres://.`,
        );
      }
      host = parsed.hostname || "localhost";
      port = parsed.port ? parseInt(parsed.port, 10) : 5432;
      database = parsed.pathname ? parsed.pathname.replace(/^\//, "") : "circleup";
      sslmode = parsed.searchParams.get("sslmode")?.toLowerCase() || null;
      sslParam = parsed.searchParams.get("ssl")?.toLowerCase() || null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[db] Malformed DATABASE_URL: ${redactDatabaseUrl(rawUrl)}. ${msg}`,
      );
    }
  }

  // 1. Determine SSL / TLS enablement
  const envDbSsl = (env.DB_SSL || "").toLowerCase();
  let sslEnabled = false;

  if (sslmode === "disable") {
    sslEnabled = false;
  } else if (
    sslmode === "require" ||
    sslmode === "verify-ca" ||
    sslmode === "verify-full" ||
    sslmode === "no-verify" ||
    sslParam === "true" ||
    envDbSsl === "true" ||
    envDbSsl === "1"
  ) {
    sslEnabled = true;
  }

  // 2. Determine Certificate Verification (rejectUnauthorized)
  const envRejectUnauthorized = (env.DB_SSL_REJECT_UNAUTHORIZED || "").toLowerCase();
  let rejectUnauthorized: boolean | null = null;

  if (sslEnabled) {
    if (envRejectUnauthorized === "false" || envRejectUnauthorized === "0" || sslmode === "no-verify") {
      rejectUnauthorized = false;
    } else if (
      envRejectUnauthorized === "true" ||
      envRejectUnauthorized === "1" ||
      sslmode === "verify-full" ||
      sslmode === "verify-ca"
    ) {
      rejectUnauthorized = true;
    } else {
      // In production, default to strict verification (true).
      // In development, default to true if verify-full/ca requested, else true for safety.
      rejectUnauthorized = isProduction ? true : false;
    }
  }

  // 3. Custom CA Certificate
  let customCa: string | undefined;
  let hasCustomCa = false;
  const rawCa = env.DB_SSL_CA;
  if (rawCa && rawCa.trim() !== "") {
    if (rawCa.includes("BEGIN CERTIFICATE")) {
      customCa = rawCa;
      hasCustomCa = true;
    } else {
      try {
        if (fs.existsSync(rawCa)) {
          customCa = fs.readFileSync(rawCa, "utf8");
          hasCustomCa = true;
        }
      } catch {
        // Fall back to treating as raw string
        customCa = rawCa;
        hasCustomCa = true;
      }
    }
  }

  // 4. Production Security Validation Rules
  if (isProduction) {
    if (!sslEnabled) {
      throw new Error(
        "[db] Insecure database transport rejected for production: TLS/SSL must be enabled via DATABASE_URL (?sslmode=verify-full or ?sslmode=require) or DB_SSL=true.",
      );
    }

    const allowInsecure = (env.DB_SSL_ALLOW_INSECURE || "").toLowerCase() === "true";
    if (rejectUnauthorized === false && !allowInsecure) {
      throw new Error(
        "[db] Insecure database configuration rejected for production: TLS certificate verification cannot be silently disabled (rejectUnauthorized=false). Provide a valid certificate authority (DB_SSL_CA) or configure sslmode=verify-full.",
      );
    }
  }

  const appName = env.DB_APPLICATION_NAME || "circleup-indexer";
  const timeoutMs = DB_ACQUIRE_TIMEOUT_MS;

  const poolConfig: PoolConfig = {
    connectionString: rawUrl,
    max: DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: timeoutMs,
    application_name: appName,
    ...(sslEnabled
      ? {
          ssl: {
            rejectUnauthorized: rejectUnauthorized ?? true,
            ...(customCa ? { ca: customCa } : {}),
          },
        }
      : {}),
  };

  const security: ConnectionSecurityReport = {
    host,
    port,
    database,
    sslEnabled,
    sslRejectUnauthorized: rejectUnauthorized,
    hasCustomCa,
    applicationName: appName,
    connectionTimeoutMs: timeoutMs,
    isProduction,
  };

  return { poolConfig, security };
}

let activeSecurityReport: ConnectionSecurityReport | null = null;

/**
 * Returns the non-sensitive configuration state of the active database connection pool.
 */
export function getConnectionSecurityReport(): ConnectionSecurityReport {
  if (!activeSecurityReport) {
    try {
      const { security } = buildPoolConfig();
      activeSecurityReport = security;
    } catch {
      return {
        host: "unknown",
        port: 5432,
        database: "circleup",
        sslEnabled: false,
        sslRejectUnauthorized: null,
        hasCustomCa: false,
        applicationName: process.env.DB_APPLICATION_NAME || "circleup-indexer",
        connectionTimeoutMs: DB_ACQUIRE_TIMEOUT_MS,
        isProduction:
          (process.env.NODE_ENV || "").toLowerCase() === "production" ||
          (process.env.CIRCLEUP_PROFILE || "").toLowerCase() === "production",
      };
    }
  }
  return activeSecurityReport;
}

const { poolConfig: initialPoolConfig, security: initialSecurity } = (() => {
  try {
    return buildPoolConfig();
  } catch (err) {
    if (
      (process.env.NODE_ENV || "").toLowerCase() === "production" ||
      (process.env.CIRCLEUP_PROFILE || "").toLowerCase() === "production"
    ) {
      throw err;
    }
    return {
      poolConfig: {
        connectionString: process.env.DATABASE_URL,
        max: DB_POOL_MAX,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: DB_ACQUIRE_TIMEOUT_MS,
      },
      security: {
        host: "localhost",
        port: 5432,
        database: "circleup",
        sslEnabled: false,
        sslRejectUnauthorized: null,
        hasCustomCa: false,
        applicationName: process.env.DB_APPLICATION_NAME || "circleup-indexer",
        connectionTimeoutMs: DB_ACQUIRE_TIMEOUT_MS,
        isProduction: false,
      },
    };
  }
})();

activeSecurityReport = initialSecurity;

export const pool = new Pool(initialPoolConfig);

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
  let text = String(err);
  if (err && typeof err === "object") {
    const { message, code, errors } = err as {
      message?: string;
      code?: string;
      errors?: unknown[];
    };
    if (message) {
      text = message;
    } else if (Array.isArray(errors) && errors.length > 0) {
      text = errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
    } else if (code) {
      text = code;
    }
  }
  return redactCredentialsInText(text);
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

// ── Pool lifecycle & shutdown state ───────────────────────────────────────────

let poolClosing = false;
let poolClosed = false;
let poolClosePromise: Promise<void> | null = null;

export function isPoolClosing(): boolean {
  return poolClosing;
}

export function isPoolClosed(): boolean {
  return poolClosed || pool.ended;
}

/** Reset internal shutdown state flags (intended for unit tests only). */
export function _resetPoolStateForTest(): void {
  poolClosing = false;
  poolClosed = false;
  poolClosePromise = null;
}

export interface ClosePoolOptions {
  /** Optional custom pool instance to close (defaults to shared pool). */
  pool?: Pick<Pool, "end"> & Partial<Pick<Pool, "ended">>;
  /** Maximum wait time in milliseconds for in-flight queries to release. */
  timeoutMs?: number;
  /** Optional AbortSignal to interrupt waiting for pool draining. */
  signal?: AbortSignal;
}

/** Error raised when the pool drain deadline is exceeded. */
export class PoolDrainTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`[db] Pool shutdown timed out after ${timeoutMs}ms`);
    this.name = "PoolDrainTimeoutError";
  }
}

/** Error raised when the pool drain is aborted via AbortSignal. */
export class PoolDrainAbortedError extends Error {
  constructor(reason?: unknown) {
    super(
      `[db] Pool shutdown aborted${
        reason instanceof Error ? `: ${reason.message}` : reason ? `: ${String(reason)}` : ""
      }`,
    );
    this.name = "PoolDrainAbortedError";
  }
}

/**
 * Cleanly releases all PostgreSQL connections in the shared pool.
 *
 * Requirements (#935):
 *  1. Coordinated lifecycle: establish a single owner for pool shutdown and
 *     prevent multiple concurrent teardown attempts from racing (idempotent).
 *  2. Safe repeat cleanup: if already closed, resolves immediately without error.
 *  3. In-flight transactions: pg's pool.end() awaits active clients being checked
 *     back in. Optional timeoutMs or signal bounds this grace period.
 *  4. Observable errors: failures during pool.end() are never silently swallowed.
 *  5. Immediate rejection of new work: once shutdown begins, acquireClient refuses
 *     new checkouts.
 */
export async function closePool(options: ClosePoolOptions = {}): Promise<void> {
  const targetPool = options.pool ?? pool;
  const isDefaultPool = targetPool === pool;

  if (isDefaultPool) {
    // Already fully closed: resolve immediately without re-ending the pool.
    if (poolClosed || pool.ended) {
      poolClosed = true;
      return;
    }
    // A close is already in progress: share the existing promise so repeated
    // shutdown signals never double-end the pool or race each other.
    if (poolClosePromise) {
      return poolClosePromise;
    }
    poolClosing = true;
  } else if (targetPool.ended) {
    return;
  }

  const executionPromise = (async () => {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const signal = options.signal;

    // Start draining. pg's pool.end() waits for checked-out clients to be
    // released; in-flight transactions therefore get a chance to COMMIT or
    // ROLLBACK before their connections are torn down.
    const endPromise = targetPool.end();

    try {
      if (options.timeoutMs && options.timeoutMs > 0) {
        const timeoutMs = options.timeoutMs;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new PoolDrainTimeoutError(timeoutMs));
          }, timeoutMs);
          timer.unref?.();
        });
        await Promise.race([endPromise, timeoutPromise]);
      } else if (signal) {
        if (signal.aborted) {
          throw new PoolDrainAbortedError(signal.reason);
        }
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => reject(new PoolDrainAbortedError(signal.reason));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        await Promise.race([endPromise, abortPromise]);
      } else {
        await endPromise;
      }

      if (isDefaultPool) {
        poolClosed = true;
      }
    } catch (err) {
      // The drain deadline/abort fired before end() resolved. Do NOT swallow
      // the underlying end() failure: attach a handler so a late rejection
      // from end() is reported rather than becoming an unhandled rejection.
      endPromise.catch((endErr) => {
        console.error(
          "[db] Pool end() failed after drain deadline exceeded:",
          redactCredentialsInText(endErr instanceof Error ? endErr.message : String(endErr)),
        );
      });

      if (isDefaultPool && !pool.ended) {
        // Allow a later closePool() call to retry the drain.
        poolClosing = false;
        poolClosePromise = null;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  })();

  if (isDefaultPool) {
    poolClosePromise = executionPromise;
  }

  return executionPromise;
}

/**
 * Execute a one-shot command or procedure and guarantee the shared database
 * pool is closed when it finishes, whether on successful return or thrown error.
 */
export async function withPoolCleanup<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await closePool();
  }
}

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
  if (isPoolClosing() || isPoolClosed()) {
    throw new Error("[db] Cannot acquire connection: database pool is closed or shutting down");
  }
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
