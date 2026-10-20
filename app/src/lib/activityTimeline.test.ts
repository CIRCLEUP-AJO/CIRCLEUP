/**
 * Tests for the activity timeline read model.
 *
 * Acceptance criteria:
 *   - Supported events map to the correct category.
 *   - Unknown event types produce category:"unknown", not an error.
 *   - Events are ordered deterministically by ledger then event_position.
 *   - Pagination produces correct slices with hasMore and nextOffset.
 *   - Missing optional fields produce null (not undefined or errors).
 *   - Stable IDs are generated for React keys.
 */
import { describe, it, expect } from "vitest";
import {
  normaliseEventCategory,
  normaliseRawEvent,
  compareActivityEntries,
  buildTimelinePage,
  type ActivityEntry,
} from "./activityTimeline";

// ─── normaliseEventCategory ───────────────────────────────────────────────────

describe("normaliseEventCategory", () => {
  const cases: [string, string][] = [
    // join
    ["circle_join", "join"],
    ["join", "join"],
    ["joined", "join"],
    ["member_joined", "join"],
    // contribute
    ["circle_contribute", "contribute"],
    ["contribute", "contribute"],
    ["contributed", "contribute"],
    ["contribution", "contribute"],
    // payout
    ["circle_payout", "payout"],
    ["payout", "payout"],
    ["round_payout", "payout"],
    ["paid_out", "payout"],
    // default
    ["circle_default", "default"],
    ["default", "default"],
    ["defaulted", "default"],
    ["mark_default", "default"],
    // cancellation
    ["circle_cancelled", "cancellation"],
    ["cancelled", "cancellation"],
    ["cancellation", "cancellation"],
    // pause
    ["circle_paused", "pause"],
    ["circle_resumed", "pause"],
    ["paused", "pause"],
    ["resumed", "pause"],
    // completion
    ["circle_completed", "completion"],
    ["completed", "completion"],
    // close
    ["circle_closed", "close"],
    ["closed", "close"],
    ["collateral_released", "close"],
    // unknown
    ["some_future_event", "unknown"],
    ["", "unknown"],
    ["initialized", "unknown"],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => {
      expect(normaliseEventCategory(input)).toBe(expected);
    });
  }

  it("returns unknown for non-string", () => {
    expect(normaliseEventCategory(42)).toBe("unknown");
    expect(normaliseEventCategory(null)).toBe("unknown");
    expect(normaliseEventCategory(undefined)).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(normaliseEventCategory("CIRCLE_JOIN")).toBe("join");
    expect(normaliseEventCategory("Circle_Payout")).toBe("payout");
  });
});

// ─── normaliseRawEvent ────────────────────────────────────────────────────────

describe("normaliseRawEvent", () => {
  it("maps a well-formed contribution event", () => {
    const raw = {
      type: "circle_contribute",
      actor: "GAAAA",
      round: 2,
      amount: "10000000",
      tx_hash: "deadbeef",
      ledger: 1234,
      event_position: 0,
      timestamp: "2024-01-01T00:00:00Z",
    };
    const entry = normaliseRawEvent(raw, 0);
    expect(entry.category).toBe("contribute");
    expect(entry.actor).toBe("GAAAA");
    expect(entry.round).toBe(2);
    expect(entry.amountStroops).toBe("10000000");
    expect(entry.txHash).toBe("deadbeef");
    expect(entry.ledger).toBe(1234);
    expect(entry.eventPosition).toBe(0);
    expect(entry.indexerTimestamp).toBe("2024-01-01T00:00:00Z");
    expect(entry.rawEventType).toBe("circle_contribute");
  });

  it("uses penalty as amountStroops for default events", () => {
    const raw = {
      type: "circle_default",
      member_address: "GBBB",
      round: 1,
      penalty: "5000000",
    };
    const entry = normaliseRawEvent(raw, 0);
    expect(entry.category).toBe("default");
    expect(entry.amountStroops).toBe("5000000");
    expect(entry.actor).toBe("GBBB");
  });

  it("falls back to member_address when actor is absent", () => {
    const raw = { type: "join", member_address: "GCCC" };
    const entry = normaliseRawEvent(raw, 0);
    expect(entry.actor).toBe("GCCC");
  });

  it("produces null for missing optional fields", () => {
    const raw = { type: "circle_payout" };
    const entry = normaliseRawEvent(raw, 0);
    expect(entry.actor).toBeNull();
    expect(entry.round).toBeNull();
    expect(entry.amountStroops).toBeNull();
    expect(entry.ledger).toBeNull();
    expect(entry.eventPosition).toBeNull();
    expect(entry.txHash).toBeNull();
    expect(entry.indexerTimestamp).toBeNull();
  });

  it("unknown event type is preserved in rawEventType", () => {
    const raw = { type: "some_future_event_type", actor: "GDDD", ledger: 9999 };
    const entry = normaliseRawEvent(raw, 0);
    expect(entry.category).toBe("unknown");
    expect(entry.rawEventType).toBe("some_future_event_type");
  });

  it("produces a stable non-empty id", () => {
    const e1 = normaliseRawEvent({ type: "join", ledger: 100, event_position: 0 }, 0);
    const e2 = normaliseRawEvent({ type: "join", ledger: 100, event_position: 1 }, 1);
    expect(e1.id).toBeTruthy();
    expect(e2.id).toBeTruthy();
    expect(e1.id).not.toBe(e2.id);
  });

  it("sourceLabel includes ledger when present", () => {
    const raw = { type: "join", ledger: 42000 };
    const entry = normaliseRawEvent(raw, 0);
    expect(entry.sourceLabel).toContain("42");
  });

  it("sourceLabel is 'Indexed' when ledger is absent", () => {
    const raw = { type: "join" };
    const entry = normaliseRawEvent(raw, 0);
    expect(entry.sourceLabel).toBe("Indexed");
  });
});

// ─── compareActivityEntries ───────────────────────────────────────────────────

describe("compareActivityEntries", () => {
  function makeEntry(ledger: number | null, pos: number | null): ActivityEntry {
    return {
      id: `${ledger}-${pos}`,
      category: "contribute",
      rawEventType: "contribute",
      actor: null,
      round: null,
      amountStroops: null,
      ledger,
      eventPosition: pos,
      txHash: null,
      indexerTimestamp: null,
      sourceLabel: "Indexed",
    };
  }

  it("sorts by ledger ascending", () => {
    const a = makeEntry(100, null);
    const b = makeEntry(200, null);
    expect(compareActivityEntries(a, b)).toBeLessThan(0);
    expect(compareActivityEntries(b, a)).toBeGreaterThan(0);
  });

  it("sorts by event_position within the same ledger", () => {
    const a = makeEntry(100, 0);
    const b = makeEntry(100, 1);
    expect(compareActivityEntries(a, b)).toBeLessThan(0);
    expect(compareActivityEntries(b, a)).toBeGreaterThan(0);
  });

  it("null ledger sorts after known ledger", () => {
    const known = makeEntry(1, null);
    const nullLedger = makeEntry(null, null);
    expect(compareActivityEntries(known, nullLedger)).toBeLessThan(0);
    expect(compareActivityEntries(nullLedger, known)).toBeGreaterThan(0);
  });

  it("null eventPosition sorts after known position in the same ledger", () => {
    const known = makeEntry(100, 0);
    const nullPos = makeEntry(100, null);
    expect(compareActivityEntries(known, nullPos)).toBeLessThan(0);
  });

  it("equal ledger and equal position returns 0", () => {
    const a = makeEntry(100, 5);
    const b = makeEntry(100, 5);
    expect(compareActivityEntries(a, b)).toBe(0);
  });
});

// ─── buildTimelinePage ────────────────────────────────────────────────────────

describe("buildTimelinePage", () => {
  function makeRaw(ledger: number, pos: number, type = "circle_contribute") {
    return { type, ledger, event_position: pos, actor: "GAAA", round: 0 };
  }

  it("returns all entries when count <= limit", () => {
    const events = [makeRaw(1, 0), makeRaw(2, 0), makeRaw(3, 0)];
    const page = buildTimelinePage(events);
    expect(page.entries).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.totalCount).toBe(3);
  });

  it("paginates correctly with offset and limit", () => {
    const events = Array.from({ length: 25 }, (_, i) => makeRaw(i + 1, 0));
    const page = buildTimelinePage(events, 0, 20);
    expect(page.entries).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(20);

    const page2 = buildTimelinePage(events, 20, 20);
    expect(page2.entries).toHaveLength(5);
    expect(page2.hasMore).toBe(false);
  });

  it("entries are in ascending ledger order", () => {
    const events = [makeRaw(5, 0), makeRaw(1, 0), makeRaw(3, 0)];
    const page = buildTimelinePage(events);
    const ledgers = page.entries.map((e) => e.ledger);
    expect(ledgers).toEqual([1, 3, 5]);
  });

  it("unknown event types are included, not dropped", () => {
    const events = [
      makeRaw(1, 0, "circle_contribute"),
      makeRaw(2, 0, "future_unknown_event"),
    ];
    const page = buildTimelinePage(events);
    expect(page.entries).toHaveLength(2);
    const unknown = page.entries.find((e) => e.category === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown!.rawEventType).toBe("future_unknown_event");
  });

  it("empty input returns empty page with no hasMore", () => {
    const page = buildTimelinePage([]);
    expect(page.entries).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.totalCount).toBe(0);
  });

  it("all entries have unique ids", () => {
    const events = Array.from({ length: 10 }, (_, i) => makeRaw(i + 1, i));
    const page = buildTimelinePage(events);
    const ids = page.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
