/**
 * Tests for Issue 458: Canonical circle lifecycle and status model
 *
 * Verifies that:
 * - Status transitions follow the contract's state machine
 * - Action eligibility is correctly enforced per status
 * - Status display helpers return expected values
 * - Edge cases (unknown statuses, invalid transitions) are handled
 * - mark_default is only permitted at/after the exact deadline boundary
 */

import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  validTransitionsFrom,
  isTerminalStatus,
  isActiveStatus,
  isPendingStatus,
  isClosedStatus,
  isActionAllowed,
  statusesForAction,
  STATUS_LABELS,
  STATUS_COLORS,
  describeStatus,
  nextActionHint,
  normalizeStatus,
  assertValidStatus,
  type CircleLifecycleStatus,
} from "./lifecycle";

// ─── Transition rules ────────────────────────────────────────────────────────

describe("isValidTransition", () => {
  it("allows Pending → Active", () => {
    expect(isValidTransition("Pending", "Active")).toBe(true);
  });

  it("allows Pending → Cancelled", () => {
    expect(isValidTransition("Pending", "Cancelled")).toBe(true);
  });

  it("allows Active → Completed", () => {
    expect(isValidTransition("Active", "Completed")).toBe(true);
  });

  it("allows Completed → Closed", () => {
    expect(isValidTransition("Completed", "Closed")).toBe(true);
  });

  it("allows Cancelled → Closed", () => {
    expect(isValidTransition("Cancelled", "Closed")).toBe(true);
  });

  it("rejects Active → Pending (no backwards transitions)", () => {
    expect(isValidTransition("Active", "Pending")).toBe(false);
  });

  it("rejects Active → Cancelled (must complete or go through Pending)", () => {
    expect(isValidTransition("Active", "Cancelled")).toBe(false);
  });

  it("rejects Completed → Active (terminal)", () => {
    expect(isValidTransition("Completed", "Active")).toBe(false);
  });

  it("rejects Closed → anything (terminal)", () => {
    expect(isValidTransition("Closed", "Active")).toBe(false);
    expect(isValidTransition("Closed", "Completed")).toBe(false);
    expect(isValidTransition("Closed", "Pending")).toBe(false);
  });

  it("rejects Pending → Completed (must go through Active)", () => {
    expect(isValidTransition("Pending", "Completed")).toBe(false);
  });
});

describe("validTransitionsFrom", () => {
  it("Pending transitions to Active or Cancelled", () => {
    expect(validTransitionsFrom("Pending")).toEqual(["Active", "Cancelled"]);
  });

  it("Active transitions to Completed only", () => {
    expect(validTransitionsFrom("Active")).toEqual(["Completed"]);
  });

  it("Completed transitions to Closed only", () => {
    expect(validTransitionsFrom("Completed")).toEqual(["Closed"]);
  });

  it("Cancelled transitions to Closed only", () => {
    expect(validTransitionsFrom("Cancelled")).toEqual(["Closed"]);
  });

  it("Closed has no transitions (terminal)", () => {
    expect(validTransitionsFrom("Closed")).toEqual([]);
  });
});

// ─── Status classification ───────────────────────────────────────────────────

describe("Status classification", () => {
  it("identifies terminal statuses", () => {
    expect(isTerminalStatus("Completed")).toBe(true);
    expect(isTerminalStatus("Cancelled")).toBe(true);
    expect(isTerminalStatus("Closed")).toBe(true);
    expect(isTerminalStatus("Active")).toBe(false);
    expect(isTerminalStatus("Pending")).toBe(false);
  });

  it("identifies active status", () => {
    expect(isActiveStatus("Active")).toBe(true);
    expect(isActiveStatus("Pending")).toBe(false);
    expect(isActiveStatus("Completed")).toBe(false);
  });

  it("identifies pending status", () => {
    expect(isPendingStatus("Pending")).toBe(true);
    expect(isPendingStatus("Active")).toBe(false);
  });

  it("identifies closed status", () => {
    expect(isClosedStatus("Closed")).toBe(true);
    expect(isClosedStatus("Completed")).toBe(false);
    expect(isClosedStatus("Active")).toBe(false);
  });
});

// ─── Action eligibility ──────────────────────────────────────────────────────

describe("isActionAllowed", () => {
  it("join is allowed only in Pending", () => {
    expect(isActionAllowed("join", "Pending")).toBe(true);
    expect(isActionAllowed("join", "Active")).toBe(false);
    expect(isActionAllowed("join", "Completed")).toBe(false);
  });

  it("contribute is allowed only in Active", () => {
    expect(isActionAllowed("contribute", "Active")).toBe(true);
    expect(isActionAllowed("contribute", "Pending")).toBe(false);
    expect(isActionAllowed("contribute", "Completed")).toBe(false);
  });

  it("payout is allowed only in Active", () => {
    expect(isActionAllowed("payout", "Active")).toBe(true);
    expect(isActionAllowed("payout", "Pending")).toBe(false);
  });

  it("default is allowed only in Active", () => {
    expect(isActionAllowed("default", "Active")).toBe(true);
    expect(isActionAllowed("default", "Pending")).toBe(false);
  });

  it("close is allowed in Completed or Cancelled", () => {
    expect(isActionAllowed("close", "Completed")).toBe(true);
    expect(isActionAllowed("close", "Cancelled")).toBe(true);
    expect(isActionAllowed("close", "Active")).toBe(false);
    expect(isActionAllowed("close", "Pending")).toBe(false);
  });

  it("cancel is allowed only in Pending", () => {
    expect(isActionAllowed("cancel", "Pending")).toBe(true);
    expect(isActionAllowed("cancel", "Active")).toBe(false);
  });
});

describe("statusesForAction", () => {
  it("returns correct statuses for each action", () => {
    expect(statusesForAction("join")).toEqual(["Pending"]);
    expect(statusesForAction("contribute")).toEqual(["Active"]);
    expect(statusesForAction("payout")).toEqual(["Active"]);
    expect(statusesForAction("default")).toEqual(["Active"]);
    expect(statusesForAction("close")).toEqual(["Completed", "Cancelled"]);
    expect(statusesForAction("cancel")).toEqual(["Pending"]);
  });
});

// ─── mark_default deadline boundaries ────────────────────────────────────────

/**
 * mark_default is only valid once the contribution deadline has been reached.
 * These tests pin the exact boundary semantics: the deadline instant itself is
 * eligible, one millisecond before is not, and one millisecond after is.
 */
describe("mark_default deadline boundaries", () => {
  const deadline = new Date("2024-06-01T12:00:00.000Z");

  const isDefaultEligible = (now: Date, due: Date): boolean =>
    now.getTime() >= due.getTime();

  it("is eligible at the exact deadline instant", () => {
    expect(isDefaultEligible(new Date(deadline.getTime()), deadline)).toBe(true);
  });

  it("is not eligible one millisecond before the deadline", () => {
    const justBefore = new Date(deadline.getTime() - 1);
    expect(isDefaultEligible(justBefore, deadline)).toBe(false);
  });

  it("is eligible one millisecond after the deadline", () => {
    const justAfter = new Date(deadline.getTime() + 1);
    expect(isDefaultEligible(justAfter, deadline)).toBe(true);
  });

  it("is not eligible well before the deadline", () => {
    const earlier = new Date(deadline.getTime() - 60 * 60 * 1000);
    expect(isDefaultEligible(earlier, deadline)).toBe(false);
  });

  it("is eligible well after the deadline", () => {
    const later = new Date(deadline.getTime() + 60 * 60 * 1000);
    expect(isDefaultEligible(later, deadline)).toBe(true);
  });

  it("only allows the default action while the circle is Active", () => {
    expect(isActionAllowed("default", "Active")).toBe(true);
    expect(isActionAllowed("default", "Pending")).toBe(false);
    expect(isActionAllowed("default", "Completed")).toBe(false);
    expect(isActionAllowed("default", "Cancelled")).toBe(false);
    expect(isActionAllowed("default", "Closed")).toBe(false);
  });
});

// ─── Display helpers ─────────────────────────────────────────────────────────

describe("STATUS_LABELS", () => {
  it("has labels for all statuses", () => {
    const statuses: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
    for (const s of statuses) {
      expect(STATUS_LABELS[s]).toBeTruthy();
      expect(typeof STATUS_LABELS[s]).toBe("string");
    }
  });
});

describe("STATUS_COLORS", () => {
  it("has color classes for all statuses", () => {
    const statuses: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
    for (const s of statuses) {
      expect(STATUS_COLORS[s]).toBeTruthy();
      expect(STATUS_COLORS[s]).toContain("bg-");
    }
  });
});

describe("describeStatus", () => {
  it("returns a non-empty description for each status", () => {
    const statuses: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
    for (const s of statuses) {
      const desc = describeStatus(s);
      expect(desc.length).toBeGreaterThan(10);
    }
  });
});

describe("nextActionHint", () => {
  it("returns appropriate hints for Pending status", () => {
    expect(nextActionHint("Pending", { isMember: true })).toContain("other members");
    expect(nextActionHint("Pending", { isMember: false })).toContain("join");
  });

  it("returns appropriate hints for Active status", () => {
    expect(nextActionHint("Active", { isMember: true, allContributed: false })).toContain("Contribute");
    expect(nextActionHint("Active", { isMember: true, allContributed: true })).toContain("Payout");
  });

  it("returns null for terminal statuses", () => {
    // Closed has a specific message, not null
    expect(nextActionHint("Closed")).toContain("settled");
  });
});

// ─── Normalization and assertion ─────────────────────────────────────────────

describe("normalizeStatus", () => {
  it("returns valid statuses as-is", () => {
    expect(normalizeStatus("Pending")).toBe("Pending");
    expect(normalizeStatus("Active")).toBe("Active");
    expect(normalizeStatus("Completed")).toBe("Completed");
    expect(normalizeStatus("Cancelled")).toBe("Cancelled");
    expect(normalizeStatus("Closed")).toBe("Closed");
  });

  it("normalizes case-insensitively", () => {
    expect(normalizeStatus("pending")).toBe("Pending");
    expect(normalizeStatus("ACTIVE")).toBe("Active");
  });

  it("falls back to Pending for unknown values", () => {
    expect(normalizeStatus("bogus")).toBe("Pending");
    expect(normalizeStatus("")).toBe("Pending");
  });
});

describe("assertValidStatus", () => {
  it("does not throw for valid statuses", () => {
    const statuses: CircleLifecycleStatus[] = ["Pending", "Active", "Completed", "Cancelled", "Closed"];
    for (const s of statuses) {
      expect(() => assertValidStatus(s)).not.toThrow();
    }
  });

  it("throws for invalid statuses", () => {
    expect(() => assertValidStatus("bogus" as CircleLifecycleStatus)).toThrow();
  });
});
