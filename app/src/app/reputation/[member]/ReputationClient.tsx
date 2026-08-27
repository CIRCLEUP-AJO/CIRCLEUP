"use client";

import { useState, useEffect, useCallback } from "react";
import { INDEXER_URL, shortAddress } from "@/lib/config";
import { ReputationBadge, ReputationLegend } from "@/components/ReputationBadge";
import { isCanonicalStellarAddress } from "@/lib/address";

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

type FetchResult =
  | { ok: true; data: ReputationResponse }
  | { ok: false; reason: "not_found" | "network" | "unknown" | "aborted" };

async function fetchReputation(member: string, signal?: AbortSignal): Promise<FetchResult> {
  // Validate the route param before making any network request. A malformed
  // address (e.g. from a manually typed URL) would otherwise reach the indexer
  // and return a 404 that looks indistinguishable from "no activity yet".
  if (!isCanonicalStellarAddress(member)) {
    return { ok: false, reason: "not_found" };
  }
  try {
    const res = await fetch(`${INDEXER_URL}/reputation/${member}`, {
      cache: "no-store",
      signal,
    });
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (!res.ok) return { ok: false, reason: "unknown" };
    return { ok: true, data: (await res.json()) as ReputationResponse };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, reason: "aborted" };
    }
    return { ok: false, reason: "network" };
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReputationClient({ member }: { member: string }) {
  const [result, setResult] = useState<FetchResult | undefined>(
    // undefined = loading
    undefined,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(
    async (isManual = false, signal?: AbortSignal) => {
      if (isManual) setRefreshing(true);
      const fetched = await fetchReputation(member, signal);
      if (signal?.aborted) return;
      setResult(fetched);
      setLastRefreshed(new Date());
      if (isManual) setRefreshing(false);
    },
    [member],
  );

  // Initial fetch on mount; cancel on unmount or member change
  useEffect(() => {
    const controller = new AbortController();
    load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  // ── Loading state ────────────────────────────────────────────────────────────

  if (result === undefined) {
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

  // ── Error states ─────────────────────────────────────────────────────────────

  if (!result.ok) {
    // Aborted fetches (navigation away then back) should not show error UI
    if (result.reason === "aborted") return null;

    if (result.reason === "not_found") {
      return (
        <div className="text-center py-16 text-slate-500">
          <div className="text-4xl mb-3" aria-hidden="true">🔍</div>
          <p className="font-medium text-slate-800">No reputation record found.</p>
          <p className="text-sm mt-1 text-slate-500">
            This address has no on-chain activity in CircleUp yet.
          </p>
          <p className="font-mono text-xs text-slate-400 mt-2 break-all max-w-xs mx-auto">
            {member}
          </p>
        </div>
      );
    }

    const errorMessages: Record<string, string> = {
      network: "The reputation service is unreachable. Check your connection and try again.",
      unknown: "An unexpected error occurred loading reputation data.",
    };

    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-4xl mb-3" aria-hidden="true">⚠️</div>
        <p className="font-medium text-slate-800">Could not load reputation</p>
        <p className="text-sm mt-1 text-slate-500">
          {errorMessages[result.reason] ?? errorMessages.unknown}
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

  const { data } = result;

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

        {/* Refresh button */}
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

      {/* Reputation badge legend */}
      <ReputationLegend />
    </div>
  );
}
