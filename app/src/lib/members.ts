// ─── Circle member rows from the indexer ──────────────────────────────────────
//
// Shared by the server page (initial render) and CircleDetailClient (refresh),
// so both paths agree on when member data counts as "unavailable". This lives
// in lib/ rather than in CircleDetailClient.tsx because a server component
// cannot call functions exported from a "use client" module.

import type { CircleMember } from "@/app/circles/[address]/CircleDetailClient";
import { isStellarPublicKey } from "./address";

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function toCount(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return isNonNegativeInteger(n) ? n : 0;
}

/**
 * Validate the `members` field of an indexer `/circles/:address` response.
 *
 * The rotation view treats a member's array index as its payout position, so
 * a partially usable list is worse than none: silently dropping one bad row
 * would shift every later member into the wrong slot and mark the wrong
 * person as "next payout". The list is therefore all-or-nothing. It returns
 * `[]`, which the UI renders as the "member data unavailable" fallback, when:
 *
 *   • the field is missing or not an array (indexer still catching up);
 *   • any row lacks a well-formed G-address or a non-negative integer
 *     `payout_order`;
 *   • two rows share an address or a payout position.
 *
 * Display-only fields (`defaults`, `reputation_score`, `total_contributions`,
 * `collateral`, `joined_at`) are coerced to safe defaults instead, so one
 * missing score never hides the whole rotation. Rows come back sorted by
 * `payout_order`, whatever order the indexer returned them in.
 */
export function parseMemberRows(raw: unknown): CircleMember[] {
  if (!Array.isArray(raw)) return [];

  const members: CircleMember[] = [];
  const addresses = new Set<string>();
  const positions = new Set<number>();

  for (const row of raw) {
    if (typeof row !== "object" || row === null) return [];
    const r = row as Record<string, unknown>;

    const address = typeof r.member_address === "string" ? r.member_address.trim() : "";
    if (!isStellarPublicKey(address) || addresses.has(address)) return [];
    if (!isNonNegativeInteger(r.payout_order) || positions.has(r.payout_order)) return [];
    addresses.add(address);
    positions.add(r.payout_order);

    members.push({
      member_address: address,
      payout_order: r.payout_order,
      collateral:
        typeof r.collateral === "string" || typeof r.collateral === "number"
          ? String(r.collateral)
          : "0",
      defaults: toCount(r.defaults),
      joined_at: typeof r.joined_at === "string" ? r.joined_at : null,
      reputation_score: toCount(r.reputation_score),
      total_contributions: toCount(r.total_contributions),
    });
  }

  return members.sort((a, b) => a.payout_order - b.payout_order);
}
