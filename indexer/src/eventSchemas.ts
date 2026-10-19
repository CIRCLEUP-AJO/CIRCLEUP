/**
 * Event schema registry and compatibility checks (Issue #687).
 *
 * The topics and data tuples emitted by the factory, circle and reputation
 * contracts are a public integration contract: the indexer projects them into
 * Postgres and replays them from genesis.  This module is the machine-readable
 * counterpart of docs/EVENTS.md and docs/EVENT_COMPATIBILITY.md — every event
 * the indexer consumes (or deliberately ignores) has an entry here, and
 * `classifyEvent` decides, *before* any handler runs, whether a decoded event
 * matches a schema the indexer understands.
 *
 * Outcomes:
 *   projected     known schema, shape matches → the handler runs
 *   ignored       known schema the indexer intentionally does not project
 *                 (documented derivation rule) → no handler, no failure
 *   unknown       topic not in the registry → quarantined
 *   incompatible  known topic but the payload does not match any supported
 *                 version → quarantined
 *
 * Quarantined events are never projected.  processEvents routes them to a
 * handler that throws `UnsupportedEventError`, so the event's savepoint rolls
 * back (it is NOT recorded in ingested_events) and payload-free evidence is
 * written to event_failures, visible through GET /indexer/failures.  After the
 * indexer is upgraded to understand the new shape, replaying the affected
 * ledger range ingests the event normally and resolves the failure row.
 *
 * Versioning rule (see docs/EVENT_COMPATIBILITY.md):
 *   - Appending a trailing field is backwards compatible.  The new field is
 *     declared here with `since: <version>` and is optional for older events.
 *   - Removing, reordering or retyping a field is breaking and requires a new
 *     event name (e.g. `payout_v2`) plus a new entry here.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Native-decoded field kinds (after `scValToNative`). */
export type FieldKind =
  | "address" // Address → non-empty strkey string
  | "symbol" // Symbol → non-empty string
  | "u32" // u32 → non-negative integer number
  | "u64" // u64 → bigint (number accepted for narrower SDK decodes)
  | "i128" // i128 → bigint (number accepted for narrower SDK decodes)
  | "address_vec"; // Vec<Address> → array of strkey strings

export interface FieldSchema {
  name: string;
  kind: FieldKind;
  /**
   * Schema version that introduced this field.  Fields with `since` greater
   * than 1 are trailing, optional additions: events emitted by older contract
   * builds omit them and still match.
   */
  since?: number;
}

export type EventFamily = "factory" | "circle" | "reputation";

export interface EventSchema {
  family: EventFamily;
  name: string;
  /** Highest schema version the indexer understands for this event. */
  version: number;
  /** "projected" events have a handler; "ignored" ones are documented no-ops. */
  handling: "projected" | "ignored";
  /** Number of topics the event carries (including family + name). */
  topicCount: number;
  /**
   * Data payload shape: a tuple of fields, or a single scalar field when the
   * contract publishes a bare value instead of a tuple.
   */
  data: { tuple: FieldSchema[] } | { scalar: FieldSchema };
  /**
   * For circle events the first data field is the emitting circle's address;
   * when true, it must equal the event's contractId or the event is rejected
   * as incompatible (a mismatch would attribute the event to the wrong row).
   */
  firstFieldIsEmitter?: boolean;
  /** Where the projection/derivation is documented. */
  notes?: string;
}

export type EventClassification =
  | { status: "projected"; schema: EventSchema; version: number }
  | { status: "ignored"; schema: EventSchema; version: number }
  | { status: "unknown"; eventType: string; reason: string }
  | { status: "incompatible"; schema: EventSchema; eventType: string; reason: string };

/**
 * Thrown by the quarantine handler for unknown or incompatible events.
 * classifyHandlerError treats it as permanent, so the event is skipped (not
 * retried in a hot loop) and recorded in event_failures with
 * error_name = "UnsupportedEventError".
 */
export class UnsupportedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEventError";
  }
}

// ─── Registry ────────────────────────────────────────────────────────────────

const f = (name: string, kind: FieldKind, since?: number): FieldSchema =>
  since === undefined ? { name, kind } : { name, kind, since };

/**
 * Every event emitted by the CircleUp contracts.  Keep in sync with
 * docs/EVENTS.md and the fixtures in src/fixtures/event-fixtures.ts.
 */
export const EVENT_SCHEMAS: readonly EventSchema[] = [
  // ── factory ────────────────────────────────────────────────────────────────
  {
    family: "factory",
    name: "circle_created",
    version: 1,
    handling: "projected",
    topicCount: 2,
    data: {
      tuple: [f("circle_address", "address"), f("creator", "address"), f("circle_index", "u32")],
    },
  },

  // ── circle ─────────────────────────────────────────────────────────────────
  {
    family: "circle",
    name: "initialized",
    version: 2,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [
        f("circle_address", "address"),
        f("member_count", "u32"),
        f("round_amount", "i128"),
        // v2: payout rotation, so circle_members rows can be created from
        // events alone (docs/LIFECYCLE_EVENT_MATRIX.md, "join").
        f("members", "address_vec", 2),
      ],
    },
  },
  {
    family: "circle",
    name: "joined",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [
        f("circle_address", "address"),
        f("member", "address"),
        f("join_order", "u32"),
        f("collateral", "i128"),
      ],
    },
  },
  {
    family: "circle",
    name: "active",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: { tuple: [f("circle_address", "address"), f("deadline_ledger", "u64")] },
  },
  {
    family: "circle",
    name: "contributed",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [
        f("circle_address", "address"),
        f("member", "address"),
        f("round_index", "u32"),
        f("amount", "i128"),
      ],
    },
  },
  {
    family: "circle",
    name: "payout",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [
        f("circle_address", "address"),
        f("recipient", "address"),
        f("amount", "i128"),
        f("round_index", "u32"),
      ],
    },
  },
  {
    family: "circle",
    name: "default",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [
        f("circle_address", "address"),
        f("member", "address"),
        f("penalty", "i128"),
        f("round_index", "u32"),
        f("new_collateral", "i128"),
      ],
    },
  },
  {
    family: "circle",
    name: "round_started",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [
        f("circle_address", "address"),
        f("round_index", "u32"),
        f("recipient", "address"),
        f("deadline_ledger", "u64"),
      ],
    },
  },
  {
    family: "circle",
    name: "exceptional_settlement",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [
        f("circle_address", "address"),
        f("recipient", "address"),
        f("pot", "i128"),
        f("round_index", "u32"),
        f("defaulted_count", "u32"),
      ],
    },
  },
  {
    family: "circle",
    name: "completed",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: { tuple: [f("circle_address", "address"), f("member_count", "u32")] },
  },
  {
    family: "circle",
    name: "cancelled",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [f("circle_address", "address"), f("caller", "address"), f("ledger", "u32")],
    },
  },
  {
    family: "circle",
    name: "collateral_released",
    version: 1,
    handling: "ignored",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [f("circle_address", "address"), f("member", "address"), f("collateral", "i128")],
    },
    notes:
      "Per-member release inside close(); the aggregate is projected from circle/closed " +
      "(total_released). See docs/LIFECYCLE_EVENT_MATRIX.md.",
  },
  {
    family: "circle",
    name: "closed",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: {
      tuple: [
        f("circle_address", "address"),
        f("closer", "address"),
        f("total_released", "i128"),
        f("total_expected_collateral", "i128"),
        f("reason", "symbol"),
      ],
    },
  },
  {
    family: "circle",
    name: "paused",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: { tuple: [f("circle_address", "address"), f("admin", "address"), f("ledger", "u32")] },
  },
  {
    family: "circle",
    name: "resumed",
    version: 1,
    handling: "projected",
    topicCount: 2,
    firstFieldIsEmitter: true,
    data: { tuple: [f("circle_address", "address"), f("admin", "address"), f("ledger", "u32")] },
  },

  // ── reputation ─────────────────────────────────────────────────────────────
  {
    family: "reputation",
    name: "score_updated",
    version: 1,
    handling: "projected",
    topicCount: 2,
    data: { tuple: [f("member", "address"), f("new_total_score", "u32")] },
  },
  {
    family: "reputation",
    name: "increment",
    version: 1,
    handling: "projected",
    // Legacy shape: member carried as a third topic, data is the bare score.
    topicCount: 3,
    data: { scalar: f("score", "u32") },
    notes: "Legacy event kept for historical replay; current contracts emit score_updated.",
  },
  {
    family: "reputation",
    name: "caller_added",
    version: 1,
    handling: "ignored",
    topicCount: 2,
    data: { scalar: f("circle", "address") },
    notes: "Authorization allowlist; not projected (read get_authorized_callers on-chain).",
  },
  {
    family: "reputation",
    name: "caller_removed",
    version: 1,
    handling: "ignored",
    topicCount: 2,
    data: { scalar: f("circle", "address") },
    notes: "Authorization allowlist; not projected (read get_revoked_callers on-chain).",
  },
];

const SCHEMA_INDEX = new Map<string, EventSchema>(
  EVENT_SCHEMAS.map((s) => [`${s.family}/${s.name}`, s]),
);

const KNOWN_FAMILIES = new Set<string>(["factory", "circle", "reputation"]);

/** Look up the schema for `family/name`, or undefined when unregistered. */
export function getEventSchema(family: string, name: string): EventSchema | undefined {
  return SCHEMA_INDEX.get(`${family}/${name}`);
}

// ─── Field validation ────────────────────────────────────────────────────────

function describe(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Returns null when `value` matches `kind`, otherwise a reason string. */
export function checkFieldKind(kind: FieldKind, value: unknown): string | null {
  switch (kind) {
    case "address":
    case "symbol":
      return typeof value === "string" && value.length > 0 ? null : `expected ${kind}`;
    case "u32":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
        ? null
        : "expected u32";
    case "u64":
    case "i128":
      if (typeof value === "bigint") {
        return kind === "u64" && value < 0n ? "expected u64" : null;
      }
      return typeof value === "number" && Number.isSafeInteger(value) && (kind === "i128" || value >= 0)
        ? null
        : `expected ${kind}`;
    case "address_vec":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && v.length > 0)
        ? null
        : "expected Vec<Address>";
  }
}

/**
 * Determine which schema version a tuple payload matches.  Returns the
 * version on success, or a reason string when the payload is incompatible.
 */
function matchTuple(fields: FieldSchema[], value: unknown): number | string {
  if (!Array.isArray(value)) {
    return `expected data tuple of ${fields.length} field(s), got ${describe(value)}`;
  }
  const required = fields.filter((fs) => (fs.since ?? 1) <= 1).length;
  if (value.length < required) {
    return `expected at least ${required} data field(s), got ${value.length}`;
  }

  let version = 1;
  for (let i = 0; i < fields.length && i < value.length; i++) {
    const field = fields[i];
    const reason = checkFieldKind(field.kind, value[i]);
    if (reason) {
      return `field ${i} (${field.name}): ${reason}, got ${describe(value[i])}`;
    }
    version = Math.max(version, field.since ?? 1);
  }
  // Extra trailing fields beyond the registry are a forward-compatible
  // addition from a newer contract: accepted, but the event still matches
  // only the newest version the indexer knows.
  return version;
}

// ─── Classification ──────────────────────────────────────────────────────────

export interface ClassifiableEvent {
  /** Decoded topic values (topic[0] = family, topic[1] = name, …). */
  topics: unknown[];
  /** Decoded data payload. */
  data: unknown;
  /** Emitting contract address. */
  contractId: string | null;
}

/**
 * Classify a decoded event against the registry.  Pure — no I/O — so the same
 * check backs the live poller, replay, and the fixture tests.
 */
export function classifyEvent(event: ClassifiableEvent): EventClassification {
  const family = typeof event.topics[0] === "string" ? event.topics[0] : "";
  const name = typeof event.topics[1] === "string" ? event.topics[1] : "";
  const eventType = family && name ? `${family}/${name}` : family || "unknown";

  if (!family || !name) {
    return { status: "unknown", eventType, reason: "event is missing its family/name symbol topics" };
  }
  if (!KNOWN_FAMILIES.has(family)) {
    return { status: "unknown", eventType, reason: `unknown event family '${family}'` };
  }

  const schema = getEventSchema(family, name);
  if (!schema) {
    return { status: "unknown", eventType, reason: `no schema registered for ${eventType}` };
  }

  if (event.topics.length < schema.topicCount) {
    return {
      status: "incompatible",
      schema,
      eventType,
      reason: `expected ${schema.topicCount} topic(s), got ${event.topics.length}`,
    };
  }
  if (schema.topicCount === 3 && checkFieldKind("address", event.topics[2])) {
    return { status: "incompatible", schema, eventType, reason: "topic 2: expected address" };
  }

  let version: number;
  if ("scalar" in schema.data) {
    const reason = checkFieldKind(schema.data.scalar.kind, event.data);
    if (reason) {
      return {
        status: "incompatible",
        schema,
        eventType,
        reason: `data (${schema.data.scalar.name}): ${reason}, got ${describe(event.data)}`,
      };
    }
    version = 1;
  } else {
    const matched = matchTuple(schema.data.tuple, event.data);
    if (typeof matched === "string") {
      return { status: "incompatible", schema, eventType, reason: matched };
    }
    version = matched;

    if (schema.firstFieldIsEmitter && event.contractId) {
      const emitter = (event.data as unknown[])[0];
      if (emitter !== event.contractId) {
        return {
          status: "incompatible",
          schema,
          eventType,
          reason: "field 0 (circle_address) does not match the emitting contract",
        };
      }
    }
  }

  return schema.handling === "projected"
    ? { status: "projected", schema, version }
    : { status: "ignored", schema, version };
}

/** Human-readable quarantine message for an unknown/incompatible event. */
export function quarantineMessage(
  classification: Extract<EventClassification, { status: "unknown" | "incompatible" }>,
): string {
  return classification.status === "unknown"
    ? `Quarantined unknown event ${classification.eventType}: ${classification.reason}`
    : `Quarantined incompatible ${classification.eventType} ` +
        `(indexer supports up to v${classification.schema.version}): ${classification.reason}`;
}
