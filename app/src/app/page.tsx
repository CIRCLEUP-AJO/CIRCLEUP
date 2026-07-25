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
    // Network error – indexer unreachable
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

  return { ok: true, circles: (data as { circles: Circle[] }).circles };
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  const result = await getCircles();

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
        <h2 className="text-xl font-bold text-slate-800">Active Circles</h2>
        <Link
          href="/create"
          className="text-brand-600 text-sm font-medium hover:underline"
        >
          + New circle
        </Link>
      </div>

      {!result.ok ? (
        <IndexerErrorBanner error={result.error} />
      ) : result.circles.length === 0 ? (
        <div className="text-center py-16 text-slate-500">
          <div className="text-4xl mb-3">🌱</div>
          <p className="font-medium">No circles yet.</p>
          <p className="text-sm mt-1">
            <Link href="/create" className="text-brand-600 underline">
              Create the first one
            </Link>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {result.circles.map((circle) => (
            <CircleCard key={circle.address} circle={circle} />
          ))}
        </div>
      )}
    </div>
  );
}
