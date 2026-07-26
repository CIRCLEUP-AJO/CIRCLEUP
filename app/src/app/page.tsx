import { Suspense, cache } from "react";
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

/**
 * Fetches the circle list, memoized for the lifetime of a single server render.
 *
 * Three parts of the page need this data: the hero's secondary CTA, the count
 * beside the "Active Circles" heading, and the list itself. `cache()` collapses
 * them into one request per render, so the hero can never advertise "Browse 3
 * open circles" over a list that renders 4.
 */
const getCircles = cache(async function getCircles(): Promise<FetchResult> {
  // Catch misconfiguration before attempting the network request so that
  // developers get a targeted error message rather than a cryptic network failure.
  if (!isValidUrl(INDEXER_URL)) {
    return { ok: false, error: "misconfigured" };
  }

  let res: Response;
  try {
    // `cache: "no-store"` rather than `next: { revalidate: 10 }`. When the
    // indexer refuses the connection, Next's revalidate-cache wrapper leaves a
    // rejected promise nobody awaits; the dev server reports it as an
    // unhandledRejection and tears the render stream down with "failed to pipe
    // response", so the page 500s after a 60s hang and the "network" branch
    // below never reaches the user. `cache()` above already collapses this to
    // one request per render, so the only cost is the 10s cross-request cache.
    res = await fetch(`${INDEXER_URL}/circles`, {
      cache: "no-store",
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
});

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

/**
 * Count beside the "Active Circles" heading. Omitted entirely when the fetch
 * failed, so a stale or missing number is never presented as fact — the error
 * banner rendered by `CirclesList` explains why the list is empty.
 */
async function CircleCount() {
  const result = await getCircles().catch(() => null);
  if (!result || !result.ok) return null;

  return (
    <span className="ml-2 text-sm font-normal text-slate-400">
      ({result.circles.length})
    </span>
  );
}

// ─── Hero call-to-action ──────────────────────────────────────────────────────

type BrowseState =
  | { kind: "browse"; count: number }
  | { kind: "empty" }
  | { kind: "unavailable" };

/**
 * Decides what the hero's secondary call-to-action should offer.
 *
 * "Browse open circles" jumps to the list further down this page, so it may
 * only render when there is a list to jump to. Offering it when the indexer
 * returned nothing (or could not be reached at all) sends the reader to an
 * empty state or an error banner and reads as a broken button. Each case gets
 * its own explicit message instead.
 *
 * @param result The circles fetch, or `null` if it threw unexpectedly.
 */
function getBrowseState(result: FetchResult | null): BrowseState {
  if (!result || !result.ok) return { kind: "unavailable" };
  if (result.circles.length === 0) return { kind: "empty" };
  return { kind: "browse", count: result.circles.length };
}

/**
 * Shared button geometry so the two CTAs line up and share focus styling. Both
 * carry the border: on the solid primary it matches the fill and is invisible,
 * on the outlined secondary it is the outline. Keeping it on both is what makes
 * the two the same height when they sit side by side.
 */
const CTA_BASE =
  "inline-block px-6 py-3 rounded-xl font-semibold text-lg transition-colors " +
  "border border-brand-600 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-slate-50";

/**
 * The one part of the hero that depends on the indexer: either a "Browse N open
 * circles" button, or a line explaining why there is nothing to browse. Wrapped
 * in its own Suspense boundary by the page so the headline and the primary
 * "Create a circle" button paint without waiting on the network.
 */
async function HeroSecondaryCta() {
  const result = await getCircles().catch(() => null);
  const browse = getBrowseState(result);

  return (
    <>
      {browse.kind === "browse" && (
        <a
          href="#circles"
          className={`${CTA_BASE} bg-white text-brand-700 hover:bg-brand-50`}
        >
          Browse {browse.count} open{" "}
          {browse.count === 1 ? "circle" : "circles"}
        </a>
      )}

      {browse.kind === "empty" && (
        <p className="text-slate-500 text-sm sm:self-center">
          No circles have been created yet. Yours would be the first.
        </p>
      )}

      {browse.kind === "unavailable" && (
        <p className="text-slate-500 text-sm sm:self-center">
          Existing circles cannot be listed right now. See the notice below.
        </p>
      )}
    </>
  );
}

/**
 * Invisible stand-in with the same box as the secondary CTA, so the hint line
 * underneath does not jump once the indexer responds.
 */
function HeroSecondaryCtaFallback() {
  return (
    <span className={`${CTA_BASE} invisible`} aria-hidden="true">
      Browse open circles
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HomePage() {
  return (
    <div>
      {/* Hero */}
      <section aria-labelledby="hero-heading" className="text-center py-12">
        <div className="text-5xl mb-4" aria-hidden="true">🔄</div>
        <h1
          id="hero-heading"
          className="text-3xl font-bold text-slate-900 mb-3"
        >
          Start a savings circle no one can run off with
        </h1>
        <p className="text-slate-600 max-w-xl mx-auto mb-8 text-lg">
          Ajo, Esusu, Tanda, and Chama, on Stellar. Everyone pays in once a
          round, and the contract hands the whole pot to whoever&apos;s turn it
          is. Funds sit in the contract, never with an organizer.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
          <Link
            href="/create"
            className={`${CTA_BASE} bg-brand-600 text-white hover:bg-brand-700`}
          >
            Create a circle
          </Link>

          <Suspense fallback={<HeroSecondaryCtaFallback />}>
            <HeroSecondaryCta />
          </Suspense>
        </div>

        {/* Sets expectations for the primary CTA. Without this the wallet
            requirement only surfaces as an error after the create form is
            filled in and submitted. */}
        <p className="text-slate-500 text-sm mt-4">
          Setting one up takes about a minute. You will need a Freighter wallet
          and the Stellar addresses of 2 to 20 members.
        </p>
      </section>

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

      {/* Circles list — `id` is the target of the hero's "Browse" CTA, and
          scroll-mt keeps the heading clear of the top of the viewport. */}
      <div
        id="circles"
        className="flex items-center justify-between mb-5 scroll-mt-6"
      >
        <h2 className="text-xl font-bold text-slate-800">
          Active Circles
          <Suspense fallback={null}>
            <CircleCount />
          </Suspense>
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
