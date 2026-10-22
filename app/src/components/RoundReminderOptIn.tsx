"use client";

import { useEffect, useState } from "react";

import {
  clearReminder,
  loadReminders,
  requestReminderPermission,
  scheduleReminder,
  validateReminderInput,
  type RoundReminder,
} from "@/lib/reminders";

interface Props {
  circleAddress: string;
  round: number | null | undefined;
  deadlineLedger: number | null | undefined;
  latestLedger: number | null | undefined;
  network: string;
}

/**
 * Opt-in round deadline reminder toggle. Best-effort in-app record only —
 * the UI states it cannot guarantee delivery while the app is closed, and
 * dates derived from ledger estimates are labelled approximate.
 */
export function RoundReminderOptIn({
  circleAddress,
  round,
  deadlineLedger,
  latestLedger,
  network,
}: Props) {
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(
      loadReminders().some(
        (r: RoundReminder) =>
          r.circleAddress === circleAddress &&
          r.round === round &&
          r.network === network,
      ),
    );
  }, [circleAddress, round, network]);

  async function enable() {
    const decision = validateReminderInput({
      circleAddress,
      round,
      deadlineLedger,
      latestLedger,
      network,
    });
    if (!decision.ok) {
      setNotice(decision.reason);
      return;
    }
    const permission = await requestReminderPermission();
    if (permission === "denied") {
      setNotice(
        "Browser notifications are blocked. Enable them in your browser settings to use reminders.",
      );
      return;
    }
    // "unsupported" still allows the in-app record; delivery stays best-effort.
    scheduleReminder(decision.reminder);
    setEnabled(true);
    setNotice(
      permission === "unsupported"
        ? "Reminder saved in this browser (in-app only; your browser does not support notifications). Approximate deadline — delivery not guaranteed."
        : "Reminder saved in this browser. Approximate deadline — delivery not guaranteed, especially while the app is closed.",
    );
  }

  function disable() {
    if (round != null) clearReminder(circleAddress, round, network);
    setEnabled(false);
    setNotice("Reminder removed from this browser.");
  }

  return (
    <div
      className="border rounded-xl p-4 flex items-start gap-3 bg-slate-50 border-slate-200"
      role="group"
      aria-label="Round deadline reminder"
    >
      <div className="flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Deadline reminder (opt-in)
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Optional reminder in this browser only. Approximate deadline derived
          from ledger data — not guaranteed, and contract state is authoritative.
        </p>
        {notice && (
          <p className="text-xs mt-1 text-slate-600" role="status">
            {notice}
          </p>
        )}
      </div>
      {enabled ? (
        <button
          type="button"
          onClick={disable}
          className="text-xs font-medium underline text-slate-700 hover:text-slate-900"
        >
          Disable
        </button>
      ) : (
        <button
          type="button"
          onClick={enable}
          className="text-xs font-medium underline text-slate-700 hover:text-slate-900"
        >
          Remind me
        </button>
      )}
    </div>
  );
}
