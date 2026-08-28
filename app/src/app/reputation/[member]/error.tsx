"use client";

import { useEffect } from "react";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ReputationError({ error, reset }: Props) {
  useEffect(() => {
    console.error("[reputation-route-error]", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <div
      role="alert"
      className="bg-red-50 border border-red-200 rounded-xl px-5 py-8 flex flex-col items-center gap-4 text-center max-w-xl mx-auto"
    >
      <span className="text-3xl" aria-hidden="true">⚠️</span>
      <div>
        <p className="font-semibold text-red-800">Something went wrong loading this reputation page.</p>
        <p className="text-red-700 text-sm mt-1">
          This is likely a temporary issue. Try resetting the page or navigating back.
        </p>
        {error.digest && (
          <p className="text-xs text-red-400 mt-2 font-mono">ref: {error.digest}</p>
        )}
      </div>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
        >
          Try again
        </button>
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
