/**
 * Tests for lib/fieldSource.ts
 *
 * Coverage:
 *   classifyFreshness  — stale, fresh, unknown states including edge cases
 *   formatSourceLabel  — combined label strings
 *   ariaSourceLabel    — accessible label strings
 *   SOURCE_LABELS      — all sources have labels
 *   FRESHNESS_LABELS   — unknown is never "current"
 */

import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  classifyFreshness,
  formatSourceLabel,
  ariaSourceLabel,
  SOURCE_LABELS,
  FRESHNESS_LABELS,
  type FieldSource,
  type FieldFreshness,
} from "./fieldSource";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RECENT_CHECKPOINT = new Date(Date.now() - 30_000).toISOString(); // 30 s ago
const OLD_CHECKPOINT    = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
const MAX_AGE_MS        = 120_000; // 2 min

// ═════════════════════════════════════════════════════════════════════════════
// classifyFreshness
// ═════════════════════════════════════════════════════════════════════════════

describe("classifyFreshness — null/absent checkpoint", () => {
  test("null → unknown", () => {
    assert.equal(classifyFreshness(null), "unknown");
  });

  test("undefined → unknown", () => {
    assert.equal(classifyFreshness(undefined), "unknown");
  });

  test("empty string → unknown", () => {
    assert.equal(classifyFreshness(""), "unknown");
  });

  test("unparseable string → unknown", () => {
    assert.equal(classifyFreshness("not-a-date"), "unknown");
  });
});

describe("classifyFreshness — fresh data", () => {
  test("recent checkpoint, data within maxAgeMs → fresh", () => {
    assert.equal(
      classifyFreshness(RECENT_CHECKPOINT, 30_000, MAX_AGE_MS),
      "fresh",
    );
  });

  test("recent checkpoint, no age args provided → fresh", () => {
    assert.equal(classifyFreshness(RECENT_CHECKPOINT), "fresh");
  });

  test("data age exactly at limit is not stale (boundary is >=)", () => {
    assert.equal(
      classifyFreshness(RECENT_CHECKPOINT, MAX_AGE_MS - 1, MAX_AGE_MS),
      "fresh",
    );
  });
});

describe("classifyFreshness — stale data", () => {
  test("data age >= maxAgeMs → stale regardless of checkpoint", () => {
    assert.equal(
      classifyFreshness(RECENT_CHECKPOINT, MAX_AGE_MS, MAX_AGE_MS),
      "stale",
    );
  });

  test("old checkpoint, data age >> maxAgeMs → stale", () => {
    assert.equal(
      classifyFreshness(OLD_CHECKPOINT, 600_000, MAX_AGE_MS),
      "stale",
    );
  });

  test("checkpoint present but data age well over limit → stale", () => {
    assert.equal(
      classifyFreshness(RECENT_CHECKPOINT, MAX_AGE_MS + 1, MAX_AGE_MS),
      "stale",
    );
  });
});

describe("classifyFreshness — missing age arguments", () => {
  test("checkpoint present but only one age arg → fresh (no threshold to compare)", () => {
    // Only dataAgeMs without maxAgeMs means we cannot classify as stale
    assert.equal(classifyFreshness(RECENT_CHECKPOINT, 500_000, undefined), "fresh");
  });

  test("maxAgeMs without dataAgeMs → fresh", () => {
    assert.equal(classifyFreshness(RECENT_CHECKPOINT, undefined, MAX_AGE_MS), "fresh");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// formatSourceLabel
// ═════════════════════════════════════════════════════════════════════════════

describe("formatSourceLabel", () => {
  test("indexer + fresh → 'Indexed · current'", () => {
    assert.equal(formatSourceLabel("indexer", "fresh"), "Indexed · current");
  });

  test("indexer + stale → 'Indexed · may lag chain'", () => {
    assert.equal(formatSourceLabel("indexer", "stale"), "Indexed · may lag chain");
  });

  test("indexer + unknown → 'Indexed · unknown freshness'", () => {
    assert.equal(formatSourceLabel("indexer", "unknown"), "Indexed · unknown freshness");
  });

  test("rpc + fresh → 'Live (RPC) · current'", () => {
    assert.equal(formatSourceLabel("rpc", "fresh"), "Live (RPC) · current");
  });

  test("local + fresh → 'Computed · current'", () => {
    assert.equal(formatSourceLabel("local", "fresh"), "Computed · current");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ariaSourceLabel
// ═════════════════════════════════════════════════════════════════════════════

describe("ariaSourceLabel", () => {
  test("returns a non-empty descriptive string", () => {
    const label = ariaSourceLabel("indexer", "stale");
    assert.ok(label.length > 0);
    assert.ok(label.includes("Indexed"));
    assert.ok(label.includes("may lag chain"));
  });

  test("unknown freshness is explicit in the aria label", () => {
    const label = ariaSourceLabel("indexer", "unknown");
    assert.ok(label.includes("unknown freshness"));
    assert.ok(!label.includes("current"), "unknown must not say current");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Invariant: unknown is never "current"
// ═════════════════════════════════════════════════════════════════════════════

describe("FRESHNESS_LABELS invariant", () => {
  const freshnesses: FieldFreshness[] = ["fresh", "stale", "unknown"];

  test("unknown label does not contain 'current'", () => {
    assert.ok(
      !FRESHNESS_LABELS["unknown"].includes("current"),
      "unknown freshness label must not say current",
    );
  });

  test("all freshness values have non-empty labels", () => {
    for (const f of freshnesses) {
      assert.ok(FRESHNESS_LABELS[f].length > 0, `missing label for freshness: ${f}`);
    }
  });
});

describe("SOURCE_LABELS coverage", () => {
  const sources: FieldSource[] = ["rpc", "indexer", "local"];

  test("all sources have non-empty labels", () => {
    for (const s of sources) {
      assert.ok(SOURCE_LABELS[s].length > 0, `missing label for source: ${s}`);
    }
  });
});
