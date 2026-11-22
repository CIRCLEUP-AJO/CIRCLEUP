import { describe, it, expect } from "vitest";

import {
  CircleStatus,
  ALL_CIRCLE_STATUSES,
  normalizeCircleStatus,
  isKnownCircleStatus,
  getCircleStatusMeta,
  type CircleStatusPresentation,
} from "./circleStatus";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Future / unsupported status strings that may cross the versioned deployment
 * boundary (indexer rows or API payloads) before the client understands them.
 */
const FUTURE_STATUS_FIXTURES = [
  "Paused",
  "Disputed",
  "Suspended",
  "Archived",
  "PENDING_REVIEW",
] as const;

/**
 * Malformed status values that should never crash the UI and must normalize to
 * the explicit unknown presentation.
 */
const MALFORMED_STATUS_FIXTURES: unknown[] = [
  "",
  "   ",
  null,
  undefined,
  123,
  0,
  NaN,
  true,
  false,
  {},
  [],
  { status: "Active" },
  ["Active"],
  () => "Active",
];

// ─── Supported values ─────────────────────────────────────────────────────────

const SUPPORTED: Record<CircleStatus, Partial<CircleStatusPresentation>> = {
  Pending: { label: "Pending", chipClasses: "bg-yellow-100", dotClasses: "bg-yellow-500" },
  Active:  { label: "Active",  chipClasses: "bg-brand-100",  dotClasses: "bg-brand-500" },
  Completed: { label: "Completed", chipClasses: "bg-green-100", dotClasses: "bg-green-500" },
  Cancelled: { label: "Cancelled", chipClasses: "bg-red-100", dotClasses: "bg-red-400" },
  Closed:  { label: "Closed",  chipClasses: "bg-slate-100", dotClasses: "bg-slate-400" },
};

describe("circleStatus — supported values", () => {
  it("exposes all five contract + indexer statuses", () => {
    expect(ALL_CIRCLE_STATUSES).toEqual([
      "Pending", "Active", "Completed", "Cancelled", "Closed",
    ]);
  });

  it.each(Object.keys(SUPPORTED) as CircleStatus[])("renders %s consistently", (status) => {
    const meta = getCircleStatusMeta(status);
    expect(meta.label).toBe(SUPPORTED[status].label);
    expect(meta.chipClasses).toContain(SUPPORTED[status].chipClasses);
    expect(meta.dotClasses).toContain(SUPPORTED[status].dotClasses);
    expect(typeof meta.description).toBe("string");
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it("is case-insensitive for every supported status", () => {
    for (const status of ALL_CIRCLE_STATUSES) {
      expect(getCircleStatusMeta(status.toUpperCase()).label).toBe(status);
      expect(getCircleStatusMeta(status.toLowerCase()).label).toBe(status);
      expect(getCircleStatusMeta(` ${status} `).label).toBe(status);
    }
  });

  it("isKnownCircleStatus returns true for supported, false otherwise", () => {
    for (const status of ALL_CIRCLE_STATUSES) {
      expect(isKnownCircleStatus(status)).toBe(true);
    }
    expect(isKnownCircleStatus("bogus")).toBe(false);
    expect(isKnownCircleStatus("")).toBe(false);
    expect(isKnownCircleStatus(null)).toBe(false);
    expect(isKnownCircleStatus(undefined)).toBe(false);
    expect(isKnownCircleStatus(123)).toBe(false);
  });

  it("normalizes every known status to itself (case/whitespace-insensitive)", () => {
    for (const status of ALL_CIRCLE_STATUSES) {
      expect(normalizeCircleStatus(status)).toBe(status);
      expect(normalizeCircleStatus(status.toUpperCase())).toBe(status);
      expect(normalizeCircleStatus(status.toLowerCase())).toBe(status);
      expect(normalizeCircleStatus(` ${status} `)).toBe(status);
    }
  });

  it("enables mutation actions for every known status", () => {
    for (const status of ALL_CIRCLE_STATUSES) {
      const meta = getCircleStatusMeta(status);
      expect(meta.isKnown).toBe(true);
      expect(meta.actionsEnabled).toBe(true);
    }
  });
});

// ─── Unknown values ───────────────────────────────────────────────────────────

describe("circleStatus — unknown values (safe fallback)", () => {
  it("preserves the raw value as the label for an unrecognised status", () => {
    const meta = getCircleStatusMeta("WeirdStatus");
    expect(meta.label).toBe("WeirdStatus");
    expect(meta.chipClasses).toContain("slate");
    expect(meta.dotClasses).toContain("slate");
  });

  it("describes an unrecognised status as unrecognized", () => {
    const meta = getCircleStatusMeta("bogus");
    expect(meta.description).toMatch(/Unrecognized/i);
    expect(meta.description).toContain("bogus");
  });

  it("returns an explicit Unknown label for empty string", () => {
    expect(getCircleStatusMeta("").label).toBe("Unknown");
    expect(getCircleStatusMeta("  ").label).toBe("Unknown");
  });

  it("returns an explicit Unknown label for null / undefined / non-strings", () => {
    expect(getCircleStatusMeta(null).label).toBe("Unknown");
    expect(getCircleStatusMeta(undefined).label).toBe("Unknown");
    expect(getCircleStatusMeta(null).description).toMatch(/Unrecognized/i);
  });

  it("never returns a known-status presentation for an unknown value", () => {
    const labels = new Set(ALL_CIRCLE_STATUSES.map((s) => getCircleStatusMeta(s).label));
    expect(labels.has(getCircleStatusMeta("bogus").label)).toBe(false);
  });

  it.each(FUTURE_STATUS_FIXTURES)(
    "normalizes future status %s to 'unknown'",
    (future) => {
      expect(normalizeCircleStatus(future)).toBe("unknown");
      expect(isKnownCircleStatus(future)).toBe(false);
    },
  );

  it.each(FUTURE_STATUS_FIXTURES)(
    "renders future status %s with the unsupported presentation",
    (future) => {
      const meta = getCircleStatusMeta(future);
      expect(meta.isKnown).toBe(false);
      expect(meta.actionsEnabled).toBe(false);
      expect(meta.chipClasses).toContain("slate");
      expect(meta.dotClasses).toContain("slate");
      expect(meta.description).toMatch(/Unrecognized/i);
      // Raw value is surfaced for diagnostics, not interpolated as HTML.
      expect(meta.description).toContain(future);
      expect(meta.description).not.toContain("<");
      expect(meta.description).not.toContain(">");
    },
  );

  it.each(MALFORMED_STATUS_FIXTURES)(
    "normalizes malformed value %p to 'unknown'",
    (value) => {
      expect(normalizeCircleStatus(value)).toBe("unknown");
      expect(isKnownCircleStatus(value)).toBe(false);
    },
  );

  it.each(MALFORMED_STATUS_FIXTURES)(
    "renders malformed value %p with the unsupported presentation",
    (value) => {
      const meta = getCircleStatusMeta(value);
      expect(meta.isKnown).toBe(false);
      expect(meta.actionsEnabled).toBe(false);
      expect(meta.label).toBe("Unknown");
      expect(meta.chipClasses).toContain("slate");
      expect(meta.dotClasses).toContain("slate");
      expect(meta.description).toMatch(/Unrecognized/i);
    },
  );

  it("does not interpolate raw HTML from a hostile status string", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const meta = getCircleStatusMeta(hostile);
    expect(meta.isKnown).toBe(false);
    expect(meta.actionsEnabled).toBe(false);
    // The raw value may appear as text, but must not be treated as markup.
    expect(meta.description).not.toContain("<img");
    expect(meta.description).not.toContain("onerror");
  });

  it("disables all mutation actions for every unknown value", () => {
    const unknowns: unknown[] = [
      ...FUTURE_STATUS_FIXTURES,
      ...MALFORMED_STATUS_FIXTURES,
      "bogus",
    ];
    for (const value of unknowns) {
      expect(getCircleStatusMeta(value).actionsEnabled).toBe(false);
    }
  });
});
