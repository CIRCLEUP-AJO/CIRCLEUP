"use client";

import { useEffect } from "react";

import {
  classifyRouteError,
  isRetryableOutcome,
  routeOutcomeCopy,
} from "@/lib/route-outcome";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function CircleError({ error, reset }: Props) {
  useEffect(() => {
    console.error("[circle-route-error]", error.digest ?? "(no digest)");
  }, [error]);

  const outcome = classifyRouteError(error);
  const copy = routeOutcomeCopy(outcome);
  const retryable = isRetryableOutcome(outcome);

  return (
    <div
      role="alert"
      className="bg-red-50 border border-red-200 rounded-xl px-5 py-8 flex flex-col items-center gap-4 text-center"
    >
      <span className="text-3xl" aria-hidden="true">
        {copy.icon}
      </span>
      <div>
        <p className="font-semibold text-red-800">{copy.title}</p>
        <p className="text-red-700 text-sm mt-1">{copy.description}</p>
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
          href={copy.recoveryHref}
          className="px-4 py-2 bg-white border border-red-200 text-red-700 text-sm font-medium rounded-lg hover:bg-red-50 transition-colors"
        >
          {copy.recoveryLabel}
        </a>
      </div>
    </div>
  );
}
