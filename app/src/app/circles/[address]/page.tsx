import { INDEXER_URL, shortAddress, stroopsToUsdc } from "@/lib/config";
import { CircleDetailClient } from "./CircleDetailClient";

async function getCircleDetail(address: string) {
  try {
    const [circleRes, roundsRes] = await Promise.all([
      fetch(`${INDEXER_URL}/circles/${address}`, { next: { revalidate: 5 } }),
      fetch(`${INDEXER_URL}/circles/${address}/rounds`, { next: { revalidate: 5 } }),
    ]);
    if (!circleRes.ok) return null;
    const circleData = await circleRes.json();
    const roundsData = roundsRes.ok ? await roundsRes.json() : { rounds: [], pendingDefaults: [] };
    return { ...circleData, ...roundsData };
  } catch {
    return null;
  }
}

export default async function CircleDetailPage({
  params,
}: {
  params: { address: string };
}) {
  const data = await getCircleDetail(params.address);

  if (!data) {
    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-4xl mb-3">🔍</div>
        <p className="font-medium">Circle not found.</p>
        <p className="text-sm mt-1">
          It may not be indexed yet — try refreshing in a moment.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-3 mb-2">
          <span className="text-3xl">🔄</span>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              ${stroopsToUsdc(data.circle.round_amount)} / round Circle
            </h1>
            <p className="font-mono text-sm text-slate-500">{params.address}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          {[
            { label: "Status", value: data.circle.status },
            { label: "Round", value: `${data.circle.current_round} / ${data.circle.total_rounds}` },
            { label: "Members", value: data.circle.member_count },
            {
              label: "Pot/round",
              value: `$${(
                parseFloat(stroopsToUsdc(data.circle.round_amount)) *
                data.circle.member_count
              ).toFixed(0)}`,
            },
          ].map((s) => (
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

      <CircleDetailClient
        circleAddress={params.address}
        circleData={data}
      />
    </div>
  );
}
