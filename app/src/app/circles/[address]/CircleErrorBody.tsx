"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

export type FetchError =
  | "network"
  | "server"
  | "parse"
  | "misconfigured"
  | "indexer_outage"
  | "invalid_address"
  | "contract_read"
  | "indexing_delayed";

// ─── Error copy ───────────────────────────────────────────────────────────────
//
// Kept consistent with the server-rendered copy in page.tsx so a retry does not
// surprise the user with different wording.

const ERROR_MESSAGES: Record<FetchError, string> = {
  misconfigured:
    "NEXT_PUBLIC_INDEXER_URL is not set or is not a valid URL. " +
    "Copy app/.env.example to app/.env.local and set a valid indexer URL, then restart the server.",
  network:
    "The indexer is unreachable. Check that the indexer service is running and try again.",
  server:
    "The indexer returned an unexpected error loading this circle.",
  parse:
    "The indexer response was malformed. This is likely temporary — try refreshing.",
  indexer_outage:
    "The indexer is running but currently degraded. It may be catching up with the chain or experiencing a service disruption. " +
    "Circle details may be incomplete or temporarily unavailable. Try refreshing in a few minutes.",
  invalid_address:
    "The circle address in the URL is not a valid address. Check the link and make sure it points to a circle contract address.",
  contract_read:
    "The circle contract could not be read. The contract may not exist at this address or the RPC endpoint may be unavailable. Try again in a moment.",
  indexing_delayed:
    "This circle exists on-chain but the indexer has not seen it yet. Indexing can take a few minutes after a circle is created. Try refreshing shortly.",
};

/** Errors a page refresh can sensibly be asked to recover from. */
const RETRYABLE_ERRORS: FetchError[] = [
  "network",
  "server",
  "parse",
  "contract_read",
  "indexing_delayed",
];

/**
 * Circle detail fetch error, rendered below the header so the circle address
 * stays visible even when the data cannot be loaded.
 *
 * Retry is offered only for transient read failures (network / server / parse).
 * Configuration problems and sustained indexer outages are operator- or
 * service-side issues that a page refresh cannot fix, so no retry button is
 * shown for them — this keeps deterministic/invalid failures from being
 * presented as retryable network outages.
 */
export default function CircleErrorBody({
  error,
}: {
  error: FetchError;
}) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  const canRetry = RETRYABLE_ERRORS.includes(error);

  async function handleRetry() {
    if (retrying || !canRetry) return;
    setRetrying(true);
    // router.refresh() re-runs the server component so the circle is refetched
    // from the indexer.  If it fails again the same error body re-renders.
    await router.refresh();
  }

  return (
    <div
      role="alert"
      className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-6 flex items-start gap-3"
    >
      <span className="text-2xl mt-0.5" aria-hidden="true">
        ⚠️
      </span>
      <div>
        <p className="font-semibold text-amber-800">Could not load circle details</p>
        <p className="text-amber-700 text-sm mt-1">{ERROR_MESSAGES[error]}</p>
        {canRetry && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium underline text-amber-800 hover:text-amber-900 disabled:opacity-50"
          >
            {retrying ? "Retrying…" : "Try again"}
          </button>
        )}
        <p className="mt-3 text-xs">
          <Link href="/" className="underline text-amber-800 hover:text-amber-900">
            Back to circles
          </Link>
        </p>
      </div>
    </div>
  );
}
