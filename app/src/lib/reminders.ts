// Round deadline reminders (Issue #796) — strictly opt-in, browser-scoped.
//
// Scope: an in-app/local reminder record only. Browser Notifications require
// explicit user permission and cannot be guaranteed while the app is closed;
// nothing here claims guaranteed delivery or replaces contract state.
// Only the minimum scheduling data is stored (circle, round, deadline
// ledger, network). Wallet secrets, private keys, and signed transactions
// are NEVER stored.

export interface RoundReminder {
  readonly circleAddress: string;
  readonly round: number;
  readonly deadlineLedger: number;
  /** Latest indexed ledger observed when the reminder was scheduled. */
  readonly latestLedger: number;
  readonly network: string;
  readonly createdAtMs: number;
}

export type ReminderDecision =
  | { ok: true; reminder: RoundReminder }
  | { ok: false; reason: string };

const STORAGE_KEY = "circleup.round-reminders.v1";

/** Validate circle/deadline/network context before scheduling. */
export function validateReminderInput(input: {
  circleAddress?: string | null;
  round?: number | null;
  deadlineLedger?: number | null;
  latestLedger?: number | null;
  network?: string | null;
  expectedNetwork?: string | null;
  nowMs?: number;
}): ReminderDecision {
  const {
    circleAddress,
    round,
    deadlineLedger,
    latestLedger,
    network,
    expectedNetwork,
    nowMs = Date.now(),
  } = input;

  if (!circleAddress || typeof circleAddress !== "string")
    return { ok: false, reason: "A valid circle address is required." };
  if (round == null || !Number.isInteger(round) || round < 1)
    return { ok: false, reason: "A valid round number is required." };
  // Stale or missing deadline data prevents scheduling — never invent one.
  if (deadlineLedger == null || latestLedger == null)
    return {
      ok: false,
      reason:
        "Deadline data is unavailable or stale; reminder not scheduled.",
    };
  if (!Number.isInteger(deadlineLedger) || !Number.isInteger(latestLedger))
    return { ok: false, reason: "Ledger values must be integers." };
  if (latestLedger > deadlineLedger)
    return {
      ok: false,
      reason: "The deadline ledger has already passed; reminder not scheduled.",
    };
  if (!network)
    return { ok: false, reason: "Network context is required." };
  if (expectedNetwork && network !== expectedNetwork)
    return {
      ok: false,
      reason: `Network mismatch: reminder is for ${network}, app is on ${expectedNetwork}.`,
    };
  return {
    ok: true,
    reminder: {
      circleAddress,
      round,
      deadlineLedger,
      latestLedger,
      network,
      createdAtMs: nowMs,
    },
  };
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadReminders(): RoundReminder[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RoundReminder =>
        !!r &&
        typeof (r as RoundReminder).circleAddress === "string" &&
        typeof (r as RoundReminder).deadlineLedger === "number",
    );
  } catch {
    return [];
  }
}

function persist(reminders: RoundReminder[]): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(reminders));
}

function keyOf(r: Pick<RoundReminder, "circleAddress" | "round" | "network">): string {
  return `${r.network}:${r.circleAddress}:${r.round}`;
}

/**
 * Schedule (or refresh) a reminder. Duplicate scheduling for the same
 * circle/round/network refreshes the existing record instead of duplicating.
 */
export function scheduleReminder(reminder: RoundReminder): RoundReminder[] {
  const existing = loadReminders().filter((r) => keyOf(r) !== keyOf(reminder));
  const next = [...existing, reminder];
  persist(next);
  return next;
}

/** Remove one reminder; returns the remaining records. */
export function clearReminder(
  circleAddress: string,
  round: number,
  network: string,
): RoundReminder[] {
  const next = loadReminders().filter(
    (r) =>
      keyOf(r) !== keyOf({ circleAddress, round, network }),
  );
  persist(next);
  return next;
}

/** Remove all reminders (account change, disable-all). */
export function clearAllReminders(): void {
  persist([]);
}

/**
 * Drop reminders invalidated by lifecycle events: payout, default, pause,
 * or account/network change. A reminder survives only when its circle/round
 * is still the active round on the same network.
 */
export function pruneReminders(opts: {
  activeRounds: ReadonlyMap<string, number>;
  network: string;
  pausedCircles?: ReadonlySet<string>;
}): RoundReminder[] {
  const paused = opts.pausedCircles ?? new Set<string>();
  const next = loadReminders().filter(
    (r) =>
      r.network === opts.network &&
      !paused.has(r.circleAddress) &&
      opts.activeRounds.get(r.circleAddress) === r.round,
  );
  persist(next);
  return next;
}

/** Notification permission wrapper — explicit opt-in, denial is respected. */
export async function requestReminderPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}
