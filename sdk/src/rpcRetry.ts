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
  // The caller's deadline or AbortSignal ended the read; retrying would
  // ignore that decision.
  if (err instanceof RpcReadCancelledError) return false;

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

// ─── Read deadlines and cancellation (issue #899) ─────────────────────────────
//
// | Read path                                   | Upper bound                         | Caller cancellation |
// |---------------------------------------------|-------------------------------------|---------------------|
// | simulateTransaction (every contract view)   | ReadOptions.timeoutMs, one deadline across all retry attempts and backoff sleeps | ReadOptions.signal |
// | getTransaction (lookupTransaction)          | same                                | same                |
// | IndexerClient HTTP reads                    | IndexerRequestOptions.timeoutMs (fetch is aborted) | IndexerRequestOptions.signal |
// | verifyDeployment                            | VerifyDeploymentOptions.timeoutMs per call | — |
//
// The Soroban RPC client does not accept an AbortSignal, so for RPC reads the
// SDK stops *waiting*: the promise settles immediately, no further retry is
// scheduled, and a response that arrives later is ignored. The HTTP request
// already in flight may still complete on the server — harmless for reads.
//
// Writes are deliberately not covered: a deadline on a client-side wait never
// cancels a transaction that has been submitted. See PollConfig for how long
// confirmation polling waits.

/** Default upper bound, in milliseconds, for one SDK RPC read (all retries included). */
export const DEFAULT_RPC_READ_TIMEOUT_MS = 20_000;

/** Per-call options accepted by every RPC-backed read method. */
export interface ReadOptions {
  /**
   * Upper bound in milliseconds for the whole read, including transient-error
   * retries and their backoff. Defaults to the client's read timeout
   * ({@link DEFAULT_RPC_READ_TIMEOUT_MS} unless changed with
   * `CircleUpClient.setReadTimeout`).
   */
  timeoutMs?: number;
  /**
   * Caller cancellation, e.g. when a UI navigates away. When it fires the
   * read rejects with an {@link RpcReadCancelledError} whose `reason` is
   * `"aborted"`.
   */
  signal?: AbortSignal;
}

/** Why an RPC read stopped before it produced a result. */
export type RpcReadCancelReason = "timeout" | "aborted";

/**
 * Thrown (or carried in a read's failure result) when an RPC read was ended
 * by its deadline or by the caller's AbortSignal — never by the remote side.
 * Branch on `reason` instead of parsing the message. A read never changes
 * on-chain state, so stopping one cancels nothing on the network.
 */
export class RpcReadCancelledError extends Error {
  readonly reason: RpcReadCancelReason;
  /** The read that was stopped, e.g. `"simulateTransaction(read)"`. */
  readonly operation: string;

  constructor(operation: string, reason: RpcReadCancelReason, timeoutMs?: number) {
    super(
      reason === "timeout"
        ? `${operation} did not complete within ${timeoutMs} ms; the SDK stopped waiting. ` +
            "No on-chain state was changed."
        : `${operation} was cancelled by the caller before it completed. No on-chain state was changed.`,
    );
    this.name = "RpcReadCancelledError";
    this.reason = reason;
    this.operation = operation;
  }
}

/** `true` when `err` is an {@link RpcReadCancelledError}. */
export function isRpcReadCancelled(err: unknown): err is RpcReadCancelledError {
  return err instanceof RpcReadCancelledError;
}

/**
 * Run an RPC read through {@link withRpcRetry} under one deadline and an
 * optional caller signal.
 *
 * - Already-aborted signal → rejects before `fn` is called.
 * - Deadline / abort mid-attempt → rejects at once; the attempt's late result
 *   (or error) is ignored.
 * - Deadline / abort during a backoff sleep → rejects at once; no further
 *   attempt starts.
 * - The timer and the abort listener are always removed on settle.
 *
 * Exported for unit testing.
 */
export async function withRpcReadDeadline<T>(
  label: string,
  fn: () => Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal },
  maxAttempts = 3,
  baseDelayMs = 400,
): Promise<T> {
  const { timeoutMs, signal } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${label}: timeoutMs must be a positive, finite number of milliseconds.`);
  }
  if (signal?.aborted) throw new RpcReadCancelledError(label, "aborted");

  let stopped: RpcReadCancelledError | null = null;
  let rejectStop: (err: RpcReadCancelledError) => void = () => {};
  const stop = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  stop.catch(() => {}); // settled races must not surface as unhandled rejections
  const halt = (err: RpcReadCancelledError) => {
    if (stopped) return;
    stopped = err;
    rejectStop(err);
  };

  const timer = setTimeout(() => halt(new RpcReadCancelledError(label, "timeout", timeoutMs)), timeoutMs);
  const onAbort = () => halt(new RpcReadCancelledError(label, "aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });

  const attempt = (): Promise<T> => {
    if (stopped) return Promise.reject(stopped);
    const pending = fn();
    pending.catch(() => {}); // a late failure after the deadline is ignored
    return Promise.race([pending, stop]);
  };
  const sleep = (ms: number): Promise<void> => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => {
      id = setTimeout(resolve, ms);
    });
    return Promise.race([wait, stop]).finally(() => clearTimeout(id));
  };

  try {
    return await withRpcRetry(label, attempt, maxAttempts, baseDelayMs, sleep);
  } catch (err) {
    throw stopped ?? err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
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

// ─── Stage-by-stage retry policy (issue #900) ─────────────────────────────────
//
// | Stage        | RPC call            | Kind  | Automatic retry                                         |
// |--------------|---------------------|-------|---------------------------------------------------------|
// | `account`    | getAccount          | read  | Transient / throttled errors, bounded, backoff.         |
// | `simulation` | simulateTransaction | read  | Transient / throttled errors, bounded, backoff.         |
// | `wallet`     | (wallet signature)  | —     | Never. A rejection is the user's decision; a re-prompt  |
// |              |                     |       | is only ever started by the caller.                     |
// | `submission` | sendTransaction     | write | Only the identical signed envelope, and only after a    |
// |              |                     |       | transient error. Never rebuilt or re-signed. After an   |
// |              |                     |       | ambiguous send the SDK looks the hash up instead.       |
// | `polling`    | getTransaction      | read  | Keep polling within PollConfig (timeoutMs,              |
// |              |                     |       | maxConsecutiveErrors). A local timeout is reported as   |
// |              |                     |       | "timeout"/"outcome_unknown" with the hash — not failure.|
// | `lookup`     | getTransaction      | read  | Transient / throttled errors within ReadOptions deadline.|
// | `read`       | simulateTransaction | read  | Same as lookup.                                         |
//
// The SDK never automatically resubmits a *new* transaction. A caller may
// rebuild a write only when `isRetryable(failure)` is true — i.e. the SDK has
// evidence the original was never applied (never reached the RPC, refused,
// rejected, or expired unincluded).

/** A stage of an SDK operation that talks to the RPC or wallet. */
export type RetryStage = "account" | "simulation" | "wallet" | "submission" | "polling" | "lookup" | "read";

/** How the SDK retries one {@link RetryStage}. */
export interface RetryPolicy {
  /**
   * `"read"` stages never change chain state; `"write"` stages may; `"user"`
   * stages wait on a person (wallet prompt) and are never retried by the SDK.
   */
  readonly kind: "read" | "write" | "user";
  /** Total attempts (first try included). `1` means no automatic retry. */
  readonly maxAttempts: number;
  /** Base delay for capped exponential backoff with full jitter, in ms. */
  readonly baseDelayMs: number;
  /**
   * What is retried: `"same_request"` repeats the identical read,
   * `"same_envelope"` resends the identical signed transaction (never a new
   * one), `"poll_budget"` keeps polling within {@link PollConfig}, `"none"`
   * never retries.
   */
  readonly retries: "same_request" | "same_envelope" | "poll_budget" | "none";
}

/** The SDK's retry policy for every stage. See the table above. */
export const RETRY_POLICY: Readonly<Record<RetryStage, RetryPolicy>> = Object.freeze({
  account: Object.freeze({ kind: "read", maxAttempts: 3, baseDelayMs: 400, retries: "same_request" }),
  simulation: Object.freeze({ kind: "read", maxAttempts: 3, baseDelayMs: 400, retries: "same_request" }),
  wallet: Object.freeze({ kind: "user", maxAttempts: 1, baseDelayMs: 0, retries: "none" }),
  submission: Object.freeze({ kind: "write", maxAttempts: SEND_MAX_ATTEMPTS, baseDelayMs: 400, retries: "same_envelope" }),
  polling: Object.freeze({ kind: "read", maxAttempts: Infinity, baseDelayMs: 0, retries: "poll_budget" }),
  lookup: Object.freeze({ kind: "read", maxAttempts: 3, baseDelayMs: 400, retries: "same_request" }),
  read: Object.freeze({ kind: "read", maxAttempts: 3, baseDelayMs: 400, retries: "same_request" }),
} satisfies Record<RetryStage, RetryPolicy>);

/**
 * Coarse class of an RPC/provider failure, used to decide retries:
 *
 * - `"throttled"` — rate limited (HTTP 429, "too many requests"). Retry with backoff.
 * - `"transient"` — network blip, gateway error, timeout. Retry with backoff.
 * - `"cancelled"` — stopped locally by a deadline or AbortSignal. Do not retry.
 * - `"permanent"` — anything else (bad request, auth, unrecognised). Do not retry.
 */
export type RpcFailureClass = "throttled" | "transient" | "cancelled" | "permanent";

/** Classify a thrown RPC/provider error. Never inspects or returns its text beyond matching. */
export function classifyRpcFailure(err: unknown): RpcFailureClass {
  if (err instanceof RpcReadCancelledError) return "cancelled";
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  const lower = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return "throttled";
  }
  return isTransientRpcError(err) ? "transient" : "permanent";
}

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