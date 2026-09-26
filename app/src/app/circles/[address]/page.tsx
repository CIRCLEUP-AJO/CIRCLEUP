import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  indexerEndpoint,
  INDEXER_TIMEOUT_MS,
  formatUsdc,
  formatPot,
} from "@/lib/config";
import { parseMemberRows } from "@/lib/members";
import { getStatusMeta } from "@/components/CircleCard";
// Issue #513: use shared parsers — eliminates the unsafe `as CircleRound[]`
// and `as CircleDetailData["circle"]` casts that were previously here.
import {
  parseCircleState,
  parseRoundsResponse,
} from "@/lib/circleTypes";
import {
  CircleDetailClient,
  type CircleDetailData,
} from "./CircleDetailClient";

export async function generateMetadata({
  params,
}: {
  params: { address: string };
}): Promise<Metadata> {
  // Validate the address before using it in any metadata string.
  // A path traversal or injected value would otherwise appear verbatim in
  // <title> and <meta> tags.  We only accept canonical 56-char Soroban
  // contract IDs (C-prefix, base32) — anything else gets the safe fallback.
  const safeAddress = /^C[A-Z2-7]{55}$/.test(params.address)
    ? params.address
    : null;

  if (!safeAddress) {
    // Malformed address segment: return a generic fallback rather than
    // surfacing the raw (potentially malicious) string in the document head.
    return {
      title: "Circle — CircleUp",
      description: "Savings circle on CircleUp.",
      twitter: {
        card: "summary",
        title: "Circle — CircleUp",
        description: "Savings circle on CircleUp.",
      },
    };
  }

  // Attempt to enrich the metadata with live circle data.  A failure here must
  // never 500 the page — fall back to the address-only title gracefully.
  try {
    const result = await getCircleDetail(safeAddress);
    if (result.ok) {
      const { circle } = result.data;
      // All values used below come from the indexer (trusted server data),
      // but we still sanitise them before interpolating into HTML attributes
      // to prevent injection if the indexer response is ever compromised.
      const status = String(circle.status).replace(/[<>"'&]/g, "");
      const pot = `$${formatPot(circle.round_amount, circle.member_count)}`;
      const roundAmount = `$${formatUsdc(circle.round_amount)}`;
      const shortAddr = safeAddress.slice(0, 8);
      return {
        title: `${roundAmount}/round Circle (${status})`,
        description:
          `${pot} pot · ${circle.member_count} members · round ${circle.current_round} of ${circle.total_rounds}. ` +
          `Savings circle at ${safeAddress} on CircleUp.`,
        alternates: {
          canonical: `/circles/${safeAddress}`,
        },
        openGraph: {
          title: `${roundAmount}/round Circle (${status}) — CircleUp`,
          description:
            `${pot} pot · ${circle.member_count} members · round ${circle.current_round} of ${circle.total_rounds}.`,
          url: `/circles/${safeAddress}`,
          type: "website",
        },
        twitter: {
          card: "summary",
          title: `${roundAmount}/round Circle (${status}) — CircleUp`,
          description:
            `${pot} pot · ${circle.member_count} members · round ${circle.current_round} of ${circle.total_rounds}.`,
        },
      };
    }
  } catch {
    // Silently fall through to the default below
  }

  // Default: address-only fallback when the indexer is unreachable or the
  // circle is not found (404 will be served by the page render, not here).
  const shortAddr = safeAddress.slice(0, 8);
  return {
    title: `Circle ${shortAddr}…`,
    description: `Savings circle at ${safeAddress} on CircleUp. Track rotation order, round progress, and contribution history.`,
    alternates: {
      canonical: `/circles/${safeAddress}`,
    },
    twitter: {
      card: "summary",
      title: `Circle ${shortAddr}… — CircleUp`,
      description: `Savings circle at ${safeAddress} on CircleUp.`,
    },
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

type FetchError = "network" | "server" | "parse" | "misconfigured" | "indexer_outage";

// not_found is handled separately: the page calls notFound() which triggers
// Next.js's built-in 404 route — CircleErrorBody is never rendered for it.
type FetchResult =
  | { ok: true; data: CircleDetailData }
  | { ok: false; error: "not_found" | FetchError };

// ─── Data fetching ────────────────────────────────────────────────────────────

async function getCircleDetail(address: string): Promise<FetchResult> {
  // Guard against a misconfigured NEXT_PUBLIC_INDEXER_URL before touching the
  // network (see indexerEndpoint in lib/config.ts).
  const circleUrl = indexerEndpoint(["circles", address]);
  const roundsUrl = indexerEndpoint(["circles", address, "rounds"]);
  if (circleUrl === null || roundsUrl === null) {
    return { ok: false, error: "misconfigured" };
  }

  let circleRes: Response;
  let roundsRes: Response;

  try {
    // `cache: "no-store"` rather than `next: { revalidate: 5 }`: when the
    // indexer URL points at a port nothing listens on, Next's revalidate-cache
    // wrapper leaves a rejected promise unawaited and the page 500s after a long
    // hang instead of reaching the "network" branch below. Same fix as the
    // home page. The timeout covers an unroutable host.
    const init: RequestInit = {
      cache: "no-store",
      signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    };
    [circleRes, roundsRes] = await Promise.all([
      fetch(circleUrl, init),
      fetch(roundsUrl, init),
    ]);
  } catch {
    return { ok: false, error: "network" };
  }

  if (circleRes.status === 404) {
    return { ok: false, error: "not_found" };
  }
  if (circleRes.status === 503) {
    return { ok: false, error: "indexer_outage" };
  }
  if (!circleRes.ok) {
    return { ok: false, error: "server" };
  }

  let circleData: Record<string, unknown>;
  let roundsData: Record<string, unknown>;

  try {
    circleData = (await circleRes.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "parse" };
  }

  try {
    roundsData = roundsRes.ok
      ? ((await roundsRes.json()) as Record<string, unknown>)
      : { rounds: [], openRounds: [], pendingDefaults: [], currentRound: null };
  } catch {
    roundsData = { rounds: [], openRounds: [], pendingDefaults: [], currentRound: null };
  }

  // Validate the shape we depend on to avoid runtime errors in the render tree.
  // Issue #513: parseCircleState replaces the bare `as CircleDetailData["circle"]`
  // cast — if the indexer returns a malformed object, we return a parse error
  // rather than letting a broken value propagate into the render tree.
  if (
    typeof circleData.circle !== "object" ||
    circleData.circle === null
  ) {
    return { ok: false, error: "parse" };
  }

  const circleState = parseCircleState(circleData.circle);
  if (!circleState) {
    return { ok: false, error: "parse" };
  }

  // Members are optional — if the indexer omits the field (e.g. during
  // re-indexing or for very new circles) or sends rows we cannot trust, we
  // fall back to an empty array and CircleDetailClient renders its "member
  // data unavailable" fallback in the rotation view instead of crashing.
  const members = parseMemberRows(circleData.members);

  // Issue #513: parseRoundsResponse replaces the four inline `as CircleRound[]`
  // and `as CirclePendingDefault[]` casts — validates rounds, openRounds,
  // pendingDefaults and currentRound, dropping malformed rows rather than
  // surfacing them in the render tree.
  const roundsPayload = parseRoundsResponse(roundsData);

  return {
    ok: true,
    data: {
      circle: circleState,
      members,
      rounds: roundsPayload.rounds,
      // openRounds: unpaid rounds with activity that are not the current round.
      // Previously invisible to the client because the old /rounds endpoint
      // only iterated payouts (issue #170).
      openRounds: roundsPayload.openRounds,
      pendingDefaults: roundsPayload.pendingDefaults,
      latestLedger:
        typeof circleData.latestLedger === "number"
          ? circleData.latestLedger
          : null,
      // currentRound from the /rounds response contains the actual
      // contributions list for the in-progress round — used by
      // CircleDetailClient to accurately gate the Contribute button.
      currentRound: roundsPayload.currentRound,
    },
  };
}

// ─── Read-only circle header ──────────────────────────────────────────────────
//
// Always rendered — even when the data fetch fails — so the user always sees
// the circle address and a coherent page structure instead of a blank screen.
//
// When `circle` is provided the real stats are shown; when it is absent
// (error / not-found) each stat cell renders a muted "—" placeholder so the
// layout is preserved and clearly communicates "unknown, not broken UI".

interface CircleHeaderProps {
  address: string;
  circle?: CircleDetailData["circle"] | null;
}

function CircleHeader({ address, circle }: CircleHeaderProps) {
  const stats: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "Status",
      value: circle ? (() => {
        const s = getStatusMeta(circle.status);
        return (
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${s.chipClasses}`}
            title={s.description}
            aria-label={`Status: ${s.label}. ${s.description}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${s.dotClasses}`} aria-hidden="true" />
            {s.label}
          </span>
        );
      })() : (
        <span className="text-slate-300" aria-hidden="true">—</span>
      ),
    },
    {
      label: "Round",
      value: circle ? (
        `${circle.current_round} / ${circle.total_rounds}`
      ) : (
        <span className="text-slate-300" aria-hidden="true">—</span>
      ),
    },
    {
      label: "Members",
      value: circle ? (
        circle.member_count
      ) : (
        <span className="text-slate-300" aria-hidden="true">—</span>
      ),
    },
    {
      label: "Pot/round",
      value: circle ? (
        `$${formatPot(circle.round_amount, circle.member_count)}`
      ) : (
        <span className="text-slate-300" aria-hidden="true">—</span>
      ),
    },
  ];

  return (
    <div className="mb-8" aria-label="Circle overview">
      <div className="flex items-start gap-3 mb-2">
        <span className="text-3xl" aria-hidden="true">🔄</span>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-snug">
            {circle
              ? `$${formatUsdc(circle.round_amount)} / round Circle`
              : "Circle"}
          </h1>
          <p className="font-mono text-sm text-slate-500 break-all select-all">
            {address}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="bg-white rounded-xl border border-slate-200 p-4 text-center"
          >
            <p className="text-lg font-bold text-slate-900">{s.value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Error body ───────────────────────────────────────────────────────────────
//
// Rendered below the header (never instead of it) so the address context is
// always visible.

function CircleErrorBody({ error }: { error: FetchError }) {
  const messages: Record<string, string> = {
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
  };

  return (
    <div
      role="alert"
      className="bg-amber-50 border border-amber-300 rounded-xl px-5 py-6 flex items-start gap-3"
    >
      <span className="text-2xl mt-0.5" aria-hidden="true">⚠️</span>
      <div>
        <p className="font-semibold text-amber-800">Could not load circle details</p>
        <p className="text-amber-700 text-sm mt-1">{messages[error]}</p>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function CircleDetailPage({
  params,
}: {
  params: { address: string };
}) {
  const result = await getCircleDetail(params.address);

  if (!result.ok) {
    if (result.error === "not_found") {
      notFound();
    }
    // At this point result.error is narrowed to FetchError (never "not_found")
    return (
      <div>
        <CircleHeader address={params.address} circle={null} />
        <CircleErrorBody error={result.error} />
      </div>
    );
  }

  const { data } = result;

  return (
    <div>
      <CircleHeader address={params.address} circle={data.circle} />

      <CircleDetailClient
        circleAddress={params.address}
        circleData={data}
      />
    </div>
  );
}
