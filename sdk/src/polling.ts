// --- sdk/src/polling.ts -------------------------------------------------------
//
// PollConfig interface, DEFAULT_POLL_CONFIG, STALE_LEDGER_POLLS constant, and
// validatePollConfig helper � extracted from circleUpClient.ts to reduce that
// file's LOC.  Re-exported from circleUpClient.ts; the public API is unchanged.
//
// These are pure configuration/validation utilities with no RPC or SDK deps.
// ─── Polling configuration ────────────────────────────────────────────────────

/**
 * Controls how `buildAndSend` polls for transaction confirmation after
 * submission.
 *
 * All timing values are in milliseconds.  The polling loop uses exponential
 * backoff with full jitter to avoid thundering-herd behaviour when many
 * clients poll simultaneously after a network hiccup.
 *
 * Effective wait before attempt N (0-indexed):
 *   min(maxIntervalMs, initialIntervalMs * backoffFactor^N) ± jitter
 *
 * @example
 * // Aggressive polling for tests (fast, low noise)
 * const cfg: PollConfig = { initialIntervalMs: 500, timeoutMs: 10_000 };
 *
 * // Conservative polling for mainnet (reduces RPC pressure)
 * const cfg: PollConfig = {
 *   initialIntervalMs: 3_000,
 *   maxIntervalMs: 30_000,
 *   backoffFactor: 1.5,
 *   timeoutMs: 120_000,
 * };
 */
export interface PollConfig {
  /**
   * Milliseconds to wait before the first poll attempt.
   * @default 2000
   */
  initialIntervalMs?: number;

  /**
   * Maximum milliseconds between any two poll attempts regardless of backoff.
   * @default 10_000
   */
  maxIntervalMs?: number;

  /**
   * Multiplier applied to the current interval after each attempt.
   * Must be >= 1.  Set to 1 for a flat (non-backoff) retry schedule.
   * @default 1.5
   */
  backoffFactor?: number;

  /**
   * Total time budget for confirmation polling.  If the transaction has not
   * been confirmed (SUCCESS or FAILED) within this window the method returns
   * a `TxFailure` with `errorCode: "timeout"`.
   * @default 60_000
   */
  timeoutMs?: number;

  /**
   * How many consecutive `getTransaction` network errors are tolerated before
   * giving up and returning a `TxFailure` with `errorCode: "network_error"`.
   * Transient errors within this budget are retried silently.
   * @default 5
   */
  maxConsecutiveErrors?: number;
}

/** Resolved defaults used when the caller omits individual fields. */
export const DEFAULT_POLL_CONFIG = {
  initialIntervalMs: 2_000,
  maxIntervalMs: 10_000,
  backoffFactor: 1.5,
  timeoutMs: 60_000,
  maxConsecutiveErrors: 5,
} as const satisfies Required<PollConfig>;

/**
 * How many consecutive polls may observe the same RPC ledger before the
 * confirmation loop declares the endpoint stale.
 *
 * A healthy Stellar RPC advances its `latestLedger` roughly every 5 seconds.
 * The polling interval starts at 2 s and backs off, so three consecutive
 * responses reporting an unchanged ledger means the endpoint has stopped
 * ingesting — the transaction will never be observed here no matter how long
 * we wait, and continuing to poll would burn the caller's whole timeout budget
 * on an endpoint that cannot answer.
 */
export const STALE_LEDGER_POLLS = 3;

/**
 * Validate a caller-supplied {@link PollConfig}, reporting every problem at
 * once rather than failing on the first one.
 *
 * Called from the `CircleUpClient` constructor so a bad schedule surfaces at
 * setup time instead of producing a loop that spins hot, never retries, or
 * gives up before the network could plausibly have confirmed anything.
 *
 * @throws `RangeError` listing every invalid field.
 */
export function validatePollConfig(cfg: Required<PollConfig>): void {
  const errors: string[] = [];

  const positive = (
    key: keyof PollConfig,
    value: number,
  ): void => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      errors.push(
        `PollConfig.${key} must be a finite number greater than 0, got ${JSON.stringify(value)}.`,
      );
    }
  };

  positive("initialIntervalMs", cfg.initialIntervalMs);
  positive("maxIntervalMs", cfg.maxIntervalMs);
  positive("timeoutMs", cfg.timeoutMs);
  positive("maxConsecutiveErrors", cfg.maxConsecutiveErrors);

  if (
    typeof cfg.maxConsecutiveErrors === "number" &&
    Number.isFinite(cfg.maxConsecutiveErrors) &&
    !Number.isInteger(cfg.maxConsecutiveErrors)
  ) {
    errors.push(
      `PollConfig.maxConsecutiveErrors must be a whole number, got ${cfg.maxConsecutiveErrors}.`,
    );
  }

  if (
    typeof cfg.backoffFactor !== "number" ||
    !Number.isFinite(cfg.backoffFactor) ||
    cfg.backoffFactor < 1
  ) {
    errors.push(
      `PollConfig.backoffFactor must be >= 1, got ${JSON.stringify(cfg.backoffFactor)}.`,
    );
  }

  if (
    Number.isFinite(cfg.initialIntervalMs) &&
    Number.isFinite(cfg.maxIntervalMs) &&
    cfg.maxIntervalMs < cfg.initialIntervalMs
  ) {
    errors.push(
      `PollConfig.maxIntervalMs (${cfg.maxIntervalMs}) must be >= initialIntervalMs ` +
        `(${cfg.initialIntervalMs}), otherwise the first wait already exceeds the cap.`,
    );
  }

  if (
    Number.isFinite(cfg.timeoutMs) &&
    Number.isFinite(cfg.initialIntervalMs) &&
    cfg.timeoutMs < cfg.initialIntervalMs
  ) {
    errors.push(
      `PollConfig.timeoutMs (${cfg.timeoutMs}) must be >= initialIntervalMs ` +
        `(${cfg.initialIntervalMs}), otherwise the loop times out before its first poll.`,
    );
  }

  if (errors.length > 0) {
    throw new RangeError(
      `Invalid PollConfig:\n${errors.map((e) => `  • ${e}`).join("\n")}`,
    );
  }
}
