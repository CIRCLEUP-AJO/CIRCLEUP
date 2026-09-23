"use client";

import { useState, useTransition, Suspense, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// ─── Types ────────────────────────────────────────────────────────────────────

type FetchError = "network" | "parse" | "server" | "misconfigured";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of client-initiated retries before the component enters the
 * "exhausted" state and stops offering the retry button. This prevents an
 * infinite loop hammering a persistently broken endpoint.
 */
export const MAX_RETRIES = 3;

/**
 * Delay (ms) before the first auto-retry fires after a transient error.
 * Only applied for `network` errors where a brief wait may resolve connectivity.
 */
const AUTO_RETRY_DELAY_MS = 3_000;

// ─── Error messages ────────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<FetchError, { title: string; body: string; retryable: boolean }> = {
  misconfigured: {
    title: "Circles list not configured",
    body:
      "NEXT_PUBLIC_INDEXER_URL is not set or is not a valid URL. " +
      "Copy app/.env.example to app/.env.local and set a valid indexer URL, then restart the server.",
    retryable: false, // operator error — a client retry cannot fix misconfiguration
  },
  network: {
    title: "Circles list unavailable",
    body:
      "The indexer is unreachable right now. Circles may not be up to date. " +
      "Check that the indexer service is running.",
    retryable: true,
  },
  server: {
    title: "Indexer error",
    body: "The indexer returned an unexpected error. Circles cannot be loaded at the moment.",
    retryable: true,
  },
  parse: {
    title: "Unexpected indexer response",
    body: "The indexer response was malformed. This is likely a temporary issue.",
    retryable: true,
  },
};

// ─── Retry banner ─────────────────────────────────────────────────────────────

interface RetryBannerProps {
  error: FetchError;
  attempt: number;
  onRetry: () => void;
  isPending: boolean;
  exhausted: boolean;
}

function RetryBanner({ error, attempt, onRetry, isPending, exhausted }: RetryBannerProps) {
  const { title, body, retryable } = ERROR_MESSAGES[error];

  // "Exhausted" state: we've retried MAX_RETRIES times and the error persists.
  // Show a calmer message rather than offering an infinite loop.
  if (exhausted) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-4 mb-6 flex items-start gap-3"
      >
        <span className="text-xl mt-0.5" aria-hidden="true">⚠️</span>
        <div>
          <p className="font-semibold text-amber-800 text-sm">{title}</p>
          <p className="text-amber-700 text-sm mt-0.5">
            {body}{" "}
            <span className="italic">
              After {MAX_RETRIES} retries the problem persists — please check back
              later or try refreshing the page.
            </span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-4 mb-6 flex items-start gap-3"
    >
      <span className="text-xl mt-0.5" aria-hidden="true">⚠️</span>
      <div className="flex-1">
        <p className="font-semibold text-amber-800 text-sm">{title}</p>
        <p className="text-amber-700 text-sm mt-0.5">{body}</p>

        {retryable && (
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={onRetry}
              disabled={isPending}
              className={
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium " +
                "bg-amber-100 text-amber-900 border border-amber-300 " +
                "hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 " +
                "focus-visible:ring-amber-500 focus-visible:ring-offset-1 " +
                "disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              }
              aria-label={isPending ? "Retrying, please wait…" : "Retry loading circles"}
              aria-busy={isPending}
            >
              {isPending ? (
                <>
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full border-2 border-amber-600 border-t-transparent animate-spin"
                    aria-hidden="true"
                  />
                  Retrying…
                </>
              ) : (
                <>↺ Retry</>
              )}
            </button>

            {attempt > 1 && !isPending && (
              <span className="text-amber-600 text-xs" aria-live="polite">
                Attempt {attempt} of {MAX_RETRIES}
              </span>
            )}
          </div>
        )}

        {!retryable && (
          <p className="text-amber-600 text-xs mt-2">
            This is a server configuration issue. Refreshing the page will not
            resolve it.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Loading skeleton (inline so the component is self-contained) ─────────────

function InlineListSkeleton() {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      role="status"
      aria-busy="true"
      aria-label="Loading circles…"
    >
      <span className="sr-only">Loading circles, please wait…</span>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="bg-white rounded-xl border border-slate-200 p-5 animate-pulse"
          aria-hidden="true"
        >
          <div className="h-3 bg-slate-200 rounded w-1/2 mb-2" />
          <div className="h-5 bg-slate-200 rounded w-2/3 mb-4" />
          <div className="grid grid-cols-3 gap-2 mb-3">
            {Array.from({ length: 3 }).map((__, j) => (
              <div key={j} className="bg-slate-100 rounded-lg h-10" />
            ))}
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full" />
          <div className="h-3 bg-slate-100 rounded w-1/3 mt-2" />
        </div>
      ))}
    </div>
  );
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface RetryableCirclesListProps {
  /**
   * The initial server-rendered children (CirclesList server component output).
   * Displayed on first paint and after every successful retry.
   */
  children: React.ReactNode;
  /**
   * When the server detected an error it passes the error kind here so the
   * client can show the retry banner immediately without a round-trip.
   * Null on the happy path — this component is a transparent pass-through.
   */
  initialError?: FetchError | null;
}

/**
 * Client shell wrapping the server-rendered CirclesList.
 *
 * Happy path: renders `children` inside a Suspense boundary — zero overhead,
 * no client-side state touched.
 *
 * Error path (initialError present):
 *   • Shows the RetryBanner immediately (no extra round-trip).
 *   • "Retry" triggers `router.refresh()` via startTransition so:
 *       1. React keeps the stale UI visible (no blank flash).
 *       2. The Suspense boundary re-enters its loading skeleton while the
 *          fresh server render is in flight — satisfying the acceptance
 *          criterion "retry transitions back through loading before success".
 *       3. If the refetch succeeds, children are replaced with fresh output.
 *   • Attempt count is tracked; after MAX_RETRIES the retry button is hidden
 *     and a calm "try again later" message is shown instead.
 *   • Network errors trigger a single auto-retry after AUTO_RETRY_DELAY_MS
 *     to handle transient connectivity blips transparently.
 */
export function RetryableCirclesList({
  children,
  initialError = null,
}: RetryableCirclesListProps) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(1);
  const [retryKey, setRetryKey] = useState(0);
  const [isPending, startTransition] = useTransition();

  // After MAX_RETRIES the user has seen the error enough times — stop
  // offering the button and show a calmer "please try again later" note.
  const exhausted = attempt > MAX_RETRIES;

  // Auto-retry for network errors: attempt once automatically after a delay.
  // This handles brief connectivity blips (e.g. service restart) without
  // requiring user interaction. Only fires on the first attempt.
  const autoRetryFiredRef = useRef(false);
  useEffect(() => {
    if (!initialError || initialError !== "network") return;
    if (autoRetryFiredRef.current) return;
    autoRetryFiredRef.current = true;

    const timer = setTimeout(() => {
      if (attempt === 1 && !isPending) {
        handleRetry();
      }
    }, AUTO_RETRY_DELAY_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialError]);

  const handleRetry = useCallback(() => {
    if (exhausted || isPending) return;
    startTransition(() => {
      setAttempt((n) => n + 1);
      // Bumping retryKey remounts the Suspense boundary, which drops the
      // cached server output and re-streams CirclesList from scratch —
      // producing the loading skeleton during the fetch as required.
      setRetryKey((k) => k + 1);
      router.refresh();
    });
  }, [exhausted, isPending, router, startTransition]);

  // Happy path — transparent pass-through with a Suspense boundary.
  if (!initialError) {
    return (
      <Suspense key={retryKey} fallback={<InlineListSkeleton />}>
        {children}
      </Suspense>
    );
  }

  // Error path — show banner above the (stale) children.
  return (
    <>
      <RetryBanner
        error={initialError}
        attempt={attempt}
        onRetry={handleRetry}
        isPending={isPending}
        exhausted={exhausted}
      />
      {/* Keep stale children visible below the banner so users can still
          read whatever was last successfully rendered. The Suspense key
          bump re-mounts the boundary and shows the skeleton during a retry. */}
      <Suspense key={retryKey} fallback={<InlineListSkeleton />}>
        {children}
      </Suspense>
    </>
  );
}
