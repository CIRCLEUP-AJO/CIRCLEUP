import { describe, it, expect, vi } from "vitest";
import { dedupeLedger, backoffMs, startBoundedPolling } from "./indexerUpdates";

describe("indexerUpdates", () => {
  it("drops null ledgers and duplicates, accepts new ones", () => {
    expect(dedupeLedger(null, null)).toBe(false);
    expect(dedupeLedger(10, 10)).toBe(false);
    expect(dedupeLedger(10, 11)).toBe(true);
    expect(dedupeLedger(null, 11)).toBe(true);
  });
  it("backs off with a cap", () => {
    expect(backoffMs(0, 1000, 30000)).toBeGreaterThanOrEqual(1000);
    expect(backoffMs(20, 1000, 30000)).toBeLessThanOrEqual(30250);
  });
  it("stops after maxPolls and dedupes notifications", async () => {
    vi.useFakeTimers();
    const seen: Array<number | null> = [];
    const src = startBoundedPolling({
      circleAddress: "C",
      fetchLedger: async () => 42,
      onUpdate: (u) => {
        expect(u.confirmed).toBe(false);
        seen.push(u.latestLedger);
      },
      intervalMs: 1000,
      maxPolls: 3,
    });
    await vi.advanceTimersByTimeAsync(5000);
    src.stop();
    expect(seen).toEqual([42]);
    expect(src.attempts).toBe(3);
    vi.useRealTimers();
  });
  it("recovers from a failed poll without throwing", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const seen: Array<number | null> = [];
    const src = startBoundedPolling({
      circleAddress: "C",
      fetchLedger: async () => {
        calls += 1;
        if (calls === 1) throw new Error("down");
        return 7;
      },
      onUpdate: (u) => seen.push(u.latestLedger),
      intervalMs: 1000,
      maxPolls: 2,
    });
    await vi.advanceTimersByTimeAsync(3000);
    src.stop();
    expect(seen).toEqual([7]);
    vi.useRealTimers();
  });
});
