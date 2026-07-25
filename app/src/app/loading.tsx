function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div className="space-y-2">
          <div className="h-3 w-20 bg-slate-200 rounded" />
          <div className="h-5 w-28 bg-slate-200 rounded" />
        </div>
        <div className="h-5 w-16 bg-slate-200 rounded-full" />
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-slate-100 rounded-lg py-2 px-1 space-y-1.5">
            <div className="h-4 w-8 bg-slate-200 rounded mx-auto" />
            <div className="h-3 w-12 bg-slate-200 rounded mx-auto" />
          </div>
        ))}
      </div>
      <div className="w-full bg-slate-100 rounded-full h-1.5" />
      <div className="h-3 w-24 bg-slate-200 rounded mt-2" />
    </div>
  );
}

export default function Loading() {
  return (
    <div>
      {/* Hero skeleton */}
      <div className="text-center py-12 animate-pulse">
        <div className="text-5xl mb-4">🔄</div>
        <div className="h-8 w-72 bg-slate-200 rounded mx-auto mb-3" />
        <div className="space-y-2 mb-8">
          <div className="h-4 w-96 bg-slate-200 rounded mx-auto" />
          <div className="h-4 w-80 bg-slate-200 rounded mx-auto" />
        </div>
        <div className="h-12 w-40 bg-slate-200 rounded-xl mx-auto" />
      </div>

      {/* How it works skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="bg-white rounded-xl border border-slate-200 p-5 text-center animate-pulse"
          >
            <div className="text-3xl mb-2">⬜</div>
            <div className="h-4 w-24 bg-slate-200 rounded mx-auto mb-1" />
            <div className="h-3 w-32 bg-slate-200 rounded mx-auto" />
          </div>
        ))}
      </div>

      {/* Circles list skeleton */}
      <div className="flex items-center justify-between mb-5">
        <div className="h-6 w-32 bg-slate-200 rounded animate-pulse" />
        <div className="h-4 w-20 bg-slate-200 rounded animate-pulse" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
