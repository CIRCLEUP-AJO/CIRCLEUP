import type { Metadata } from "next";
import { shortAddress } from "@/lib/config";
import ReputationClient from "./ReputationClient";

// ─── Metadata ─────────────────────────────────────────────────────────────────
//
// generateMetadata runs server-side; the member address comes from the dynamic
// route segment so we can produce a meaningful, per-member title without any
// network call.  The full address would overflow a typical <title> tag, so we
// use the same shortAddress helper the rest of the UI uses.

export async function generateMetadata({
  params,
}: {
  params: { member: string };
}): Promise<Metadata> {
  const short = shortAddress(params.member);
  return {
    title: `Reputation: ${short} — CircleUp`,
    description:
      `On-chain reputation score and circle participation history for ${params.member} on CircleUp. ` +
      `View completed rounds, defaults, and contribution records.`,
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────
//
// This is a Server Component — it renders on the server and streams HTML.
// All client-side state (fetch, loading spinner, refresh button) lives in
// ReputationClient which is marked "use client".  The page itself only needs
// to extract the route param and pass it down.

export default function ReputationPage({
  params,
}: {
  params: { member: string };
}) {
  return <ReputationClient member={params.member} />;
}
