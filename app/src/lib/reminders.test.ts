import { describe, it, expect, beforeEach } from "vitest";

import {
  clearAllReminders,
  clearReminder,
  loadReminders,
  pruneReminders,
  scheduleReminder,
  validateReminderInput,
} from "./reminders";

const BASE = {
  circleAddress: "CABC123",
  round: 2,
  deadlineLedger: 5000,
  latestLedger: 4000,
  network: "testnet",
};

beforeEach(() => {
  localStorage.clear();
  clearAllReminders();
});

describe("reminders — validation", () => {
  it("rejects scheduling when deadline data is missing (stale/missing input)", () => {
    expect(
      validateReminderInput({ ...BASE, deadlineLedger: null }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/unavailable|stale/i),
    });
    expect(
      validateReminderInput({ ...BASE, latestLedger: null }),
    ).toMatchObject({ ok: false });
  });

  it("rejects scheduling after the deadline has passed", () => {
    expect(
      validateReminderInput({ ...BASE, latestLedger: 5001 }),
    ).toMatchObject({ ok: false });
  });

  it("rejects network mismatch", () => {
    expect(
      validateReminderInput({ ...BASE, expectedNetwork: "mainnet" }),
    ).toMatchObject({ ok: false });
  });

  it("stores only scheduling metadata, never secrets", () => {
    const d = validateReminderInput(BASE);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(Object.keys(d.reminder).sort()).toEqual(
        [
          "circleAddress",
          "createdAtMs",
          "deadlineLedger",
          "latestLedger",
          "network",
          "round",
        ].sort(),
      );
    }
  });
});

describe("reminders — scheduling and cleanup", () => {
  it("duplicate scheduling refreshes instead of duplicating", () => {
    const d = validateReminderInput(BASE);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    scheduleReminder(d.reminder);
    scheduleReminder({ ...d.reminder, latestLedger: 4100 });
    const all = loadReminders();
    expect(all).toHaveLength(1);
    expect(all[0].latestLedger).toBe(4100);
  });

  it("a reminder can be disabled/cleared", () => {
    const d = validateReminderInput(BASE);
    if (!d.ok) return;
    scheduleReminder(d.reminder);
    clearReminder(BASE.circleAddress, BASE.round, BASE.network);
    expect(loadReminders()).toHaveLength(0);
  });

  it("prunes reminders after payout/default/pause or account (network) change", () => {
    const d = validateReminderInput(BASE);
    if (!d.ok) return;
    scheduleReminder(d.reminder);
    // Round advanced (payout) -> pruned
    let remaining = pruneReminders({
      activeRounds: new Map([["CABC123", 3]]),
      network: "testnet",
    });
    expect(remaining).toHaveLength(0);
    scheduleReminder(d.reminder);
    // Paused -> pruned
    remaining = pruneReminders({
      activeRounds: new Map([["CABC123", 2]]),
      network: "testnet",
      pausedCircles: new Set(["CABC123"]),
    });
    expect(remaining).toHaveLength(0);
    scheduleReminder(d.reminder);
    // Network change -> pruned
    remaining = pruneReminders({
      activeRounds: new Map([["CABC123", 2]]),
      network: "mainnet",
    });
    expect(remaining).toHaveLength(0);
  });
});
