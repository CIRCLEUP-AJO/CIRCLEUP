"use client";

import { useEffect } from "react";
import {
  classifyRouteError,
  isRetryableOutcome,
  type RouteOutcome,
} from "@/lib/route-outcome";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

interface OutcomeCopy {
  icon: string;
  title: string;
  body: string;
}

const OUTCOME_COPY: Record<RouteOutcome, OutcomeCopy> = {
  "invalid-address": {
    icon: "🚫",
    title: "Invalid member address",
    body: "The address in this URL is not a valid Stellar account. Check the link and make sure it is a complete, well-formed public key.",
  },
  "unknown-entity": {
    icon: "🔍",
    title: "Member not found",
    body: "This address has no reputation record for this circle. It may not be a member, or the link may be incorrect.",
  },
  "delayed-indexing": {
    icon: "⏳",
    title: "Reputation not indexed yet",
    body: "This member exists on-chain but the indexer has not processed it yet. This usually resolves within a few minutes.",
  },
  "contract-read-failure": {
    icon: "⚠️",
    title: "Could not read reputation data",
    body: "The reputation contract could not be read. This is likely a temporary issue — try again shortly.",
  },
  "service-outage": {
    icon: "🔌",
    title: "Indexer unavailable",
    body: "The indexer is unreachable or currently degraded. Reputation data cannot be loaded right now. This is usually temporary — try again in a few minutes.",
  },
  unknown: {
    icon: "⚠️",
    title: "Something went wrong loading this reputation page.",
    body: "This is likely a temporary issue. Try resetting the page or navigating back.",
  },
};

export default function ReputationError({ error, reset }: Props) {
  useEffect(() => {
    console.error("[reputation-route-error]", error.digest ?? "(no digest)");
  }, [error]);

  const outcome = classifyRouteError(error);
  const copy = OUTCOME_COPY[outcome];
  const retryable = isRetryableOutcome(outcome);

  return (
    <div
      role="alert"
      className="bg-red-50 border border-red-200 rounded-xl px-5 py-8 flex flex-col items-center gap-4 text-center max-w-xl mx-auto"
    >
      <span className="text-3xl" aria-hidden="true">
        {copy.icon}
      </span>
      <div>
        <p className="font-semibold text-red-800">{copy.title}</p>
        <p className="text-red-700 text-sm mt-1">{copy.body}</p>
        {error.digest && (
          <p className="text-xs text-red-400 mt-2 font-mono">
            ref: {error.digest}
          </p>
        )}
      </div>
      <div className="flex gap-3">
        {retryable && (
          <button
            onClick={reset}
            className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
          >
            Try again
          </button>
        )}
        <a
          href="/"
          className="px-4 py-2 bg-white border border-red-200 text-red-700 text-sm font-medium rounded-lg hover:bg-red-50 transition-colors"
        >
          Back to circles
        </a>
      </div>
    </div>
  );
}
