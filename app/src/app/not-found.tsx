import Link from "next/link";

export default function NotFound() {
  return (
    <div className="text-center py-24">
      <div className="text-5xl mb-4">🔍</div>
      <h2 className="text-2xl font-bold text-slate-900 mb-2">Page not found</h2>
      <p className="text-slate-500 mb-6">The page you're looking for doesn't exist.</p>
      <Link
        href="/"
        className="bg-brand-600 text-white px-5 py-2 rounded-lg hover:bg-brand-700 transition-colors"
      >
        Go home
      </Link>
    </div>
  );
}
