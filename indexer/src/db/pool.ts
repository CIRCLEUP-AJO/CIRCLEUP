import { Pool, PoolClient, QueryResultRow } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected pool error:", err);
});

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;

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

/**
 * Verifies Postgres is reachable, retrying with exponential backoff.
 *
 * Postgres frequently isn't accepting connections yet the moment the indexer
 * starts (e.g. `docker compose up` racing the app against the DB container's
 * boot time), and the default single-shot `pool.connect()` would otherwise
 * fail the whole process on that first, likely-transient error. Call this
 * once at startup, before any query that assumes a live connection.
 */
export async function connectWithRetry({
  pool: targetPool = pool,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
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

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const res = await client.query<T>(text, params);
    return res.rows;
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
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
