import React from "react";
import { INDEXER_URL, formatUsdc, formatPot } from "@/lib/config";
import {
  CircleDetailClient,
  type CircleDetailData,
  type CircleMember,
  type CircleRound,
  type CirclePendingDefault,
} from "./CircleDetailClient";

// ─── Types ────────────────────────────────────────────────────────────────────

type FetchError = "network" | "not_found" | "server" | "parse";

type FetchResult =
  | { ok: true; data: CircleDetailData }
  | { ok: false; error: FetchError };

// ─── Data fetching ────────────────────────────────────────────────────────────

async function getCircleDetail(address: string): Promise<FetchResult> {
  let circleRes: Response;
  let roundsRes: Response;

  try {
    [circleRes, roundsRes] = await Promise.all([
      fetch(`${INDEXER_URL}/circles/${address}`, { next: { revalidate: 5 } }),
      fetch(`${INDEXER_URL}/circles/${address}/rounds`, {
        next: { revalidate: 5 },
      }),
    ]);
  } catch {
    return { ok: false, error: "network" };
  }

  if (circleRes.status === 404) {
    return { ok: false, error: "not_found" };
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
      : { rounds: [], pendingDefaults: [] };
  } catch {
    roundsData = { rounds: [], pendingDefaults: [] };
  }

  // Validate the shape we depend on to avoid runtime errors in the render tree
  if (
    typeof circleData.circle !== "object" ||
    circleData.circle === null
  ) {
    return { ok: false, error: "parse" };
  }

  return {
    ok: true,
    data: {
      circle: circleData.circle as CircleDetailData["circle"],
      members: Array.isArray(circleData.members)
        ? (circleData.members as CircleMember[])
        : [],
      rounds: Array.isArray(roundsData.rounds)
        ? (roundsData.rounds as CircleRound[])
        : [],
      pendingDefaults: Array.isArray(roundsData.pendingDefaults)
        ? (roundsData.pendingDefaults as CirclePendingDefault[])
        : [],
      latestLedger:
        typeof circleData.latestLedger === "number"
          ? circleData.latestLedger
          : null,
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
      value: circle ? (
        <span>{circle.status}</span>
      ) : (
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
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {circle
              ? `$${formatUsdc(circle.round_amount)} / round Circle`
              : "Circle"}
          </h1>
          <p className="font-mono text-sm text-slate-500">{address}</p>
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
  if (error === "not_found") {
    return (
      <div className="text-center py-12 text-slate-500" role="main">
        <div className="text-4xl mb-3">🔍</div>
        <p className="font-medium text-slate-800">Circle not found.</p>
        <p className="text-sm mt-1 text-slate-500">
          It may not be indexed yet — try refreshing in a moment.
        </p>
      </div>
    );
  }

  const messages: Record<string, string> = {
    network:
      "The indexer is unreachable. Check that the indexer service is running and try again.",
    server:
      "The indexer returned an unexpected error loading this circle.",
    parse:
      "The indexer response was malformed. This is likely temporary — try refreshing.",
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

  // Always render the header so the user has address context regardless of
  // whether the data fetch succeeded.
  if (!result.ok) {
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
