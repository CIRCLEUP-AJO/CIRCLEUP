import type { Metadata } from "next";
import { DashboardClient } from "./DashboardClient";

export const metadata: Metadata = {
  title: "My Circles — CircleUp",
  description:
    "View circles associated with your wallet address, including current round, contribution status, and upcoming deadlines.",
  robots: { index: false },
};

export default function DashboardPage() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-800 mb-1">My Circles</h1>
      <p className="text-sm text-slate-500 mb-6">
        Circles associated with your connected wallet. Data is sourced from the
        indexer and may lag the chain by one or more ledgers.
      </p>
      <DashboardClient />
    </main>
  );
}
