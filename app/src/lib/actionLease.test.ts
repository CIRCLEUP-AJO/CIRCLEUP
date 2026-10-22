import { describe, it, expect } from "vitest";
import { leaseKey, tryAcquireLease, releaseLease, isLeaseHeldByOther } from "./actionLease";

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("actionLease", () => {
  it("keys are scoped by network, circle, member, and action", () => {
    const a = leaseKey({ network: "testnet", circle: "C", member: "M", action: "contribute" });
    const b = leaseKey({ network: "mainnet", circle: "C", member: "M", action: "contribute" });
    const c = leaseKey({ network: "testnet", circle: "C", member: "OTHER", action: "contribute" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
  it("second tab contends while the lease is live", () => {
    const store = memStore();
    const key = leaseKey({ network: "testnet", circle: "C", member: "M", action: "join" });
    expect(tryAcquireLease(key, { store })).toBe(true);
    expect(tryAcquireLease(key, { store })).toBe(false);
  });
  it("stale leases expire and release recovers", () => {
    const store = memStore();
    const key = leaseKey({ network: "testnet", circle: "C", member: "M", action: "payout" });
    expect(tryAcquireLease(key, { store, ttlMs: 10, now: 1000 })).toBe(true);
    expect(tryAcquireLease(key, { store, now: 1000 + 11 })).toBe(true);
    releaseLease(key, store);
    expect(isLeaseHeldByOther(key, { store })).toBe(false);
  });
  it("stores no secret payload", () => {
    const store = memStore();
    const key = leaseKey({ network: "testnet", circle: "C", member: "M", action: "close" });
    tryAcquireLease(key, { store });
    const raw = (store as unknown as { getItem(k: string): string }).getItem(key) ?? "";
    expect(raw).not.toMatch(/xdr|secret|sign/i);
  });
});
