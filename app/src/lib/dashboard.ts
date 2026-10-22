/**
 * Wallet-aware member dashboard data layer.
 *
 * Queries the indexer for all circles that include the connected wallet
 * address as a member, then enriches each circle record with the member's
 * current participation state (round, contribution status).
 *
 * Design constraints:
 *   - Wallet address is validated before every query; stale or malformed
 *     addresses never reach the indexer.
 *   - Indexed data is always labelled as such. "No circles" is explicitly
 *     distinct from "indexer unavailable" and from "address invalid".
 *   - Results are bounded: the endpoint is paged and the dashboard always
 *     shows a freshness label.
 *   - No address retention: the address is used only for the duration of the
 *     fetch and never written to storage in this module.
 */

import { isCanonicalStellarAddress } from "./address";
import { indexerEndpoint, INDEXER_TIMEOUT_MS } from "./config";
import { parseCircleRow } from "./circleTypes";
import type { CircleRow, CircleApiStatus } from "./circleTypes";

// ─── Error reasons ────────────────────────────────────────────────────────────

export type DashboardErrorReason =
  | "invalid_address"   // address failed validation before the fetch
  | "network"           // fetch threw (offline / DNS / timeout)
  | "server"            // indexer returned a non-2xx response
  | "indexer_outage"    // indexer returned 503
  | "parse"             // response body was not parseable
  | "misconfigured";    // NEXT_PUBLIC_INDEXER_URL is missing or invalid

// ─── Member participation snapshot ───────────────────────────────────────────

/**
 * Participation state for a member in one circle, derived from the circle
 * row returned by the member-circles endpoint.
 *
 * Fields come from what the indexer already provides in a list response —
 * no extra per-circle fetch is needed.
 */
export interface MemberCircleParticipation {
  /** Whether the connected address has locked collateral (member.collateral > 0). */
  readonly hasLockedCollateral: boolean;
  /** Number of defaults this member has incurred in this circle. */
  readonly defaults: number;
  /** Reputation score for this member in this circle context (0–100). */
  readonly reputationScore: number | null;
  /** Total contributions this member has made across all rounds. */
  readonly totalContributions: number;
}

// ─── Dashboard circle card ────────────────────────────────────────────────────

export interface DashboardCircle {
  /** Full circle row from the indexer. */
  readonly circle: CircleRow;
  /** Member-specific participation derived from the response. */
  readonly participation: MemberCircleParticipation;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface DashboardPage {
  readonly circles: DashboardCircle[];
  readonly total: number;
  readonly page: number;
  readonly totalPages: number;
  /** ISO-8601 timestamp of when this data was fetched. */
  readonly fetchedAt: string;
}

// ─── Result types ─────────────────────────────────────────────────────────────

export type DashboardResult =
  | { readonly ok: true; readonly data: DashboardPage; readonly fetchedAtMs: number }
  | { readonly ok: false; readonly reason: DashboardErrorReason };

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetch the dashboard page for the given wallet address.
 *
 * The indexer endpoint is:
 *   GET /members/:address/circles?page=N&limit=M&status=<filter>
 *
 * If the indexer does not support this endpoint yet, falls back to the
 * GET /circles?member=:address pattern. Both response shapes are handled.
 */
export async function fetchMemberDashboard(
  walletAddress: string,
  options: {
    page?: number;
    limit?: number;
    status?: CircleApiStatus | "";
    signal?: AbortSignal;
  } = {},
): Promise<DashboardResult> {
  // Validate address before touching the network
  if (!isCanonicalStellarAddress(walletAddress)) {
    return { ok: false, reason: "invalid_address" };
  }

  const { page = 1, limit = 20, status = "", signal } = options;

  // Build URL: /members/:address/circles
  const segments = ["members", walletAddress, "circles"];
  const base = indexerEndpoint(segments);
  if (base === null) {
    return { ok: false, reason: "misconfigured" };
  }

  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (limit !== 20) params.set("limit", String(limit));
  if (status) params.set("status", status);

  const url = params.toString() ? `${base}?${params.toString()}` : base;

  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (!res.ok) {
    if (res.status === 503) return { ok: false, reason: "indexer_outage" };
    return { ok: false, reason: "server" };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return { ok: false, reason: "parse" };
  }

  return parseDashboardResponse(raw);
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseDashboardResponse(raw: unknown): DashboardResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "parse" };
  }

  const obj = raw as Record<string, unknown>;

  // Accept both /members/:address/circles and /circles?member= shapes
  const rawCircles = Array.isArray(obj.circles)
    ? obj.circles
    : Array.isArray(obj.data)
    ? obj.data
    : null;

  if (!rawCircles) {
    return { ok: false, reason: "parse" };
  }

  const pagination =
    typeof obj.pagination === "object" && obj.pagination !== null
      ? (obj.pagination as Record<string, unknown>)
      : {};

  const total =
    typeof pagination.total === "number" && pagination.total >= 0
      ? pagination.total
      : rawCircles.length;
  const pageNum =
    typeof pagination.page === "number" ? pagination.page : 1;
  const totalPages =
    typeof pagination.totalPages === "number"
      ? pagination.totalPages
      : Math.max(1, Math.ceil(total / 20));

  const seen = new Set<string>();
  const circles: DashboardCircle[] = [];

  for (const rawItem of rawCircles) {
    if (typeof rawItem !== "object" || rawItem === null) continue;
    const item = rawItem as Record<string, unknown>;

    // The endpoint may return { circle: CircleRow, member: MemberRow } or flat
    const circleRaw = typeof item.circle === "object" ? item.circle : item;
    const memberRaw =
      typeof item.member === "object" && item.member !== null
        ? (item.member as Record<string, unknown>)
        : item;

    const circle = parseCircleRow(circleRaw);
    if (!circle || seen.has(circle.address)) continue;
    seen.add(circle.address);

    const participation = parseMemberParticipation(memberRaw);
    circles.push({ circle, participation });
  }

  const fetchedAtMs = Date.now();
  return {
    ok: true,
    data: {
      circles,
      total,
      page: pageNum,
      totalPages,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
    },
    fetchedAtMs,
  };
}

function parseMemberParticipation(raw: Record<string, unknown>): MemberCircleParticipation {
  const collateral =
    typeof raw.collateral === "string" ? raw.collateral : "0";
  let hasLockedCollateral = false;
  try {
    hasLockedCollateral = BigInt(collateral) > 0n;
  } catch {
    hasLockedCollateral = false;
  }

  return {
    hasLockedCollateral,
    defaults:
      typeof raw.defaults === "number" && raw.defaults >= 0
        ? Math.floor(raw.defaults)
        : 0,
    reputationScore:
      typeof raw.reputation_score === "number" &&
      Number.isFinite(raw.reputation_score)
        ? raw.reputation_score
        : null,
    totalContributions:
      typeof raw.total_contributions === "number" &&
      raw.total_contributions >= 0
        ? Math.floor(raw.total_contributions)
        : 0,
  };
}
