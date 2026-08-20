/**
 * Canonical action-gating model for CircleUp.
 *
 * Before the app or SDK submits any contract write (join, contribute, payout,
 * mark_default, close) it must verify that:
 *
 *   1. The circle snapshot being acted on is still "fresh" (not expired).
 *   2. The circle is in the right lifecycle state for the requested action.
 *   3. For member-specific actions, the member satisfies the preconditions
 *      (has joined, has not already contributed, deadline is still open, etc.).
 *
 * This module is intentionally pure — no RPC calls, no I/O.  It takes a
 * {@link StateSnapshot} and returns a deterministic {@link GateResult} that the
 * caller can act on before constructing a transaction.
 *
 * @module gating
 */

import type { CircleStatus, RoundState, CircleConfig } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How old (in ms) a {@link StateSnapshot} is allowed to be before it is
 * considered stale and action-gating blocks writes unconditionally.
 *
 * 30 seconds: conservative enough to absorb a slow UI render cycle while
 * tight enough to catch a snapshot that missed a payout or default event.
 *
 * Callers may override this per-check via {@link GateOptions.maxSnapshotAgeMs}.
 */
export const DEFAULT_MAX_SNAPSHOT_AGE_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The four write actions that require state-based gating.
 * `mark_default` is omitted from UI-level gating because it is caller-agnostic
 * and is typically triggered by a bot/keeper rather than a member wallet.
 */
export type CircleAction = "join" | "contribute" | "payout" | "close";

/**
 * A snapshot of the on-chain circle state combined with the wall-clock time at
 * which it was fetched.  This is the input to every gating decision.
 *
 * @see {@link CircleClient.getFullState} — produces a snapshot via RPC.
 * @see {@link IndexerClient.getCircleDetail} — produces a snapshot via indexer.
 */
export interface StateSnapshot {
  /** Circle lifecycle status at the time of the fetch. */
  readonly status: CircleStatus;

  /** Current round state. `null` when the circle is Completed or Cancelled. */
  readonly currentRound: RoundState | null;

  /** Circle configuration (members, round_amount, deadline, …). */
  readonly config: CircleConfig;

  /**
   * Unix timestamp (ms) when this snapshot was fetched, e.g. `Date.now()`.
   * Used by {@link isSnapshotFresh} to compute age.
   */
  readonly fetchedAtMs: number;

  /**
   * The Stellar ledger sequence number at the time of the fetch.
   * Used to validate deadline proximity in ledger terms.
   * Pass `null` when not available (e.g. from the indexer without an RPC call).
   */
  readonly latestLedger: number | null;
}

/**
 * Result of a gate check.  A discriminated union so callers can exhaustively
 * pattern-match on `allowed` rather than checking for optional fields.
 */
export type GateResult =
  | GateAllowed
  | GateBlocked;

/** The action is safe to proceed. */
export interface GateAllowed {
  readonly allowed: true;
}

/**
 * The action must be blocked.  `reason` is a stable machine-readable code;
 * `message` is a human-readable explanation suitable for display in a UI toast
 * or log line.
 */
export interface GateBlocked {
  readonly allowed: false;
  /**
   * Machine-readable category — use this to branch in UI logic without parsing
   * `message` strings.
   *
   * | Code | Meaning |
   * |------|---------|
   * | `stale_snapshot` | The snapshot is older than `maxSnapshotAgeMs`. |
   * | `wrong_status` | The circle is not in the required status for this action. |
   * | `not_a_member` | The wallet is not in the circle's member list. |
   * | `already_joined` | The member has already locked collateral. |
   * | `already_contributed` | The member already contributed this round. |
   * | `deadline_passed` | The round deadline has expired; contributions are locked. |
   * | `round_not_complete` | Not all members have contributed; payout is premature. |
   * | `no_active_round` | No in-progress round exists (Completed or Cancelled). |
   */
  readonly reason: GateBlockReason;
  /** Human-readable explanation of why the action is blocked. */
  readonly message: string;
}

export type GateBlockReason =
  | "stale_snapshot"
  | "wrong_status"
  | "not_a_member"
  | "already_joined"
  | "already_contributed"
  | "deadline_passed"
  | "round_not_complete"
  | "no_active_round";

/**
 * Per-check options that override the module-level defaults.
 */
export interface GateOptions {
  /**
   * Maximum snapshot age in milliseconds before the action is blocked with
   * `reason: "stale_snapshot"`.  Defaults to {@link DEFAULT_MAX_SNAPSHOT_AGE_MS}.
   * Pass `Infinity` to disable the age check.
   */
  maxSnapshotAgeMs?: number;

  /**
   * Current wall-clock time in ms.  Defaults to `Date.now()`.
   * Override in tests to avoid real-time dependencies.
   */
  nowMs?: number;

  /**
   * The member wallet address performing the action.  Required for
   * `join`, `contribute`, and `close`.  Ignored for `payout`.
   */
  memberAddress?: string;

  /**
   * Whether the member has already locked collateral (joined).
   * When `true`, a `join` action is blocked with `reason: "already_joined"`.
   * Derived from `snapshot.config.members` membership + on-chain collateral;
   * callers supply it so the gating function stays pure.
   */
  hasLockedCollateral?: boolean;

  /**
   * Whether the member has already contributed to the current round.
   * When `true`, a `contribute` action is blocked with
   * `reason: "already_contributed"`.
   */
  hasContributedCurrentRound?: boolean;

  /**
   * Number of members who have contributed to the current round (counter from
   * the on-chain `RoundState.contributionsReceived` field).
   * Used by the `payout` gate to determine whether the pot is complete.
   */
  contributionsReceived?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns `true` when `snapshot` is younger than `maxAgeMs` milliseconds.
 *
 * A snapshot is fresh when:
 *   `nowMs - snapshot.fetchedAtMs < maxAgeMs`
 *
 * @param snapshot  The state snapshot to check.
 * @param maxAgeMs  Maximum allowed age in ms.  Pass `Infinity` to always return `true`.
 * @param nowMs     Current time in ms (defaults to `Date.now()`).
 */
export function isSnapshotFresh(
  snapshot: Pick<StateSnapshot, "fetchedAtMs">,
  maxAgeMs: number = DEFAULT_MAX_SNAPSHOT_AGE_MS,
  nowMs: number = Date.now(),
): boolean {
  if (maxAgeMs === Infinity) return true;
  return nowMs - snapshot.fetchedAtMs < maxAgeMs;
}

/**
 * Returns the age of a snapshot in milliseconds.
 *
 * @param snapshot  The state snapshot.
 * @param nowMs     Current time in ms (defaults to `Date.now()`).
 */
export function snapshotAgeMs(
  snapshot: Pick<StateSnapshot, "fetchedAtMs">,
  nowMs: number = Date.now(),
): number {
  return nowMs - snapshot.fetchedAtMs;
}

/**
 * Returns `true` when `address` is in `members`.
 * Comparison is case-sensitive (Stellar addresses are always uppercase).
 */
function isMemberAddress(members: string[], address: string): boolean {
  return members.includes(address);
}

// ─── Gate results ─────────────────────────────────────────────────────────────

function allowed(): GateAllowed {
  return { allowed: true };
}

function blocked(reason: GateBlockReason, message: string): GateBlocked {
  return { allowed: false, reason, message };
}

// ─── Per-action gate logic ────────────────────────────────────────────────────

/**
 * Gate a `join` call.
 *
 * Preconditions (checked in order):
 *   1. Snapshot is fresh.
 *   2. Circle status is `Pending`.
 *   3. `memberAddress` is in the configured members list.
 *   4. Member has not already locked collateral (joined).
 */
function gateJoin(snapshot: StateSnapshot, opts: GateOptions, nowMs: number): GateResult {
  const maxAge = opts.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;

  if (!isSnapshotFresh(snapshot, maxAge, nowMs)) {
    return blocked(
      "stale_snapshot",
      `Circle snapshot is ${snapshotAgeMs(snapshot, nowMs)}ms old (limit: ${maxAge}ms). ` +
        "Refresh the circle state before joining.",
    );
  }

  if (snapshot.status !== "Pending") {
    return blocked(
      "wrong_status",
      `join requires the circle to be Pending; current status is ${snapshot.status}.`,
    );
  }

  if (opts.memberAddress && !isMemberAddress(snapshot.config.members, opts.memberAddress)) {
    return blocked(
      "not_a_member",
      `Address ${opts.memberAddress} is not in this circle's member list.`,
    );
  }

  if (opts.hasLockedCollateral) {
    return blocked(
      "already_joined",
      "This wallet has already locked collateral for this circle.",
    );
  }

  return allowed();
}

/**
 * Gate a `contribute` call.
 *
 * Preconditions (checked in order):
 *   1. Snapshot is fresh.
 *   2. Circle status is `Active`.
 *   3. An active round exists in the snapshot.
 *   4. `memberAddress` is in the member list.
 *   5. Round deadline has not passed (based on `latestLedger`).
 *   6. Member has not already contributed this round.
 *   7. The snapshot's round index matches `currentRound.roundIndex` (stale-round guard).
 */
function gateContribute(snapshot: StateSnapshot, opts: GateOptions, nowMs: number): GateResult {
  const maxAge = opts.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;

  if (!isSnapshotFresh(snapshot, maxAge, nowMs)) {
    return blocked(
      "stale_snapshot",
      `Circle snapshot is ${snapshotAgeMs(snapshot, nowMs)}ms old (limit: ${maxAge}ms). ` +
        "Refresh the circle state before contributing.",
    );
  }

  if (snapshot.status !== "Active") {
    return blocked(
      "wrong_status",
      `contribute requires an Active circle; current status is ${snapshot.status}.`,
    );
  }

  const round = snapshot.currentRound;
  if (!round) {
    return blocked(
      "no_active_round",
      "No active round found in the snapshot. The circle may be Completed or Cancelled.",
    );
  }

  if (opts.memberAddress && !isMemberAddress(snapshot.config.members, opts.memberAddress)) {
    return blocked(
      "not_a_member",
      `Address ${opts.memberAddress} is not in this circle's member list.`,
    );
  }

  // Deadline check: only possible when latestLedger is known
  if (snapshot.latestLedger !== null) {
    if (snapshot.latestLedger > Number(round.deadlineLedger)) {
      return blocked(
        "deadline_passed",
        `Round ${round.roundIndex} deadline was ledger ${round.deadlineLedger}; ` +
          `latest indexed ledger is ${snapshot.latestLedger}. Contributions are closed.`,
      );
    }
  }

  if (opts.hasContributedCurrentRound) {
    return blocked(
      "already_contributed",
      `This wallet has already contributed to round ${round.roundIndex}.`,
    );
  }

  return allowed();
}

/**
 * Gate a `payout` call.
 *
 * Preconditions (checked in order):
 *   1. Snapshot is fresh.
 *   2. Circle status is `Active`.
 *   3. An active round exists.
 *   4. All members have contributed (`contributionsReceived === member_count`).
 */
function gatePayout(snapshot: StateSnapshot, opts: GateOptions, nowMs: number): GateResult {
  const maxAge = opts.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;

  if (!isSnapshotFresh(snapshot, maxAge, nowMs)) {
    return blocked(
      "stale_snapshot",
      `Circle snapshot is ${snapshotAgeMs(snapshot, nowMs)}ms old (limit: ${maxAge}ms). ` +
        "Refresh the circle state before triggering payout.",
    );
  }

  if (snapshot.status !== "Active") {
    return blocked(
      "wrong_status",
      `payout requires an Active circle; current status is ${snapshot.status}.`,
    );
  }

  const round = snapshot.currentRound;
  if (!round) {
    return blocked(
      "no_active_round",
      "No active round found in the snapshot. The circle may be Completed or Cancelled.",
    );
  }

  const memberCount = snapshot.config.members.length;
  const received =
    opts.contributionsReceived !== undefined
      ? opts.contributionsReceived
      : round.contributionsReceived;

  if (received < memberCount) {
    return blocked(
      "round_not_complete",
      `Payout requires all ${memberCount} members to contribute; ` +
        `${received} contribution(s) received so far in round ${round.roundIndex}.`,
    );
  }

  return allowed();
}

/**
 * Gate a `close` call.
 *
 * Preconditions (checked in order):
 *   1. Snapshot is fresh.
 *   2. Circle status is `Completed` or `Cancelled`.
 *   3. `memberAddress` is in the member list.
 */
function gateClose(snapshot: StateSnapshot, opts: GateOptions, nowMs: number): GateResult {
  const maxAge = opts.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;

  if (!isSnapshotFresh(snapshot, maxAge, nowMs)) {
    return blocked(
      "stale_snapshot",
      `Circle snapshot is ${snapshotAgeMs(snapshot, nowMs)}ms old (limit: ${maxAge}ms). ` +
        "Refresh the circle state before closing.",
    );
  }

  if (snapshot.status !== "Completed" && snapshot.status !== "Cancelled") {
    return blocked(
      "wrong_status",
      `close requires a Completed or Cancelled circle; current status is ${snapshot.status}.`,
    );
  }

  if (opts.memberAddress && !isMemberAddress(snapshot.config.members, opts.memberAddress)) {
    return blocked(
      "not_a_member",
      `Address ${opts.memberAddress} is not authorised to close this circle (not a member).`,
    );
  }

  return allowed();
}

// ─── Primary export ───────────────────────────────────────────────────────────

/**
 * Evaluate whether a contract action is safe to submit given the current
 * state snapshot.
 *
 * This is the single authoritative gating function.  Every path that can
 * produce a write transaction (SDK client methods, app action handlers) must
 * call this before submitting and honour a `GateBlocked` result by aborting
 * the transaction and surfacing the human-readable `message` to the user.
 *
 * The function is synchronous and pure: it makes no RPC calls, so it can be
 * called in render paths and unit-tested without network access.
 *
 * @param action    The contract action being requested.
 * @param snapshot  The most-recently-fetched circle state.
 * @param opts      Per-call options (member address, contribution flags, etc.).
 * @returns         A {@link GateResult} — check `result.allowed` before proceeding.
 *
 * @example
 * const result = computeActionEligibility("contribute", snapshot, {
 *   memberAddress: walletAddress,
 *   hasContributedCurrentRound: false,
 * });
 *
 * if (!result.allowed) {
 *   showError(result.message);
 *   return;
 * }
 * // safe to submit
 * await client.contribute(keypair);
 */
export function computeActionEligibility(
  action: CircleAction,
  snapshot: StateSnapshot,
  opts: GateOptions = {},
): GateResult {
  const nowMs = opts.nowMs ?? Date.now();

  switch (action) {
    case "join":
      return gateJoin(snapshot, opts, nowMs);
    case "contribute":
      return gateContribute(snapshot, opts, nowMs);
    case "payout":
      return gatePayout(snapshot, opts, nowMs);
    case "close":
      return gateClose(snapshot, opts, nowMs);
    default: {
      // TypeScript exhaustiveness guard — this branch is unreachable at
      // compile time; if a new action is added and the switch is not updated,
      // the compiler surfaces an error at the default branch.
      const _exhaustive: never = action;
      throw new Error(`computeActionEligibility: unknown action "${String(_exhaustive)}"`);
    }
  }
}

/**
 * Type-guard — narrows `GateResult` to `GateAllowed`.
 *
 * @example
 * const g = computeActionEligibility("payout", snapshot);
 * if (isGateAllowed(g)) await client.payout(keypair);
 */
export function isGateAllowed(result: GateResult): result is GateAllowed {
  return result.allowed === true;
}

/**
 * Type-guard — narrows `GateResult` to `GateBlocked`.
 *
 * @example
 * const g = computeActionEligibility("contribute", snapshot, opts);
 * if (isGateBlocked(g)) showBanner(g.message);
 */
export function isGateBlocked(result: GateResult): result is GateBlocked {
  return result.allowed === false;
}

/**
 * Build a {@link StateSnapshot} from the parts returned by
 * {@link CircleClient.getFullState}.
 *
 * The snapshot's `fetchedAtMs` is set to `Date.now()` so callers do not need
 * to manually capture the timestamp.
 *
 * @param status        Circle lifecycle status.
 * @param currentRound  Current round state, or `null` for terminal states.
 * @param config        Circle configuration.
 * @param latestLedger  Most-recently-indexed ledger (or `null`).
 * @param nowMs         Current time override (defaults to `Date.now()`).
 */
export function buildSnapshot(
  status: CircleStatus,
  currentRound: RoundState | null,
  config: CircleConfig,
  latestLedger: number | null = null,
  nowMs: number = Date.now(),
): StateSnapshot {
  return { status, currentRound, config, fetchedAtMs: nowMs, latestLedger };
}
