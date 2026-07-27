import Link from "next/link";

export default function NotFound() {
  return (
    <div className="text-center py-24 max-w-sm mx-auto">
      <div className="text-5xl mb-4" aria-hidden="true">🔍</div>
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Page not found</h1>
      <p className="text-slate-500 mb-8">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
        If you followed a circle or reputation link, the address may be incorrect.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link
          href="/"
          className="bg-brand-600 text-white px-5 py-2.5 rounded-lg hover:bg-brand-700 transition-colors font-medium"
        >
          View all circles
        </Link>
        <Link
          href="/create"
          className="border border-brand-600 text-brand-700 px-5 py-2.5 rounded-lg hover:bg-brand-50 transition-colors font-medium"
        >
          Create a circle
        </Link>
      </div>
    </div>
  );
}
