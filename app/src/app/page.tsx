import Link from "next/link";
import { INDEXER_URL } from "@/lib/config";
import { CircleCard, Circle } from "@/components/CircleCard";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Circle {
  address: string;
  creator: string;
  round_amount: string;
  member_count: number;
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
}

type FetchResult =
  | { ok: true; circles: Circle[] }
  | { ok: false; error: "network" | "parse" | "server" };

// ─── Data fetching ────────────────────────────────────────────────────────────

async function getCircles(): Promise<FetchResult> {
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

function IndexerErrorBanner({ error }: { error: "network" | "parse" | "server" }) {
  const messages: Record<string, string> = {
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
