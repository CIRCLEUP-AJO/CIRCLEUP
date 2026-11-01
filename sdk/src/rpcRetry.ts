// --- sdk/src/rpcRetry.ts -------------------------------------------------------
//
// Transient RPC error detection, capped exponential backoff retry, and
// "may have reached the server" ambiguity check.  Extracted from
// circleUpClient.ts to reduce that file's LOC.  Re-exported from
// circleUpClient.ts so existing imports are unchanged.
// ─── Transient RPC retry ──────────────────────────────────────────────────────

/**
 * Return true when `err` is a transient network or rate-limit condition that
 * is safe to retry.  Non-transient errors (auth, bad request, simulation
 * errors) propagate immediately so the caller gets feedback right away.
 *
 * Exported for unit testing.
 */
export function isTransientRpcError(err: unknown): boolean {
  if (err == null) return false;

  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EPIPE" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }

  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }

  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("network") ||
    lower.includes("failed to fetch") ||
    lower.includes("fetch failed") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout")
  );
}

/**
 * Run a single Soroban RPC call with capped exponential backoff + full jitter
 * on transient failures.
 *
 * - Transient errors (network blips, rate-limits, gateway errors) are retried
 *   up to `maxAttempts` times.
 * - Non-transient errors propagate immediately, preserving fast failure for
 *   bad requests and auth errors.
 *
 * Full jitter: delay for attempt N is random in [0, baseDelayMs × 2^(N-1)].
 *
 * Exported for unit testing.
 *
 * @param label       Short human-readable name used in error messages.
 * @param fn          The RPC call to execute.
 * @param maxAttempts Total attempts (first try + retries). Default: 3.
 * @param baseDelayMs Base delay in ms for the first retry. Default: 400.
 * @param sleep       Injectable sleep for testing.
 */
export async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 400,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let lastErr: unknown;
  const attempts = Math.max(1, maxAttempts);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || attempt === attempts) break;
      const ceiling = baseDelayMs * 2 ** (attempt - 1);
      const delayMs = Math.floor(Math.random() * ceiling);
      await sleep(delayMs);
    }
  }

  throw lastErr;
}

// ─── Retry safety by operation ────────────────────────────────────────────────
//
// | RPC call              | Kind  | Recovery on a transient failure                     |
// |-----------------------|-------|-----------------------------------------------------|
// | getAccount            | read  | Retry freely (withRpcRetry).                        |
// | simulateTransaction   | read  | Retry freely — a simulation never touches the chain.|
// | getTransaction        | read  | Retry / keep polling by hash.                       |
// | sendTransaction       | write | Resend only the *same signed envelope* (same hash,  |
// |                       |       | same sequence number, so the network applies it at  |
// |                       |       | most once). Never rebuild or re-sign inside the SDK.|
//
// A failed send is only "safe to rebuild" when the request provably never
// reached the RPC. Otherwise the transaction may have been accepted, and a
// rebuilt one would carry the next sequence number and execute the write a
// second time. Those ambiguous cases are resolved by looking the original hash
// up, and reported as "outcome_unknown" when the lookup cannot settle them.

/** Attempts (first try + resends of the identical envelope) for sendTransaction. */
export const SEND_MAX_ATTEMPTS = 3;

/**
 * Return `false` only when `err` proves the request never reached the RPC, so
 * the transaction cannot have been accepted. Returns `true` whenever that
 * cannot be ruled out.
 *
 * "Never reached" covers failures to open a connection (DNS, refused,
 * unreachable host), a rate-limit rejection, and a JSON-RPC error object —
 * the server parsed the request and refused it. Timeouts, resets, hang-ups,
 * gateway errors, and anything unrecognised are treated as possibly delivered.
 *
 * Exported for unit testing.
 */
export function mayHaveReachedServer(err: unknown): boolean {
  if (err == null) return true;
  const code =
    typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  const status =
    typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  const lower = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EHOSTUNREACH" ||
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("enotfound") ||
    lower.includes("getaddrinfo") ||
    lower.includes("ehostunreach")
  ) {
    return false;
  }
  if (status === 429) return false;
  // JSON-RPC error objects carry a negative integer code (e.g. -32602).
  if (typeof code === "number" && Number.isInteger(code) && code < 0) return false;
  return true;
}