/**
 * Canonical circle lifecycle and status model (Issue 458)
 *
 * CircleUp's core business logic depends on a clear and consistent lifecycle
 * for each ROSCA. This module defines the single source of truth for:
 *
 *   1. Valid circle statuses and their semantics
 *   2. Allowed transitions between statuses
 *   3. Which actions are permitted at each status
 *   4. Status derivation helpers for the frontend
 *
 * Statuses (mirrors the Rust contract enum):
 *   - Pending:   Circle created, waiting for members to join
 *   - Active:    All members joined, rounds in progress
 *   - Completed: All rounds paid out successfully
 *   - Cancelled: Circle dissolved before activation (member-initiated)
 *
 * Additional indexer-only status:
 *   - Closed:    Terminal state where collateral has been released
 *                (tracked as a boolean flag in the contract, projected as a
 *                status string by the indexer for query convenience)
 *
 * Lifecycle:
 *   Pending → Active    (when all members join)
 *   Pending → Cancelled (when a member cancels before full membership)
 *   Active  → Completed (when all rounds are paid out)
 *   Completed/Cancelled → Closed (when close() releases collateral)
 */

// ─── Status definitions ──────────────────────────────────────────────────────

/** All valid circle statuses as defined by the contract + indexer. */
export type CircleLifecycleStatus =
  | "Pending"
  | "Active"
  | "Completed"
  | "Cancelled"
  | "Closed";

/** Contract-native statuses (without the indexer's Closed projection). */
export type ContractCircleStatus = "Pending" | "Active" | "Completed" | "Cancelled";

/** Terminal statuses — no further state transitions are possible. */
export type TerminalStatus = "Completed" | "Cancelled" | "Closed";

/** Active statuses — the circle is operational and accepting contributions. */
export type ActiveStatus = "Active";

/** Pre-active statuses — the circle is not yet operational. */
export type PreActiveStatus = "Pending";

// ─── Transition rules ────────────────────────────────────────────────────────

/**
 * Defines which transitions are valid from each status.
 * Source: contracts/circle/src/lib.rs state machine.
 */
const VALID_TRANSITIONS: Record<CircleLifecycleStatus, readonly CircleLifecycleStatus[]> = {
  Pending:   ["Active", "Cancelled"],
  Active:    ["Completed"],
  Completed: ["Closed"],
  Cancelled: ["Closed"],
  Closed:    [],  // terminal — no further transitions
};

/**
 * Returns true when a transition from `from` to `to` is valid.
 *
 * @example
 * isValidTransition("Pending", "Active")      → true
 * isValidTransition("Active", "Pending")       → false
 * isValidTransition("Completed", "Closed")     → true
 */
export function isValidTransition(
  from: CircleLifecycleStatus,
  to: CircleLifecycleStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Returns the list of valid target statuses from the given status.
 */
export function validTransitionsFrom(
  status: CircleLifecycleStatus,
): readonly CircleLifecycleStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

// ─── Status classification ───────────────────────────────────────────────────

/**
 * Returns true when the circle is in a terminal state (Completed, Cancelled, or Closed).
 */
export function isTerminalStatus(status: string): boolean {
  return status === "Completed" || status === "Cancelled" || status === "Closed";
}

/**
 * Returns true when the circle is operational (Active).
 */
export function isActiveStatus(status: string): boolean {
  return status === "Active";
}

/**
 * Returns true when the circle is pending activation.
 */
export function isPendingStatus(status: string): boolean {
  return status === "Pending";
}

/**
 * Returns true when the circle's collateral has been released (Closed).
 */
export function isClosedStatus(status: string): boolean {
  return status === "Closed";
}

// ─── Action eligibility ──────────────────────────────────────────────────────

/** Contract actions that modify state. */
export type CircleAction = "join" | "contribute" | "payout" | "default" | "close" | "cancel";

/**
 * Returns the statuses in which a given action is permitted.
 *
 * Source: contract guard checks (assert_status_* functions in lib.rs).
 */
export function statusesForAction(action: CircleAction): readonly CircleLifecycleStatus[] {
  switch (action) {
    case "join":       return ["Pending"];
    case "contribute": return ["Active"];
    case "payout":     return ["Active"];
    case "default":    return ["Active"];
    case "close":      return ["Completed", "Cancelled"];
    case "cancel":     return ["Pending"];
    default:           return [];
  }
}

/**
 * Returns true when the given action is permitted for the circle's current status.
 */
export function isActionAllowed(action: CircleAction, status: string): boolean {
  const allowed = statusesForAction(action);
  return allowed.includes(status as CircleLifecycleStatus);
}

// ─── Status display helpers ──────────────────────────────────────────────────

/** Human-readable label for each status. */
export const STATUS_LABELS: Record<CircleLifecycleStatus, string> = {
  Pending:   "Pending",
  Active:    "Active",
  Completed: "Completed",
  Cancelled: "Cancelled",
  Closed:    "Closed",
};

/** CSS color classes for status badges. */
export const STATUS_COLORS: Record<CircleLifecycleStatus, string> = {
  Pending:   "bg-slate-100 text-slate-700 border-slate-300",
  Active:    "bg-brand-50 text-brand-700 border-brand-300",
  Completed: "bg-green-50 text-green-700 border-green-300",
  Cancelled: "bg-red-50 text-red-700 border-red-300",
  Closed:    "bg-slate-100 text-slate-500 border-slate-200",
};

/**
 * Returns a human-readable description of what each status means.
 */
export function describeStatus(status: CircleLifecycleStatus): string {
  switch (status) {
    case "Pending":
      return "Waiting for all members to lock collateral before the circle starts.";
    case "Active":
      return "All members have joined. Contribution rounds are in progress.";
    case "Completed":
      return "All rounds have been paid out successfully.";
    case "Cancelled":
      return "The circle was dissolved before becoming active.";
    case "Closed":
      return "Collateral has been released to members. This circle is fully settled.";
  }
}

/**
 * Returns a description of the next expected action for a circle in the given status.
 */
export function nextActionHint(
  status: CircleLifecycleStatus,
  options: { isMember?: boolean; allContributed?: boolean; roundComplete?: boolean } = {},
): string | null {
  switch (status) {
    case "Pending":
      return options.isMember
        ? "Waiting for other members to join."
        : "Connect your wallet and lock collateral to join.";
    case "Active":
      if (options.allContributed) {
        return "All members contributed. Payout can be triggered.";
      }
      return options.isMember
        ? "Contribute your share of the pot for this round."
        : "Waiting for members to contribute.";
    case "Completed":
      return "All rounds are complete. Collateral can be released.";
    case "Cancelled":
      return "This circle was cancelled. Collateral can be released.";
    case "Closed":
      return "This circle is fully settled. No further actions are possible.";
  }
}

// ─── Indexer status mapping ──────────────────────────────────────────────────

/**
 * Maps an indexer status string to the canonical lifecycle status.
 * The indexer may return "Closed" which is not in the contract enum but is
 * a valid lifecycle status for query convenience.
 */
export function normalizeStatus(raw: string): CircleLifecycleStatus | null {
  const valid: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
  if (valid.includes(raw as CircleLifecycleStatus)) {
    return raw as CircleLifecycleStatus;
  }
  return null;
}

/**
 * Asserts that a value is a valid circle lifecycle status.
 * Throws a descriptive error if not.
 */
export function assertValidStatus(value: unknown): CircleLifecycleStatus {
  if (typeof value !== "string") {
    throw new Error(`Expected circle status to be a string, got ${typeof value}`);
  }
  const normalized = normalizeStatus(value);
  if (!normalized) {
    throw new Error(
      `Unrecognized circle status "${value}". Valid statuses: ${["Pending", "Active", "Completed", "Cancelled", "Closed"].join(", ")}`,
    );
  }
  return normalized;
}
