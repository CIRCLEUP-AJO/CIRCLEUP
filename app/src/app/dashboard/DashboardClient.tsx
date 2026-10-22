"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  fetchMemberDashboard,
  type DashboardCircle,
  type DashboardErrorReason,
} from "@/lib/dashboard";
import { getWalletAddress } from "@/lib/stellar";
import { isCanonicalStellarAddress } from "@/lib/address";
import { shortAddress, formatUsdc, getExplorerLink, ACTIVE_NETWORK } from "@/lib/config";
import { getCircleStatusMeta } from "@/lib/circleStatus";
import { ReputationBadge } from "@/components/ReputationBadge";

// ─── Error messages ───────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<DashboardErrorReason, string> = {
  invalid_address:
    "The wallet address is not a valid Stellar address. Reconnect your wallet.",
  network:
    "Could not reach the indexer. Check your connection and refresh.",
  server:
    "The indexer returned an error. Try again in a moment.",
  indexer_outage:
    "The indexer is temporarily unavailable. Data may be delayed.",
  parse:
    "The indexer returned an unexpected response format.",
  misconfigured:
    "The indexer URL is not configured. Contact support.",
};

// ─── Wallet states ────────────────────────────────────────────────────────────

type WalletState =
  | "loading"
  | "not_installed"
  | "disconnected"
  | "connected";

// ─── Circle card ──────────────────────────────────────────────────────────────

function DashboardCircleCard({ item }: { item: DashboardCircle }) {
  const { circle, participation } = item;
  const status = getCircleStatusMeta(circle.status);

  const roundLabel =
    circle.total_rounds > 0
      ? `Round ${circle.current_round} / ${circle.total_rounds}`
      : "No rounds yet";

  const contributionDisplay = (() => {
    try {
      const n = BigInt(circle.round_amount || "0");
      return `$${formatUsdc(n)} / round`;
    } catch {
      return "—";
    }
  })();

  return (
    <Link
      href={`/circles/${circle.address}`}
      className="block bg-white border border-slate-200 rounded-xl p-4 hover:border-brand-300 hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      aria-label={`Circle ${shortAddress(circle.address)}, ${status.label}, ${roundLabel}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <p
          className="font-mono text-xs text-slate-500 truncate"
          title={circle.address}
        >
          {shortAddress(circle.address)}
        </p>
        <span
          className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${status.chipClasses}`}
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${status.dotClasses}`}
            aria-hidden="true"
          />
          {status.label}
        </span>
      </div>

      {/* Stats grid */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-slate-400">Progress</dt>
          <dd className="font-medium text-slate-700">{roundLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">Contribution</dt>
          <dd className="font-medium text-slate-700">{contributionDisplay}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">Members</dt>
          <dd className="font-medium text-slate-700">{circle.member_count}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">My contributions</dt>
          <dd className="font-medium text-slate-700">
            {participation.totalContributions}
          </dd>
        </div>
      </dl>

      {/* Participation indicators */}
      <div className="flex items-center gap-3 mt-3 pt-3 border-t border-slate-100">
        <ReputationBadge score={participation.reputationScore} size="sm" />
        {participation.defaults > 0 && (
          <span className="text-xs text-red-600 font-medium">
            ⚠ {participation.defaults} default{participation.defaults !== 1 ? "s" : ""}
          </span>
        )}
        {participation.hasLockedCollateral && (
          <span className="text-xs text-green-700">✓ Collateral locked</span>
        )}
      </div>
    </Link>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyDashboard({ address }: { address: string }) {
  return (
    <div className="text-center py-12 text-slate-500">
      <p className="text-lg mb-1">No circles found</p>
      <p className="text-sm mb-4">
        No circles are associated with{" "}
        <span className="font-mono">{shortAddress(address)}</span> in the
        indexer yet. If you recently joined a circle, data may take a moment
        to appear.
      </p>
      <Link
        href="/"
        className="text-sm text-brand-600 underline hover:text-brand-800"
      >
        Browse all circles
      </Link>
    </div>
  );
}

// ─── DashboardClient ──────────────────────────────────────────────────────────

export function DashboardClient() {
  const [walletState, setWalletState] = useState<WalletState>("loading");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  const [circles, setCircles] = useState<DashboardCircle[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the address we last fetched so we clear results on wallet change
  const lastFetchedAddress = useRef<string | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  // ── Wallet resolution ────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    getWalletAddress()
      .then((addr) => {
        if (cancelled) return;
        if (addr && isCanonicalStellarAddress(addr)) {
          setWalletAddress(addr);
          setWalletState("connected");
        } else {
          setWalletState("disconnected");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setWalletState("not_installed");
      });
    return () => { cancelled = true; };
  }, []);

  // ── Account change listener ──────────────────────────────────────────────

  useEffect(() => {
    const provider =
      typeof window !== "undefined"
        ? ((window as unknown as Record<string, unknown>).freighter ??
           (window as unknown as Record<string, unknown>).freighterApi)
        : null;

    if (!provider || typeof (provider as { addEventListener?: unknown }).addEventListener !== "function") {
      return;
    }

    const p = provider as { addEventListener: (e: string, cb: () => void) => void; removeEventListener: (e: string, cb: () => void) => void };

    const handleChange = () => {
      // Clear previous member's data immediately to prevent stale display
      setCircles([]);
      setFetchedAt(null);
      setError(null);
      lastFetchedAddress.current = null;
      setWalletState("loading");
      setWalletAddress(null);

      getWalletAddress()
        .then((addr) => {
          if (addr && isCanonicalStellarAddress(addr)) {
            setWalletAddress(addr);
            setWalletState("connected");
          } else {
            setWalletState("disconnected");
          }
        })
        .catch(() => setWalletState("not_installed"));
    };

    p.addEventListener("accountChanged", handleChange);
    p.addEventListener("networkChanged", handleChange);
    return () => {
      p.removeEventListener("accountChanged", handleChange);
      p.removeEventListener("networkChanged", handleChange);
    };
  }, []);

  // ── Data fetch ───────────────────────────────────────────────────────────

  const fetchData = useCallback(
    async (address: string, targetPage: number) => {
      if (!isCanonicalStellarAddress(address)) return;

      // Clear stale data when address changes
      if (lastFetchedAddress.current !== address) {
        setCircles([]);
        setFetchedAt(null);
        setError(null);
      }

      fetchAbortRef.current?.abort();
      const ctrl = new AbortController();
      fetchAbortRef.current = ctrl;

      setIsLoading(true);
      setError(null);

      const result = await fetchMemberDashboard(address, {
        page: targetPage,
        signal: ctrl.signal,
      });

      if (ctrl.signal.aborted) return;

      setIsLoading(false);

      if (result.ok) {
        lastFetchedAddress.current = address;
        setCircles(result.data.circles);
        setTotal(result.data.total);
        setPage(result.data.page);
        setTotalPages(result.data.totalPages);
        setFetchedAt(result.data.fetchedAt);
      } else {
        setError(ERROR_MESSAGES[result.reason] ?? "An unexpected error occurred.");
      }
    },
    [],
  );

  useEffect(() => {
    if (walletState === "connected" && walletAddress) {
      fetchData(walletAddress, 1);
    }
    return () => { fetchAbortRef.current?.abort(); };
  }, [walletState, walletAddress, fetchData]);

  // ── Render ───────────────────────────────────────────────────────────────

  // Wallet not yet checked
  if (walletState === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-sm text-slate-400 py-8 justify-center"
      >
        <span
          className="inline-block w-4 h-4 border-2 border-slate-200 border-t-brand-500 rounded-full animate-spin"
          aria-hidden="true"
        />
        Checking wallet…
      </div>
    );
  }

  if (walletState === "not_installed") {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
        <p className="font-semibold mb-1">Freighter not installed</p>
        <p>
          Install the{" "}
          <a
            href="https://freighter.app"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-amber-900"
          >
            Freighter wallet
          </a>{" "}
          to view your circles.
        </p>
      </div>
    );
  }

  if (walletState === "disconnected") {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 text-sm text-blue-800">
        <p className="font-semibold mb-1">Connect your wallet</p>
        <p>
          Use the <strong>Connect Wallet</strong> button in the top-right corner
          to view circles associated with your address.
        </p>
        <p className="mt-2 text-xs text-blue-600">
          Your address is used only for this session and is not stored by the app.
        </p>
      </div>
    );
  }

  // Connected
  return (
    <div className="space-y-5">
      {/* Identity strip */}
      <div className="flex items-center justify-between text-sm">
        <p className="text-slate-500">
          Showing circles for{" "}
          <span
            className="font-mono text-slate-700"
            title={walletAddress ?? ""}
          >
            {walletAddress ? shortAddress(walletAddress) : "—"}
          </span>
        </p>
        {fetchedAt && (
          <span
            className="text-xs text-slate-400"
            title="Data is sourced from the indexer and may lag the chain."
          >
            Indexed · {new Date(fetchedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex items-start gap-2"
        >
          <span aria-hidden="true">⚠</span>
          <div>
            <p>{error}</p>
            <button
              onClick={() => walletAddress && fetchData(walletAddress, page)}
              className="mt-1.5 text-xs underline font-medium hover:text-red-900"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <div
          role="status"
          aria-live="polite"
          aria-label="Loading your circles"
          className="grid grid-cols-1 sm:grid-cols-2 gap-4"
        >
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="bg-slate-100 rounded-xl h-36 animate-pulse"
              aria-hidden="true"
            />
          ))}
        </div>
      )}

      {/* Results */}
      {!isLoading && !error && circles.length === 0 && walletAddress && (
        <EmptyDashboard address={walletAddress} />
      )}

      {!isLoading && circles.length > 0 && (
        <>
          <p className="text-xs text-slate-400">
            {total} circle{total !== 1 ? "s" : ""} found
          </p>
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-4"
            aria-label="Your circles"
          >
            {circles.map((item) => (
              <DashboardCircleCard key={item.circle.address} item={item} />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-slate-500 pt-2">
              <span>
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                {page > 1 && (
                  <button
                    onClick={() => walletAddress && fetchData(walletAddress, page - 1)}
                    disabled={isLoading}
                    className="px-3 py-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  >
                    Previous
                  </button>
                )}
                {page < totalPages && (
                  <button
                    onClick={() => walletAddress && fetchData(walletAddress, page + 1)}
                    disabled={isLoading}
                    className="px-3 py-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  >
                    Next
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Freshness advisory */}
      <p className="text-xs text-slate-400 border-t border-slate-100 pt-3" role="note">
        ℹ️ Circle data is sourced from the indexer and may lag the chain by one
        or more ledgers. Switching or disconnecting wallets clears this view
        immediately.
      </p>
    </div>
  );
}
