import { Suspense } from "react";
import Link from "next/link";
import { INDEXER_URL } from "@/lib/config";
import { CircleCard } from "@/components/CircleCard";
import type { Circle } from "@/components/CircleCard";

// ─── Types ────────────────────────────────────────────────────────────────────

type FetchResult =
  | { ok: true; circles: Circle[] }
  | { ok: false; error: "network" | "parse" | "server" | "misconfigured" };

// ─── URL validation ───────────────────────────────────────────────────────────

/**
 * Returns true when `url` is a syntactically valid absolute HTTP/HTTPS URL.
 * A misconfigured INDEXER_URL (empty string, relative path, placeholder text,
 * etc.) would otherwise cause fetch() to throw an opaque TypeError that looks
 * identical to a real network failure and gives no actionable guidance.
 */
function isValidUrl(url: string): boolean {
  if (!url || url.trim() === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function getCircles(): Promise<FetchResult> {
  // Catch misconfiguration before attempting the network request so that
  // developers get a targeted error message rather than a cryptic network failure.
  if (!isValidUrl(INDEXER_URL)) {
    return { ok: false, error: "misconfigured" };
  }

  let res: Response;
  try {
    res = await fetch(`${INDEXER_URL}/circles`, {
      next: { revalidate: 10 },
    });
  } catch {
    return { ok: false, error: "network" };
  }

  if (!res.ok) {
    return { ok: false, error: "server" };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "parse" };
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).circles)
  ) {
    return { ok: false, error: "parse" };
  }

  // Deduplicate by address — the indexer should never return duplicates, but
  // guard here so a transient bug never causes a React key collision or a
  // misleading count in the heading.
  const raw = (data as { circles: Circle[] }).circles;
  const seen = new Set<string>();
  const circles = raw.filter((c) => {
    if (seen.has(c.address)) return false;
    seen.add(c.address);
    return true;
  });

  return { ok: true, circles };
}

// ─── Error banner ─────────────────────────────────────────────────────────────

function IndexerErrorBanner({
  error,
}: {
  error: "network" | "parse" | "server" | "misconfigured";
}) {
  const messages: Record<string, string> = {
    misconfigured:
      "NEXT_PUBLIC_INDEXER_URL is not set or is not a valid URL. " +
      "Copy app/.env.example to app/.env.local and set a valid indexer URL, then restart the server.",
    network:
      "The indexer is unreachable right now. Circles may not be up to date. Check that the indexer service is running.",
    server:
      "The indexer returned an unexpected error. Circles cannot be loaded at the moment.",
    parse:
      "The indexer response was malformed. This is likely a temporary issue — try refreshing.",
  };

  return (
    <div
      role="alert"
      className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-4 mb-6 flex items-start gap-3"
    >
      <span className="text-xl mt-0.5" aria-hidden="true">⚠️</span>
      <div>
        <p className="font-semibold text-amber-800 text-sm">
          Circles list unavailable
        </p>
        <p className="text-amber-700 text-sm mt-0.5">{messages[error]}</p>
      </div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────
//
// Shown via Suspense while the async circles fetch is in flight. Renders the
// same grid layout as the real list so there is no layout shift on hydration.

function CircleListSkeleton() {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      aria-busy="true"
      aria-label="Loading circles…"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="bg-white rounded-xl border border-slate-200 p-5 animate-pulse"
          aria-hidden="true"
        >
          {/* Address line */}
          <div className="h-3 bg-slate-200 rounded w-1/2 mb-2" />
          {/* Amount line */}
          <div className="h-5 bg-slate-200 rounded w-2/3 mb-4" />
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            {Array.from({ length: 3 }).map((__, j) => (
              <div key={j} className="bg-slate-100 rounded-lg h-10" />
            ))}
          </div>
          {/* Progress bar */}
          <div className="h-1.5 bg-slate-100 rounded-full" />
          {/* Creator line */}
          <div className="h-3 bg-slate-100 rounded w-1/3 mt-2" />
        </div>
      ))}
    </div>
  );
}

// ─── Circles list (async server component) ────────────────────────────────────
//
// Extracted into its own async component so it can be wrapped in Suspense.
// The hero section renders immediately while this component fetches data.

async function CirclesList() {
  const result = await getCircles();

  if (!result.ok) {
    return <IndexerErrorBanner error={result.error} />;
  }

  if (result.circles.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-4xl mb-3">🌱</div>
        <p className="font-medium">No circles yet.</p>
        <p className="text-sm mt-1">
          <Link href="/create" className="text-brand-600 underline">
            Create the first one
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {result.circles.map((circle) => (
        <CircleCard key={circle.address} circle={circle} />
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  // Pre-fetch so we can show the count in the heading without waiting for the
  // Suspense boundary to resolve. If this fails the heading falls back to
  // "Active Circles" without a count — the list section handles errors itself.
  const countResult = await getCircles().catch(() => null);
  const circleCount =
    countResult?.ok ? countResult.circles.length : null;

  return (
    <div>
      {/* Hero */}
      <div className="text-center py-12">
        <div className="text-5xl mb-4">🔄</div>
        <h1 className="text-3xl font-bold text-slate-900 mb-3">
          Savings circles, made trustless
        </h1>
        <p className="text-slate-600 max-w-xl mx-auto mb-8 text-lg">
          CircleUp brings Ajo, Esusu, Tanda, and Chama onto Stellar Soroban.
          Every member contributes each round — the contract automatically pays
          the pot to the scheduled member. No organizer can run off with the money.
        </p>
        <Link
          href="/create"
          className="inline-block bg-brand-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-brand-700 transition-colors text-lg"
        >
          Create a Circle
        </Link>
      </div>

      {/* How it works */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
        {[
          {
            emoji: "👥",
            title: "Form a circle",
            desc: "Invite members, set the contribution amount and rotation order.",
          },
          {
            emoji: "💰",
            title: "Each round, everyone contributes",
            desc: "The smart contract holds the pot. No one can withdraw early.",
          },
          {
            emoji: "🎯",
            title: "The pot rotates",
            desc: "Each member receives the full pot exactly once. Miss a round → penalty.",
          },
        ].map((step) => (
          <div
            key={step.title}
            className="bg-white rounded-xl border border-slate-200 p-5 text-center"
          >
            <div className="text-3xl mb-2">{step.emoji}</div>
            <h3 className="font-semibold text-slate-800 mb-1">{step.title}</h3>
            <p className="text-slate-500 text-sm">{step.desc}</p>
          </div>
        ))}
      </div>

      {/* Protocol guarantees */}
      <div className="mb-12">
        <h2 className="text-xl font-bold text-slate-800 mb-4">
          🔐 Protocol Guarantees
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[
            {
              emoji: "🚫",
              title: "No rug-pulls",
              desc: "The organizer cannot withdraw funds early. All money is locked in the Soroban smart contract until the scheduled payout.",
            },
            {
              emoji: "🔄",
              title: "Deterministic rotation",
              desc: "Payout order is set on-chain at join time. The contract enforces it — no one can skip the queue or pay themselves twice.",
            },
            {
              emoji: "⚠️",
              title: "Collateral-backed defaults",
              desc: "Every member locks 1× the round amount as collateral. A missed contribution triggers an automatic penalty deducted from that collateral.",
            },
            {
              emoji: "🌐",
              title: "On-chain reputation",
              desc: "Contribution and default history is recorded on-chain. Your reputation score is public, portable, and unforgeable.",
            },
          ].map((g) => (
            <div
              key={g.title}
              className="bg-white rounded-xl border border-slate-200 p-5 flex gap-4 items-start"
            >
              <span className="text-2xl mt-0.5" aria-hidden="true">
                {g.emoji}
              </span>
              <div>
                <h3 className="font-semibold text-slate-800 mb-1">{g.title}</h3>
                <p className="text-slate-500 text-sm">{g.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Circles list */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold text-slate-800">
          Active Circles
          {circleCount !== null && (
            <span className="ml-2 text-sm font-normal text-slate-400">
              ({circleCount})
            </span>
          )}
        </h2>
        <Link
          href="/create"
          className="text-brand-600 text-sm font-medium hover:underline"
        >
          + New circle
        </Link>
      </div>

      {/* Suspense boundary: hero + heading render immediately; list streams in */}
      <Suspense fallback={<CircleListSkeleton />}>
        <CirclesList />
      </Suspense>
    </div>
  );
}
