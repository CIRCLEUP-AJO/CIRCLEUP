/**
 * Tests for Issue 458: Canonical circle lifecycle and status model
 *
 * Verifies that:
 * - Status transitions follow the contract's state machine
 * - Action eligibility is correctly enforced per status
 * - Status display helpers return expected values
 * - Edge cases (unknown statuses, invalid transitions) are handled
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

  it("returns null for unknown statuses", () => {
    expect(normalizeStatus("unknown")).toBeNull();
    expect(normalizeStatus("")).toBeNull();
    expect(normalizeStatus("pending")).toBeNull(); // case-sensitive
  });
});

describe("assertValidStatus", () => {
  it("returns valid status on success", () => {
    expect(assertValidStatus("Active")).toBe("Active");
    expect(assertValidStatus("Pending")).toBe("Pending");
  });

  it("throws on non-string input", () => {
    expect(() => assertValidStatus(123)).toThrow("Expected circle status to be a string");
    expect(() => assertValidStatus(null)).toThrow("Expected circle status to be a string");
  });

  it("throws on invalid status string", () => {
    expect(() => assertValidStatus("unknown")).toThrow("Unrecognized circle status");
  });
});
