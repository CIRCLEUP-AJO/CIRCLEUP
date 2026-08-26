"use client";
/**
 * Transaction telemetry for CircleUp.
 *
 * # What is collected
 *
 * Funnel-stage counters only.  Each event records:
 *   - which stage of the transaction lifecycle was reached
 *   - which contract method was called
 *   - how long the stage took (ms)
 *   - the error category when a stage fails (never the raw message)
 *   - the network passphrase (identifies testnet vs mainnet)
 *
 * # What is never collected
 *
 *   - Wallet addresses (full or partial)
 *   - Signed or unsigned XDR
 *   - ScVal arguments (which may encode amounts, member lists, etc.)
 *   - Transaction hashes
 *   - Contract IDs
 *   - Any user-entered text (amounts, deadlines, descriptions)
 *   - Raw error messages (which may echo back user input)
 *
 * # Opt-in model
 *
 * Telemetry is **disabled by default**.  It activates only when:
 *
 *   NEXT_PUBLIC_TELEMETRY_ENABLED=true
 *
 * is set in the app environment.  The env var is evaluated once at module
 * load time — no runtime toggle.  This means:
 *   - Production deployments opt in explicitly; dev/test builds are silent.
 *   - Removing the var (or setting it to anything other than "true") disables
 *     all collection without a code change.
 *
 * # Transport
 *
 * By default events are written to `console.debug` so they appear in browser
 * dev-tools and log aggregators without requiring a third-party SDK.  Replace
 * `defaultTransport` with your own `TelemetryTransport` implementation to send
 * to a backend endpoint, Amplitude, Datadog RUM, etc.
 *
 *   import { configureTelemetry } from "@/lib/telemetry";
 *   configureTelemetry({ transport: myTransport });
 *
 * # Instrumentation safety guarantee
 *
 * `emit()` is fire-and-forget: it catches all errors internally and never
 * re-throws.  A failing transport cannot affect transaction retries, user
 * experience, or the return value of `invokeContract`.
 */

// ─── Stage names ──────────────────────────────────────────────────────────────

/**
 * The seven stages of the `invokeContract` lifecycle.
 *
 * Each stage maps to a distinct point in the flow:
 *
 * ```
 * started
 *   └─ account fetch + build tx
 *       ├─ simulate_failed        (RPC simulation returned an error)
 *       └─ simulated
 *           ├─ wallet_rejected    (user dismissed Freighter prompt)
 *           └─ submitted
 *               ├─ submission_failed  (sendTransaction returned ERROR)
 *               └─ [polling loop]
 *                   ├─ confirmed
 *                   ├─ timed_out
 *                   └─ failed         (getTransaction returned FAILED)
 * ```
 */
export type TxStage =
  | "started"           // invokeContract entered; account fetch begun
  | "simulated"         // simulateTransaction succeeded; simulation cost available
  | "simulate_failed"   // simulateTransaction returned an error response
  | "wallet_rejected"   // user dismissed or denied the Freighter signing prompt
  | "submitted"         // sendTransaction accepted; hash available
  | "submission_failed" // sendTransaction returned ERROR status
  | "confirmed"         // getTransaction returned SUCCESS
  | "timed_out"         // poll budget exhausted before SUCCESS/FAILED
  | "failed";           // getTransaction returned FAILED

// ─── Error categories ─────────────────────────────────────────────────────────

/**
 * Coarse-grained error category attached to failure events.
 *
 * These are the only error dimensions collected — the raw error message is
 * never included because it may echo user-entered values (amounts, addresses).
 */
export type TxErrorCategory =
  | "network"           // fetch/connectivity failure
  | "simulation_error"  // contract rule violation caught during simulation
  | "wallet_denied"     // user dismissed the signing prompt
  | "on_chain_failed"   // transaction landed on-chain but execution failed
  | "timeout"           // polling budget exhausted
  | "unknown";          // anything else

// ─── Event payload ────────────────────────────────────────────────────────────

/**
 * The shape of a single telemetry event.
 *
 * Every field is either a stage name, a method name string, a numeric
 * duration, or an error category.  No field ever contains an address,
 * hash, XDR blob, ScVal, or user-entered text.
 */
export interface TxTelemetryEvent {
  /** Unique name for funnel analysis: "tx.<stage>". */
  readonly name: string;
  /** The contract method being called (e.g. "join", "contribute", "payout"). */
  readonly method: string;
  /** Which stage of the lifecycle this event represents. */
  readonly stage: TxStage;
  /**
   * Wall-clock ms elapsed since the `started` event for this invocation.
   * Lets aggregators compute per-stage latency distributions.
   */
  readonly elapsedMs: number;
  /**
   * Error category for failure events; absent on success events.
   * Never contains the raw error message.
   */
  readonly errorCategory?: TxErrorCategory;
  /**
   * Stellar network passphrase.  Used to separate testnet from mainnet
   * funnels.  Does not identify any individual user or transaction.
   */
  readonly network: string;
}

// ─── Transport ────────────────────────────────────────────────────────────────

/** A function that receives a scrubbed event and sends it somewhere. */
export type TelemetryTransport = (event: TxTelemetryEvent) => void;

/** Default transport: structured console.debug for log aggregators. */
function defaultTransport(event: TxTelemetryEvent): void {
  // eslint-disable-next-line no-console
  console.debug("[circleup:telemetry]", JSON.stringify(event));
}

// ─── Module state ─────────────────────────────────────────────────────────────

/**
 * Telemetry is enabled only when NEXT_PUBLIC_TELEMETRY_ENABLED === "true".
 * Evaluated once at module load so the check is a simple boolean read at
 * emit time — no env access in the hot path.
 */
const TELEMETRY_ENABLED: boolean =
  process.env.NEXT_PUBLIC_TELEMETRY_ENABLED === "true";

let _transport: TelemetryTransport = defaultTransport;
let _network: string = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "";

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Override the default transport and/or network label.
 *
 * Call once at app startup (e.g. in `app/src/app/layout.tsx`) before any
 * transaction is attempted.  Calling this with an empty object is a no-op.
 *
 * @example
 * configureTelemetry({
 *   transport: (event) => myAnalytics.track(event.name, event),
 * });
 */
export function configureTelemetry(opts: {
  transport?: TelemetryTransport;
  network?: string;
}): void {
  if (opts.transport !== undefined) _transport = opts.transport;
  if (opts.network !== undefined) _network = opts.network;
}

// ─── Privacy scrubbing ────────────────────────────────────────────────────────

/**
 * Returns true when `value` looks like a Stellar address (G- or C- strkey,
 * 56 characters) that must not appear in a telemetry payload.
 *
 * Used by `scrubPayload` and exported so tests can verify the predicate.
 */
export function looksLikeAddress(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[GC][A-Z2-7]{55}$/.test(value)
  );
}

/**
 * Returns true when `value` looks like a transaction hash or XDR blob that
 * must not appear in a telemetry payload.
 *
 * Heuristics:
 *   - 64-character hex string → likely a tx hash
 *   - string longer than 100 characters → likely XDR or an encoded argument
 */
export function looksLikeSensitiveString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^[0-9a-f]{64}$/.test(value)) return true; // tx hash pattern
  if (value.length > 100) return true;             // XDR / encoded args
  return false;
}

/**
 * Recursively remove any key whose value matches a privacy heuristic.
 * Returns a new object — never mutates the input.
 *
 * Applied to the event payload before it reaches the transport so a
 * future code change that accidentally passes an address through cannot
 * leak it.
 */
export function scrubPayload(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (looksLikeAddress(value) || looksLikeSensitiveString(value)) {
      // Drop the field entirely — do not replace with a placeholder that
      // might still carry structural information (e.g. length).
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = scrubPayload(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Invocation context ───────────────────────────────────────────────────────

/**
 * Opaque handle returned by {@link startTx}.  Callers pass it to each
 * subsequent `emitStage` call so the per-invocation start time is tracked
 * without exposing any state to the caller.
 */
export interface TxContext {
  /** The contract method name (scrubbed of addresses before storage). */
  readonly method: string;
  /** Wall-clock ms when `startTx` was called. */
  readonly startedAt: number;
}

/**
 * Begin tracking a new transaction invocation.
 *
 * Emits the `started` event and returns a {@link TxContext} to pass to
 * subsequent `emitStage` calls.  The method name is included in events so
 * funnels can be broken down by operation (join, contribute, payout, close).
 *
 * @param method  The contract method being invoked (e.g. "contribute").
 *                Must not be an address, hash, or user-entered value.
 */
export function startTx(method: string): TxContext {
  const ctx: TxContext = { method, startedAt: Date.now() };
  emit(ctx, "started");
  return ctx;
}

// ─── Core emit ────────────────────────────────────────────────────────────────

/**
 * Emit a single telemetry stage event.
 *
 * Fire-and-forget: all errors from the transport are swallowed so a broken
 * analytics backend cannot affect the transaction flow or retry behaviour.
 *
 * @param ctx           Context returned by {@link startTx}.
 * @param stage         The lifecycle stage being reported.
 * @param errorCategory Optional error category for failure stages.
 */
export function emit(
  ctx: TxContext,
  stage: TxStage,
  errorCategory?: TxErrorCategory,
): void {
  if (!TELEMETRY_ENABLED) return;

  try {
    const rawEvent: TxTelemetryEvent = {
      name: `tx.${stage}`,
      method: ctx.method,
      stage,
      elapsedMs: Date.now() - ctx.startedAt,
      network: _network,
      ...(errorCategory !== undefined ? { errorCategory } : {}),
    };

    // Apply privacy scrubbing as a last-defence layer.  In normal operation
    // the payload already contains no sensitive fields — this guards against
    // accidental future additions.
    const scrubbed = scrubPayload(rawEvent as unknown as Record<string, unknown>);

    _transport(scrubbed as unknown as TxTelemetryEvent);
  } catch {
    // Transport errors are silently swallowed.  Never let telemetry affect
    // the transaction path.
  }
}

// ─── Error category derivation ────────────────────────────────────────────────

/**
 * Derive the coarse {@link TxErrorCategory} from a raw error message string.
 *
 * The raw message itself is never forwarded to the transport — only the
 * category label is included in the event.
 *
 * @param raw  The raw error string from the RPC, Freighter, or fetch layer.
 */
export function categorizeError(raw: string | undefined): TxErrorCategory {
  if (!raw) return "unknown";
  const lower = raw.toLowerCase();

  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("failed to fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("request timeout")
  ) {
    return "network";
  }

  if (
    lower.includes("denied") ||
    lower.includes("rejected") ||
    lower.includes("cancelled") ||
    lower.includes("canceled")
  ) {
    return "wallet_denied";
  }

  if (lower === "timeout") {
    return "timeout";
  }

  if (lower === "transaction failed") {
    return "on_chain_failed";
  }

  // simulateTransaction errors often carry contract panic messages
  if (
    lower.includes("simulate") ||
    lower.includes("contract") ||
    lower.includes("panic") ||
    lower.includes("soroban")
  ) {
    return "simulation_error";
  }

  return "unknown";
}

// ─── Telemetry-enabled predicate (for tests) ──────────────────────────────────

/** Returns the current enabled state. Useful in tests that override the env. */
export function isTelemetryEnabled(): boolean {
  return TELEMETRY_ENABLED;
}
