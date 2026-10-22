/**
 * Activity timeline read model.
 *
 * Normalises contract events from the indexer into a stable, bounded
 * chronological sequence. Unknown event variants are represented explicitly
 * rather than silently dropped, so the timeline never crashes on new event
 * types added by a future contract upgrade.
 *
 * Design constraints:
 *   - Pure: no I/O, no React, no DOM.
 *   - Deterministic ordering: primary key is ledger, secondary key is
 *     event_position (tie-breaker within the same ledger).
 *   - Bounded: callers supply a max entry count; entries beyond the limit are
 *     not included. Pagination state is returned so the UI can offer a
 *     "load more" affordance.
 *   - No raw XDR: the ActivityEntry type never includes raw Soroban XDR or
 *     full event payloads. Only the normalised fields are exposed.
 *   - Source labels: every entry carries a `sourceLabel` so the UI can show
 *     "Indexed · ledger N" without a second fetch.
 */

// ─── Event categories ─────────────────────────────────────────────────────────

/**
 * Canonical event categories. Maps multiple raw event type strings from the
 * indexer to a stable, documented category.
 *
 * | Category       | What it represents                                    |
 * |----------------|-------------------------------------------------------|
 * | join           | A member locked collateral and joined the circle      |
 * | contribute     | A member made their round contribution                |
 * | payout         | The pot was paid out to the round recipient           |
 * | default        | A member was marked as defaulted for a round          |
 * | cancellation   | The circle was cancelled (before activation)          |
 * | pause          | The circle was paused or resumed                      |
 * | completion     | All rounds completed; circle moved to Completed state |
 * | close          | Collateral was released; circle moved to Closed state |
 * | unknown        | Event type not recognised by this version of the app  |
 */
export type ActivityEventCategory =
  | "join"
  | "contribute"
  | "payout"
  | "default"
  | "cancellation"
  | "pause"
  | "completion"
  | "close"
  | "unknown";

/** Human-readable labels for each activity event category. */
export const ACTIVITY_CATEGORY_LABELS: Record<ActivityEventCategory, string> = {
  join:        "Member joined",
  contribute:  "Contribution",
  payout:      "Payout",
  default:     "Default recorded",
  cancellation:"Circle cancelled",
  pause:       "Circle paused / resumed",
  completion:  "Circle completed",
  close:       "Collateral released",
  unknown:     "Unknown event",
};

// ─── Activity entry ───────────────────────────────────────────────────────────

/**
 * A single normalised activity entry in the timeline.
 *
 * All fields sourced from the indexer are explicitly nullable so the UI never
 * has to substitute a value that was not in the data.
 */
export interface ActivityEntry {
  /**
   * Stable, deterministic sort key: `${ledger}-${eventPosition}`.
   * Used as the React `key` prop — must be unique within the timeline.
   */
  readonly id: string;

  /** Normalised event category. */
  readonly category: ActivityEventCategory;

  /**
   * Raw event type string from the indexer. Preserved for diagnostics and for
   * rendering unknown event types without data loss.
   */
  readonly rawEventType: string;

  /**
   * Actor address (the wallet that submitted the transaction) or null when
   * not available in the event payload. Never a contract address.
   */
  readonly actor: string | null;

  /**
   * Round index this event belongs to (0-based), or null for lifecycle events
   * that are not round-specific (e.g. cancellation, close).
   */
  readonly round: number | null;

  /**
   * Amount in stroops (string-serialised), or null when not applicable.
   * For contributions, this is the contribution amount. For payouts, the
   * full pot amount. For defaults, the penalty amount.
   */
  readonly amountStroops: string | null;

  /**
   * Ledger number where the event was recorded, or null if unavailable.
   * This is the authoritative ordering key.
   */
  readonly ledger: number | null;

  /**
   * Sequential position within the ledger (for tie-breaking). Null when not
   * available — entries with null eventPosition sort after those with a known
   * position in the same ledger.
   */
  readonly eventPosition: number | null;

  /**
   * Transaction hash, or null when not available. Used to build explorer links.
   */
  readonly txHash: string | null;

  /**
   * ISO-8601 timestamp string from the indexer, or null when not available.
   * Do NOT use for deterministic ordering — use ledger + eventPosition.
   */
  readonly indexerTimestamp: string | null;

  /** Short human-readable label for the data source (e.g. "Indexed · ledger 12345"). */
  readonly sourceLabel: string;
}

// ─── Raw event shape ──────────────────────────────────────────────────────────

/**
 * Raw event object from the indexer's event endpoint.
 * All fields are typed as `unknown` because we validate at runtime.
 */
export interface RawActivityEvent {
  type?: unknown;
  actor?: unknown;
  member_address?: unknown;
  round?: unknown;
  amount?: unknown;
  penalty?: unknown;
  ledger?: unknown;
  event_position?: unknown;
  tx_hash?: unknown;
  timestamp?: unknown;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface TimelinePage {
  /** Normalised entries for this page, in ascending ledger/position order. */
  readonly entries: ActivityEntry[];
  /** Total number of raw events before pagination. */
  readonly totalCount: number;
  /** Whether more entries exist beyond this page. */
  readonly hasMore: boolean;
  /** Starting index for the next page (offset-based). */
  readonly nextOffset: number;
}

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * Map a raw indexer event type string to a canonical ActivityEventCategory.
 *
 * The mapping handles both the current Soroban contract event naming convention
 * and historical spellings that appear in older indexed data.
 */
export function normaliseEventCategory(raw: unknown): ActivityEventCategory {
  if (typeof raw !== "string") return "unknown";
  const key = raw.trim().toLowerCase().replace(/[\s\-/]+/g, "_");

  switch (key) {
    case "circle_join":
    case "join":
    case "joined":
    case "member_joined":
      return "join";

    case "circle_contribute":
    case "contribute":
    case "contributed":
    case "contribution":
      return "contribute";

    case "circle_payout":
    case "payout":
    case "paid_out":
    case "round_payout":
    case "round_paid":
      return "payout";

    case "circle_default":
    case "default":
    case "defaulted":
    case "mark_default":
    case "member_default":
      return "default";

    case "circle_cancelled":
    case "cancelled":
    case "cancellation":
    case "circle_cancel":
      return "cancellation";

    case "circle_paused":
    case "circle_resumed":
    case "paused":
    case "resumed":
    case "pause":
    case "resume":
      return "pause";

    case "circle_completed":
    case "completed":
    case "completion":
    case "circle_complete":
      return "completion";

    case "circle_closed":
    case "closed":
    case "close":
    case "collateral_released":
    case "close_circle":
      return "close";

    default:
      return "unknown";
  }
}

/**
 * Normalise a single raw event from the indexer into a typed ActivityEntry.
 *
 * Never throws — unknown fields result in null values rather than errors.
 * Unknown event types are preserved as category:"unknown" with the raw type
 * kept in `rawEventType` so no data is lost.
 */
export function normaliseRawEvent(raw: RawActivityEvent, index: number): ActivityEntry {
  const rawType = typeof raw.type === "string" ? raw.type : "";
  const category = normaliseEventCategory(rawType);

  // Actor: prefer explicit actor field, fall back to member_address
  const actor =
    typeof raw.actor === "string" && raw.actor.trim() !== ""
      ? raw.actor.trim()
      : typeof raw.member_address === "string" && raw.member_address.trim() !== ""
      ? raw.member_address.trim()
      : null;

  const round =
    typeof raw.round === "number" && Number.isInteger(raw.round) && raw.round >= 0
      ? raw.round
      : null;

  // Amount: prefer `amount`, fall back to `penalty` (for default events)
  const rawAmount =
    typeof raw.amount === "string"
      ? raw.amount.trim()
      : typeof raw.penalty === "string"
      ? raw.penalty.trim()
      : null;
  const amountStroops = rawAmount && rawAmount !== "" ? rawAmount : null;

  const ledger =
    typeof raw.ledger === "number" && Number.isFinite(raw.ledger) && raw.ledger >= 0
      ? raw.ledger
      : null;

  const eventPosition =
    typeof raw.event_position === "number" &&
    Number.isFinite(raw.event_position) &&
    raw.event_position >= 0
      ? raw.event_position
      : null;

  const txHash =
    typeof raw.tx_hash === "string" && raw.tx_hash.trim() !== ""
      ? raw.tx_hash.trim()
      : null;

  const indexerTimestamp =
    typeof raw.timestamp === "string" && raw.timestamp.trim() !== ""
      ? raw.timestamp.trim()
      : null;

  // Stable, unique id for React keys
  const id =
    ledger !== null
      ? `${ledger}-${eventPosition ?? index}-${rawType || "event"}`
      : `idx-${index}-${rawType || "event"}`;

  const sourceLabel =
    ledger !== null ? `Indexed · ledger ${ledger.toLocaleString()}` : "Indexed";

  return {
    id,
    category,
    rawEventType: rawType,
    actor,
    round,
    amountStroops,
    ledger,
    eventPosition,
    txHash,
    indexerTimestamp,
    sourceLabel,
  };
}

// ─── Comparison / ordering ────────────────────────────────────────────────────

/**
 * Deterministic comparator for ActivityEntry objects.
 *
 * Primary: ascending ledger (null sorts last).
 * Secondary: ascending eventPosition within the same ledger (null sorts last).
 * Tertiary: stable index (preserved from input array position).
 */
export function compareActivityEntries(a: ActivityEntry, b: ActivityEntry): number {
  // Null ledger sorts after known ledger
  if (a.ledger === null && b.ledger !== null) return 1;
  if (a.ledger !== null && b.ledger === null) return -1;
  if (a.ledger !== null && b.ledger !== null && a.ledger !== b.ledger) {
    return a.ledger - b.ledger;
  }

  // Same ledger: sort by event position
  if (a.eventPosition === null && b.eventPosition !== null) return 1;
  if (a.eventPosition !== null && b.eventPosition === null) return -1;
  if (a.eventPosition !== null && b.eventPosition !== null) {
    return a.eventPosition - b.eventPosition;
  }

  return 0;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Build a bounded, paginated timeline from a raw events array.
 *
 * @param rawEvents - Raw events from the indexer (any shape; validated here).
 * @param offset    - 0-based offset for pagination.
 * @param limit     - Maximum number of entries to return (default 50).
 */
export function buildTimelinePage(
  rawEvents: unknown[],
  offset = 0,
  limit = 50,
): TimelinePage {
  // Normalise all events (unknown types are preserved, not dropped)
  const all: ActivityEntry[] = rawEvents.map((raw, i) =>
    normaliseRawEvent(raw as RawActivityEvent, i),
  );

  // Sort in ascending chronological order
  all.sort(compareActivityEntries);

  const totalCount = all.length;
  const page = all.slice(offset, offset + limit);
  const hasMore = offset + limit < totalCount;

  return {
    entries: page,
    totalCount,
    hasMore,
    nextOffset: offset + limit,
  };
}
