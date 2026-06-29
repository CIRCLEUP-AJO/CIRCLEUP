import { INDEXER_URL, shortAddress } from "@/lib/config";
import { ReputationBadge } from "@/components/ReputationBadge";

async function getReputation(member: string) {
  try {
    const res = await fetch(`${INDEXER_URL}/reputation/${member}`, {
      next: { revalidate: 10 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function ReputationPage({
  params,
}: {
  params: { member: string };
}) {
  const data = await getReputation(params.member);

  if (!data) {
    return (
      <div className="text-center py-16 text-slate-500">
        <div className="text-4xl mb-3">🔍</div>
        <p>Member not found.</p>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Reputation</h1>
      <p className="font-mono text-sm text-slate-500 mb-6">{params.member}</p>

      <div className="bg-white rounded-xl border border-slate-200 p-6 text-center mb-6">
        <ReputationBadge score={data.score} size="lg" />
        <p className="text-3xl font-bold text-slate-900 mt-3">{data.score}</p>
        <p className="text-slate-500 text-sm">completed rounds</p>
      </div>

      {data.contributions.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
          <h2 className="font-semibold text-slate-800 mb-3">Circle participation</h2>
          <div className="space-y-2">
            {data.contributions.map((c: any) => (
              <div
                key={c.circle_address}
                className="flex items-center justify-between text-sm"
              >
                <span className="font-mono text-slate-600 text-xs">
                  {shortAddress(c.circle_address)}
                </span>
                <span className="text-slate-500">
                  {c.contributions} / {c.total_rounds} rounds
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.defaults.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-5">
          <h2 className="font-semibold text-red-800 mb-3">Defaults</h2>
          <div className="space-y-2">
            {data.defaults.map((d: any) => (
              <div
                key={d.circle_address}
                className="flex items-center justify-between text-sm"
              >
                <span className="font-mono text-slate-600 text-xs">
                  {shortAddress(d.circle_address)}
                </span>
                <span className="text-red-700 font-medium">{d.count} default(s)</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
