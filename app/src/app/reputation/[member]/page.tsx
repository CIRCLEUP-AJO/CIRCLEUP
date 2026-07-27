"use client";

import { useState, useEffect, useCallback } from "react";
import { INDEXER_URL, shortAddress } from "@/lib/config";
import { ReputationBadge, ReputationLegend } from "@/components/ReputationBadge";

// ─── Local type definition ────────────────────────────────────────────────────
//
// The app package does not depend on @circleup/sdk directly; types that mirror
// indexer API shapes are declared here. Keep in sync with:
//   sdk/src/types.ts → ApiReputationResponse

/** @see ApiReputationResponse in sdk/src/types.ts */
interface ReputationResponse {
  member: string;
  /** true when a reputation row exists; false means no activity recorded yet. */
  found: boolean;
  score: number;
  contributions: Array<{
    circle_address: string;
    contributions: number;
    total_rounds: number;
  }>;
  defaults: Array<{
    circle_address: string;
    count: number;
  }>;
  updatedAt: string | null;
}

// ─── Data fetching ────────────────────────────────────────────────────────────

// Three distinct outcomes for the fetch so the UI can show the right message:
//   "outage"    — network error or non-2xx/404 response (indexer down / misconfigured)
//   "not_found" — 404 or the indexer returned found:false with no activity
//   data        — a valid ReputationResponse

type FetchOutcome =
  | { kind: "outage"; detail: string }
  | { kind: "not_found" }
  | { kind: "ok"; data: ReputationResponse };

async function fetchReputation(member: string): Promise<FetchOutcome> {
  try {
    const res = await fetch(`${INDEXER_URL}/reputation/${member}`, {
      // Always fetch fresh data — the user can also trigger a manual refresh.
      cache: "no-store",
    });
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) {
      return {
        kind: "outage",
        detail: `Indexer returned HTTP ${res.status}. Check that the indexer service is running and NEXT_PUBLIC_INDEXER_URL is correct.`,
      };
    }
    const data = (await res.json()) as ReputationResponse;
    return { kind: "ok", data };
  } catch (err) {
    return {
      kind: "outage",
      detail:
        "Could not reach the indexer. Check that the service is running and your network connection is stable.",
    };
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReputationPage({
  params,
}: {
  params: { member: string };
}) {
  const { member } = params;

  // undefined  = initial loading
  // FetchOutcome = settled (ok, not_found, or outage)
  const [outcome, setOutcome] = useState<FetchOutcome | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(
    async (isManual = false) => {
      if (isManual) setRefreshing(true);
      const result = await fetchReputation(member);
      setOutcome(result);
      setLastRefreshed(new Date());
      if (isManual) setRefreshing(false);
    },
    [member],
  );

  // Initial fetch on mount
  useEffect(() => {
    load();
  }, [load]);

  // ── Loading state ────────────────────────────────────────────────────────────

  if (outcome === undefined) {
    return (
      <div
        className="text-center py-16 text-slate-500"
        role="status"
        aria-label="Loading reputation data"
      >
        <div
          className="inline-block w-8 h-8 border-4 border-slate-200 border-t-brand-600 rounded-full animate-spin mb-4"
          aria-hidden="true"
        />
        <p className="text-sm">Loading reputation…</p>
      </div>
    );
  }

  // ── Indexer outage ───────────────────────────────────────────────────────────

  if (outcome.kind === "outage") {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reputation</h1>
          <p className="font-mono text-sm text-slate-500 mt-1 break-all" aria-label={`Member address: ${member}`}>
            {member}
          </p>
        </div>
        <div
          role="alert"
          className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-6 flex items-start gap-3"
        >
          <span className="text-2xl mt-0.5" aria-hidden="true">⚠️</span>
          <div>
            <p className="font-semibold text-amber-800">Indexer unreachable</p>
            <p className="text-amber-700 text-sm mt-1">{outcome.detail}</p>
          </div>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="text-sm text-brand-600 hover:underline disabled:opacity-50"
        >
          {refreshing ? "Retrying…" : "Try again"}
        </button>
      </div>
    );
  }

  // ── Not found ────────────────────────────────────────────────────────────────

  if (outcome.kind === "not_found") {
    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-4xl mb-3" aria-hidden="true">
          🔍
        </div>
        <p>No reputation data found for this member.</p>
        <p className="text-sm text-slate-400 mt-1">
          This address may not have participated in any circle yet.
        </p>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="mt-4 text-sm text-brand-600 hover:underline disabled:opacity-50"
        >
          {refreshing ? "Retrying…" : "Try again"}
        </button>
      </div>
    );
  }

  // ── Loaded ───────────────────────────────────────────────────────────────────

  const data = outcome.data;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reputation</h1>
          <p
            className="font-mono text-sm text-slate-500 mt-1 break-all"
            aria-label={`Member address: ${member}`}
          >
            {member}
          </p>
        </div>

        {/* Deliberate refresh button — #12 */}
        <div className="shrink-0 text-right">
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            aria-label="Refresh reputation data"
            className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-800 disabled:opacity-50 transition-colors"
          >
            <span
              aria-hidden="true"
              className={refreshing ? "animate-spin inline-block" : "inline-block"}
            >
              🔄
            </span>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {lastRefreshed && (
            <p className="text-xs text-slate-400 mt-0.5">
              Updated{" "}
              {lastRefreshed.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </p>
          )}
        </div>
      </div>

      {/* Score card */}
      <div
        className="bg-white rounded-xl border border-slate-200 p-6 text-center"
        aria-label={`Reputation score: ${data.score}`}
      >
        <ReputationBadge score={data.score} size="lg" />
        <p className="text-3xl font-bold text-slate-900 mt-3">{data.score}</p>
        <p className="text-slate-500 text-sm">completed rounds</p>
        {!data.found && (
          <p className="text-xs text-slate-400 mt-2 italic">
            No on-chain activity recorded yet.
          </p>
        )}
      </div>

      {/* Circle participation */}
      {data.contributions.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="font-semibold text-slate-800 mb-3">
            Circle participation
          </h2>
          <div
            className="space-y-2"
            role="list"
            aria-label="Circles this member has participated in"
          >
            {data.contributions.map((c) => (
              <div
                key={c.circle_address}
                role="listitem"
                className="flex items-center justify-between text-sm"
              >
                <span
                  className="font-mono text-slate-600 text-xs"
                  title={c.circle_address}
                  aria-label={`Circle ${c.circle_address}`}
                >
                  {shortAddress(c.circle_address)}
                </span>
                <span className="text-slate-500">
                  <span aria-label={`${c.contributions} of ${c.total_rounds} rounds contributed`}>
                    {c.contributions} / {c.total_rounds} rounds
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Defaults */}
      {data.defaults.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5">
          <h2 className="font-semibold text-red-800 mb-3">Defaults</h2>
          <div
            className="space-y-2"
            role="list"
            aria-label="Circles where this member has defaulted"
          >
            {data.defaults.map((d) => (
              <div
                key={d.circle_address}
                role="listitem"
                className="flex items-center justify-between text-sm"
              >
                <span
                  className="font-mono text-slate-600 text-xs"
                  title={d.circle_address}
                  aria-label={`Circle ${d.circle_address}`}
                >
                  {shortAddress(d.circle_address)}
                </span>
                <span
                  className="text-red-700 font-medium"
                  aria-label={`${d.count} default${d.count !== 1 ? "s" : ""}`}
                >
                  {d.count} default{d.count !== 1 ? "s" : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Badge legend — #10 */}
      <ReputationLegend />
    </div>
  );
}
