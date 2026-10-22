// Short-lived cross-tab coordination for in-flight actions (issue #800).
//
// UX guard only: never authorization, never a replacement for contract checks.
// No secret, signed XDR, or private payload is stored or shared — the lease
// value holds only { tab, expiresAt }. Leases expire automatically
// (`LEASE_TTL_MS`), are released on success/failure/tab close, and are scoped
// by network + circle + member + action so different wallets, circles, or
// networks never contend. Falls back to allow-single-tab when storage is
// unavailable (SSR, private mode).

export type LeaseAction = "join" | "contribute" | "payout" | "default" | "close";

export const LEASE_TTL_MS = 60_000;

export function leaseKey(opts: {
  network: string;
  circle: string;
  member: string;
  action: LeaseAction;
}): string {
  return `circleup:lease:${opts.network}:${opts.circle}:${opts.member}:${opts.action}`;
}

interface LeaseValue {
  tab: string;
  expiresAt: number;
}

export interface LeaseStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function backingStore(): LeaseStore | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    return null;
  }
  return null;
}

export function tabId(): string {
  try {
    const s = sessionStorage;
    let id = s.getItem("circleup:tab");
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      s.setItem("circleup:tab", id);
    }
    return id;
  } catch {
    return `mem-${Math.random().toString(36).slice(2)}`;
  }
}

export function readLease(store: LeaseStore, key: string, now = Date.now()): LeaseValue | null {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as LeaseValue;
    if (typeof v.expiresAt !== "number" || v.expiresAt <= now) return null;
    return v;
  } catch {
    return null;
  }
}

/** Returns true when this tab now holds the lease (or storage is unavailable). */
export function tryAcquireLease(
  key: string,
  opts?: { store?: LeaseStore | null; ttlMs?: number; now?: number },
): boolean {
  const store = opts?.store ?? backingStore();
  if (!store) return true; // fallback: single-tab behavior
  const now = opts?.now ?? Date.now();
  if (readLease(store, key, now)) return false;
  try {
    store.setItem(key, JSON.stringify({ tab: tabId(), expiresAt: now + (opts?.ttlMs ?? LEASE_TTL_MS) }));
    return true;
  } catch {
    return true;
  }
}

export function releaseLease(key: string, store?: LeaseStore | null): void {
  try {
    (store ?? backingStore())?.removeItem(key);
  } catch {
    // best-effort only
  }
}

export function isLeaseHeldByOther(
  key: string,
  opts?: { store?: LeaseStore | null; now?: number },
): boolean {
  const store = opts?.store ?? backingStore();
  if (!store) return false;
  const lease = readLease(store, key, opts?.now ?? Date.now());
  if (!lease) return false;
  try {
    return lease.tab !== tabId();
  } catch {
    return true;
  }
}
