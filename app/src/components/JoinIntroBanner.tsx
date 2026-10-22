"use client";

import type { JoinIntroContent, WalletPrerequisite } from "@/lib/joinIntro";

// ─── Visual config per variant ────────────────────────────────────────────────

const VARIANT_STYLES: Record<
  string,
  { wrapper: string; icon: string; headingColor: string }
> = {
  pending_open: {
    wrapper: "bg-brand-50 border-brand-200",
    icon: "🔓",
    headingColor: "text-brand-800",
  },
  pending_joined: {
    wrapper: "bg-green-50 border-green-200",
    icon: "✅",
    headingColor: "text-green-800",
  },
  pending_full: {
    wrapper: "bg-amber-50 border-amber-200",
    icon: "🔒",
    headingColor: "text-amber-800",
  },
  active: {
    wrapper: "bg-slate-50 border-slate-200",
    icon: "▶️",
    headingColor: "text-slate-700",
  },
  completed: {
    wrapper: "bg-green-50 border-green-200",
    icon: "🏁",
    headingColor: "text-green-800",
  },
  cancelled: {
    wrapper: "bg-red-50 border-red-200",
    icon: "✖️",
    headingColor: "text-red-800",
  },
  closed: {
    wrapper: "bg-slate-50 border-slate-200",
    icon: "🔐",
    headingColor: "text-slate-700",
  },
  unknown: {
    wrapper: "bg-slate-50 border-slate-200",
    icon: "❓",
    headingColor: "text-slate-700",
  },
};

const DEFAULT_STYLE = VARIANT_STYLES.unknown;

// ─── Prerequisite row ─────────────────────────────────────────────────────────

function PrerequisiteRow({ prereq }: { prereq: WalletPrerequisite }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        className={prereq.met ? "text-green-600 mt-0.5" : "text-slate-400 mt-0.5"}
        aria-hidden="true"
      >
        {prereq.met ? "✓" : "○"}
      </span>
      <span className={prereq.met ? "text-slate-700" : "text-slate-500"}>
        <span className={prereq.met ? "font-medium" : ""}>{prereq.label}</span>
        {!prereq.met && (
          <>
            {" — "}
            {prereq.setupUrl ? (
              <a
                href={prereq.setupUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-brand-700"
              >
                {prereq.guidance}
              </a>
            ) : (
              <span>{prereq.guidance}</span>
            )}
          </>
        )}
      </span>
    </li>
  );
}

// ─── JoinIntroBanner ──────────────────────────────────────────────────────────

export interface JoinIntroBannerProps {
  content: JoinIntroContent;
}

/**
 * Advisory panel that explains the circle's current join status, required
 * collateral, and wallet prerequisites before a user clicks Join.
 *
 * This component is purely informational. The actual Join action remains in
 * CircleDetailClient's existing gating + doAction flow.
 */
export function JoinIntroBanner({ content }: JoinIntroBannerProps) {
  const style = VARIANT_STYLES[content.variant] ?? DEFAULT_STYLE;

  return (
    <section
      aria-label="Join information"
      className={`border rounded-xl p-4 flex gap-3 items-start ${style.wrapper}`}
    >
      <span className="text-xl mt-0.5 shrink-0" aria-hidden="true">
        {style.icon}
      </span>
      <div className="flex-1 min-w-0 space-y-2">
        <h2 className={`font-semibold text-sm ${style.headingColor}`}>
          {content.heading}
        </h2>

        <p className="text-sm text-slate-700">{content.body}</p>

        {/* Prerequisites — only shown when joining is available */}
        {content.joinAvailable && content.prerequisites.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1.5">
              Prerequisites
            </p>
            <ul className="space-y-1" aria-label="Join prerequisites">
              {content.prerequisites.map((p) => (
                <PrerequisiteRow key={p.label} prereq={p} />
              ))}
            </ul>
          </div>
        )}

        {/* Advisory note — always shown */}
        <p
          className="text-xs text-slate-400 border-t border-slate-200 pt-2 mt-2"
          role="note"
          aria-label="Data source advisory"
        >
          ℹ️ {content.guaranteeNote}
        </p>
      </div>
    </section>
  );
}
