// ─── Shared circle status presentation model (Issue: status consistency) ─────
//
// Single source of truth for how every circle lifecycle status is presented
// across the app: list cards (CircleCard), the detail header (CircleHeader),
// and the status filter pills (CircleStatusFilter).
//
// Sources:
//   • Contract-native statuses: Pending, Active, Completed, Cancelled
//     (mirror the Rust CircleStatus enum in lifecycle.ts).
//   • Indexer-only projection: Closed (the contract tracks closure as a
//     boolean flag; the indexer projects it as a status string for queries).
//
// Unknown API values are handled by an explicit "Unsupported" presentation:
// a neutral slate visual variant, a description that says the value is not
// recognised, and an action policy with every mutation flag disabled. Unknown
// statuses must never imply an action is available when it is not — action
// availability is decided separately by the gating layer (lib/gating.ts) and
// the contract itself, but this module is the single source of truth for the
// status-derived action policy.

export type CircleStatus =
  | "Pending"
  | "Active"
  | "Completed"
  | "Cancelled"
  | "Closed";

/** Sentinel returned by normalizeStatus for unrecognised or malformed values. */
export const UNKNOWN_STATUS = "unknown" as const;

/** A normalised status: a known CircleStatus or the explicit unknown sentinel. */
export type NormalizedCircleStatus = CircleStatus | typeof UNKNOWN_STATUS;

/** Every recognised status, in a fixed order. Used for runtime membership checks. */
export const ALL_CIRCLE_STATUSES: readonly CircleStatus[] = [
  "Pending",
  "Active",
  "Completed",
  "Cancelled",
  "Closed",
] as const;

/**
 * Action policy derived from a status. Every mutation flag is false for the
 * unknown status so no write is ever enabled for an unrecognised value.
 */
export interface CircleStatusActionPolicy {
  /** True when any state-changing write is permitted for this status. */
  readonly canMutate: boolean;
  /** True when a member may contribute to the current round. */
  readonly canContribute: boolean;
  /** True when a new member may join the circle. */
  readonly canJoin: boolean;
  /** True when the circle may be started / activated. */
  readonly canActivate: boolean;
  /** True when the circle may be cancelled / dissolved. */
  readonly canCancel: boolean;
  /** True when collateral may be released / the circle closed. */
  readonly canClose: boolean;
}

/** Presentation for a single status: label, description, visual classes, and action policy. */
export interface CircleStatusPresentation {
  /** Visible label, e.g. "Active" or "Unsupported". */
  readonly label: string;
  /** Plain-language description, surfaced as a tooltip / screen-reader detail. */
  readonly description: string;
  /** Status chip background + text classes. */
  readonly chipClasses: string;
  /** Coloured dot indicator classes. */
  readonly dotClasses: string;
  /** Action policy for this status. All flags false for unknown statuses. */
  readonly actions: CircleStatusActionPolicy;
}

/** Action policy with every mutation disabled. Used for the unknown status. */
const NO_ACTIONS: CircleStatusActionPolicy = {
  canMutate: false,
  canContribute: false,
  canJoin: false,
  canActivate: false,
  canCancel: false,
  canClose: false,
};

// Canonical presentation per status. Labels match lifecycle.ts STATUS_LABELS
// so list, detail, and filter surfaces never disagree on wording.
const STATUS_PRESENTATION: Record<CircleStatus, CircleStatusPresentation> = {
  Pending: {
    label: "Pending",
    description: "Waiting for all members to lock collateral before the circle starts.",
    chipClasses: "bg-yellow-100 text-yellow-800",
    dotClasses: "bg-yellow-500",
    actions: {
      canMutate: true,
      canContribute: false,
      canJoin: true,
      canActivate: true,
      canCancel: true,
      canClose: false,
    },
  },
  Active: {
    label: "Active",
    description: "All members have joined. Contribution rounds are in progress.",
    chipClasses: "bg-brand-100 text-brand-700",
    dotClasses: "bg-brand-500",
    actions: {
      canMutate: true,
      canContribute: true,
      canJoin: false,
      canActivate: false,
      canCancel: true,
      canClose: false,
    },
  },
  Completed: {
    label: "Completed",
    description: "All rounds have been paid out successfully.",
    chipClasses: "bg-green-100 text-green-800",
    dotClasses: "bg-green-500",
    actions: {
      canMutate: true,
      canContribute: false,
      canJoin: false,
      canActivate: false,
      canCancel: false,
      canClose: true,
    },
  },
  Cancelled: {
    label: "Cancelled",
    description: "The circle was dissolved before becoming active.",
    chipClasses: "bg-red-100 text-red-800",
    dotClasses: "bg-red-400",
    actions: NO_ACTIONS,
  },
  Closed: {
    label: "Closed",
    description: "Collateral has been released. Circle fully settled.",
    chipClasses: "bg-slate-100 text-slate-500",
    dotClasses: "bg-slate-400",
    actions: NO_ACTIONS,
  },
};

/**
 * Explicit presentation for an unrecognised API value. Labelled "Unsupported",
 * neutral tone, and no action is ever available.
 */
const UNKNOWN_PRESENTATION: CircleStatusPresentation = {
  label: "Unsupported",
  description: "Unsupported status: not a known circle lifecycle state.",
  chipClasses: "bg-slate-100 text-slate-700",
  dotClasses: "bg-slate-400",
  actions: NO_ACTIONS,
};

/**
 * Normalise a raw status value (from the indexer or contract) to a known
 * CircleStatus. Comparison is case-insensitive and whitespace-tolerant.
 * Returns undefined for empty or unrecognised values.
 */
export function normalizeCircleStatus(raw: unknown): CircleStatus | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  return (ALL_CIRCLE_STATUSES as readonly string[]).find(
    (s) => s.toLowerCase() === lower,
  ) as CircleStatus | undefined;
}

/** Returns true when `value` is a recognised circle lifecycle status. */
export function isKnownCircleStatus(value: unknown): value is CircleStatus {
  return normalizeCircleStatus(value) !== undefined;
}

/**
 * Normalise a raw status value to a NormalizedCircleStatus. Unlike
 * normalizeCircleStatus, this never returns undefined: unrecognised or
 * malformed values map to the explicit UNKNOWN_STATUS sentinel.
 */
export function normalizeStatus(raw: unknown): NormalizedCircleStatus {
  return normalizeCircleStatus(raw) ?? UNKNOWN_STATUS;
}

/**
 * Return the presentation for a normalised status. The unknown sentinel
 * yields the explicit "Unsupported" presentation with all actions disabled.
 */
export function getStatusPresentation(
  status: NormalizedCircleStatus,
): CircleStatusPresentation {
  if (status === UNKNOWN_STATUS) return UNKNOWN_PRESENTATION;
  return STATUS_PRESENTATION[status];
}

/**
 * Return the presentation for a raw status value.
 *
 * Unknown values fall back to the explicit "Unsupported" presentation. The
 * raw value is never interpolated into the label or description (which are
 * rendered as text, not HTML); use describeUnknownStatus for diagnostics.
 */
export function getCircleStatusMeta(raw: unknown): CircleStatusPresentation {
  return getStatusPresentation(normalizeStatus(raw));
}

/**
 * Escape a value for safe plain-text diagnostics rendering. Strips control
 * characters and HTML-significant characters so the result can be shown in
 * logs or diagnostic panels without being interpreted as markup.
 */
export function escapeStatusForDiagnostics(raw: unknown): string {
  const text =
    typeof raw === "string"
      ? raw
      : raw === undefined || raw === null
        ? ""
        : String(raw);
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Produce a plain-text diagnostic string for an unrecognised status value.
 * The raw value is escaped and length-capped so malformed payloads cannot
 * break layout or inject markup. Returns an empty string for known statuses.
 */
export function describeUnknownStatus(raw: unknown): string {
  if (isKnownCircleStatus(raw)) return "";
  const escaped = escapeStatusForDiagnostics(raw);
  const capped = escaped.length > 64 ? `${escaped.slice(0, 64)}…` : escaped;
  return capped === ""
    ? "Unsupported status: empty or missing value."
    : `Unsupported status: "${capped}".`;
}
