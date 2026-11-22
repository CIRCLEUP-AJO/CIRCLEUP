/** Read-only indexer transport. The response exposes X-Request-ID for diagnostics. */

/** Deadline for a single server-rendered indexer request. */
export const INDEXER_TIMEOUT_MS = 5_000;

/** Maximum number of retries for safe GET requests (bounded to one). */
export const INDEXER_MAX_RETRIES = 1;

/** Error category for a request that exceeded its deadline. */
export class IndexerTimeoutError extends Error {
  readonly category = "timeout" as const;
  constructor(message = "Indexer request timed out") {
    super(message);
    this.name = "IndexerTimeoutError";
  }
}

/** Error category for a network-level failure (connection refused, reset, etc.). */
export class IndexerNetworkError extends Error {
  readonly category = "network" as const;
  constructor(message = "Indexer network error", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IndexerNetworkError";
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof IndexerTimeoutError ||
    (typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as { name?: unknown }).name === "TimeoutError")
  );
}

/**
 * In-flight request deduplication. Parallel Suspense consumers that request the
 * same read share one bounded request (and therefore one bounded retry budget)
 * rather than multiplying retries.
 */
const inflight = new Map<string, Promise<Response>>();

function requestKey(input: string | URL, init: RequestInit): string {
  const method = (init.method ?? "GET").toUpperCase();
  const url = typeof input === "string" ? input : input.toString();
  return `${method} ${url}`;
}

function buildHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  headers.set("X-Request-ID", globalThis.crypto.randomUUID());
  return headers;
}

async function performFetch(
  input: string | URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(input, { ...init, headers: buildHeaders(init), signal });
  } catch (err) {
    if (isTimeoutError(err) || (signal.aborted && signal.reason instanceof IndexerTimeoutError)) {
      throw new IndexerTimeoutError();
    }
    if (isAbortError(err)) {
      // External cancellation (e.g. request aborted by the runtime).
      throw err;
    }
    throw new IndexerNetworkError("Indexer network error", { cause: err });
  }
}

/**
 * Perform a bounded read against the indexer.
 *
 * - Applies an explicit deadline via `AbortSignal.timeout`.
 * - Retries at most once for safe GET requests on network failures.
 * - Distinguishes timeout from network errors via typed error classes.
 * - Deduplicates concurrent identical reads so retries do not multiply.
 */
export function indexerFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) {
    throw new TypeError("indexerFetch only supports reads");
  }

  const key = requestKey(input, init);
  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }

  const maxRetries = method === "GET" ? INDEXER_MAX_RETRIES : 0;

  const run = async (): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const signal = AbortSignal.timeout(INDEXER_TIMEOUT_MS);
      try {
        return await performFetch(input, init, signal);
      } catch (err) {
        lastError = err;
        // Only retry network errors; timeouts and external aborts are terminal.
        if (err instanceof IndexerNetworkError && attempt < maxRetries) {
          continue;
        }
        throw err;
      }
    }
    // Unreachable, but keeps the type checker satisfied.
    throw lastError instanceof Error ? lastError : new IndexerNetworkError();
  };

  const promise = run().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}