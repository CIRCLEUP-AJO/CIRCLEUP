"use client";

// ─── MemberListFallback ────────────────────────────────────────────────────────
//
// Rendered inside the Rotation Order card when the indexer returned no usable
// member rows (see parseMemberRows). The indexer writes member rows when the
// circle is created, so an empty list always means "not available", never
// "nobody has joined". One muted placeholder row per expected member keeps
// the card the same height it will have once the rows arrive, and nothing
// here names an address, a payout position, or a contribution status that
// could be mistaken for real data.

/** Upper bound on placeholder rows, whatever member_count the indexer reports. */
const MAX_PLACEHOLDER_ROWS = 20;

export function MemberListFallback({ memberCount }: { memberCount: number }) {
  const rows =
    Number.isInteger(memberCount) && memberCount > 0
      ? Math.min(memberCount, MAX_PLACEHOLDER_ROWS)
      : 0;

  return (
    <div>
      <p role="status" className="text-sm text-slate-600 mb-3">
        Member details are not available right now, so the rotation order
        can&apos;t be shown yet.{" "}
        {rows > 0
          ? `This circle has ${memberCount} member${memberCount === 1 ? "" : "s"}; `
          : ""}
        they will appear here once the indexer has them.
      </p>
      {rows > 0 && (
        <ol className="space-y-2" aria-hidden="true">
          {Array.from({ length: rows }, (_, i) => (
            <li
              key={i}
              className="flex items-center gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-lg border border-dashed border-slate-200"
            >
              <span className="text-slate-300 text-sm w-5 shrink-0 text-right">
                {i + 1}
              </span>
              <span className="text-xs text-slate-400">Member details unavailable</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
