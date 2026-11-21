"use client";

import { useEffect } from "react";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

type FailureKind = "rpc" | "indexer" | "unknown";

/**
 * Heuristically classify the failure from the error message.
 * Structured error codes don't survive Next.js error boundaries, so we
 * inspect the message string as a best-effort signal.
 *
 * RPC failures mean the on-chain reputation score could not be read, so the
 * score is unverified. Indexer failures mean contribution/default history is
 * temporarily unavailable. These are distinct states for the user.
 */
function classifyFailure(error: Error): FailureKind {
  const msg = error.message.toLowerCase();
  const looksLikeRpc =
    msg.includes("rpc") ||
    msg.includes("contract read") ||
    msg.includes("reputation contract") ||
    msg.includes("revert") ||
    msg.includes("call exception") ||
    msg.includes("could not decode") ||
    msg.includes("eth_call");
  if (looksLikeRpc) return "rpc";
  const looksLikeIndexer =
    msg.includes("503") ||
    msg.includes("indexer") ||
    msg.includes("degraded") ||
    msg.includes("unreachable") ||
    msg.includes("network") ||
    msg.includes("fetch failed");
  if (looksLikeIndexer) return "indexer";
  return "unknown";
}

export default function ReputationError({ error, reset }: Props) {
  useEffect(() => {
    console.error("[reputation-route-error]", error.digest ?? "(no digest)");
  }, [error]);

  const failure = classifyFailure(error);

  return (
    <div
      role="alert"
      className="bg-red-50 border border-red-200 rounded-xl px-5 py-8 flex flex-col items-center gap-4 text-center max-w-xl mx-auto"
    >
      <span className="text-3xl" aria-hidden="true">
        {failure === "rpc" ? "⛓️" : failure === "indexer" ? "🔌" : "⚠️"}
      </span>
      <div>
        {failure === "rpc" ? (
          <>
            <p className="font-semibold text-red-800">
              Reputation score unavailable
            </p>
            <p className="text-red-700 text-sm mt-1">
              The on-chain reputation contract could not be read, so this
              member&apos;s score could not be verified. This does not mean the
              score is zero — it is currently unknown. Try again in a moment.
            </p>
          </>
        ) : failure === "indexer" ? (
          <>
            <p className="font-semibold text-red-800">
              History temporarily unavailable
            </p>
            <p className="text-red-700 text-sm mt-1">
              The indexer is unreachable or currently degraded, so contribution
              and default history cannot be loaded right now. This does not mean
              the member has no activity — the history is simply unavailable.
              This is usually temporary — try again in a few minutes.
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold text-red-800">
              Something went wrong loading this reputation page.
            </p>
            <p className="text-red-700 text-sm mt-1">
              This is likely a temporary issue. Try resetting the page or
              navigating back.
            </p>
          </>
        )}
        {error.digest && (
          <p className="text-xs text-red-400 mt-2 font-mono">
            ref: {error.digest}
          </p>
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
