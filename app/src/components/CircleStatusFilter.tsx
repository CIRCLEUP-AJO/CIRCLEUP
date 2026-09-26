"use client";

import { useRouter, usePathname } from "next/navigation";
import { useTransition } from "react";
import clsx from "clsx";
import type { CircleStatusFilter as StatusFilter } from "@/app/page";
import { CIRCLE_STATUS_OPTIONS } from "@/app/page";

// ─── Label + colour map ───────────────────────────────────────────────────────

const STATUS_UI: Record<
  StatusFilter | "All",
  { label: string; activeClasses: string; dotClasses: string }
> = {
  All: {
    label: "All",
    activeClasses: "bg-slate-800 text-white border-slate-800",
    dotClasses: "",
  },
  Pending: {
    label: "Pending",
    activeClasses: "bg-yellow-500 text-white border-yellow-500",
    dotClasses: "bg-yellow-500",
  },
  Active: {
    label: "Active",
    activeClasses: "bg-brand-600 text-white border-brand-600",
    dotClasses: "bg-brand-500",
  },
  Completed: {
    label: "Completed",
    activeClasses: "bg-blue-600 text-white border-blue-600",
    dotClasses: "bg-blue-500",
  },
  Cancelled: {
    label: "Cancelled",
    activeClasses: "bg-red-500 text-white border-red-500",
    dotClasses: "bg-red-400",
  },
  Closed: {
    label: "Closed",
    activeClasses: "bg-slate-500 text-white border-slate-500",
    dotClasses: "bg-slate-400",
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface CircleStatusFilterProps {
  /** The currently active status filter, or `undefined` for "All". */
  activeStatus: StatusFilter | undefined;
}

/**
 * A row of filter pills that updates `?status=` in the URL when clicked.
 *
 * Navigation is performed via the Next.js router so the server re-renders the
 * circles list with the correct filter applied — no client-side filtering of a
 * stale dataset.  `useTransition` keeps the current list visible during the
 * navigation and drives the pending indicator.
 *
 * The "All" pill removes the query param entirely; every other pill sets it to
 * the corresponding status value.  The selected pill is announced to screen
 * readers via `aria-pressed` on each button.
 */
export function CircleStatusFilter({ activeStatus }: CircleStatusFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  function handleSelect(status: StatusFilter | undefined) {
    startTransition(() => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      // Preserve the circles anchor so the list stays in view after filtering.
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}#circles`, { scroll: false });
    });
  }

  const allOptions: Array<StatusFilter | undefined> = [undefined, ...CIRCLE_STATUS_OPTIONS];

  return (
    <div
      role="group"
      aria-label="Filter circles by status"
      className={clsx(
        "flex flex-wrap gap-2",
        isPending && "opacity-60 pointer-events-none",
      )}
    >
      {allOptions.map((status) => {
        const key = status ?? "All";
        const ui = STATUS_UI[key];
        const isActive = status === activeStatus;

        return (
          <button
            key={key}
            type="button"
            onClick={() => handleSelect(status)}
            aria-pressed={isActive}
            className={clsx(
              // Base geometry shared by every pill
              "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium",
              "border transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
              isActive
                ? ui.activeClasses
                : "bg-white text-slate-600 border-slate-200 hover:border-slate-400 hover:text-slate-800",
            )}
          >
            {/* Coloured dot — only shown for named-status pills, not "All" */}
            {status && (
              <span
                className={clsx(
                  "h-1.5 w-1.5 rounded-full flex-shrink-0",
                  isActive ? "bg-white/80" : ui.dotClasses,
                )}
                aria-hidden="true"
              />
            )}
            {ui.label}
          </button>
        );
      })}

      {/* Pending spinner — shown during the router transition */}
      {isPending && (
        <span
          className="inline-flex items-center ml-1 text-slate-400 text-xs"
          aria-live="polite"
          aria-label="Loading filtered circles…"
        >
          <span
            className="h-3.5 w-3.5 rounded-full border-2 border-slate-400 border-t-transparent animate-spin mr-1"
            aria-hidden="true"
          />
          Loading…
        </span>
      )}
    </div>
  );
}
