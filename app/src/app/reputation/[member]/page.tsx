import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { shortAddress } from "@/lib/config";
import { isCanonicalStellarAddress } from "@/lib/address";
import ReputationClient from "./ReputationClient";

// ─── Metadata ─────────────────────────────────────────────────────────────────
//
// generateMetadata runs server-side; the member address comes from the dynamic
// route segment.  We validate it with isCanonicalStellarAddress before using
// it in any metadata string — a malformed or injected URL segment must not
// appear verbatim in <title> or <meta> attributes.
//
// Canonical URL: /reputation/<address>  (normalises the validated address).
// A malformed segment returns a generic title with no canonical link, which
// prevents search engines from indexing bogus paths.

export async function generateMetadata({
  params,
}: {
  params: { member: string };
}): Promise<Metadata> {
  // Guard: only accept well-formed Stellar/Soroban addresses
  if (!isCanonicalStellarAddress(params.member)) {
    return {
      title: "Reputation — CircleUp",
      description: "On-chain reputation score and contribution history on CircleUp.",
    };
  }

  const short = shortAddress(params.member);
  return {
    title: `Reputation: ${short}`,
    description:
      `On-chain reputation score and circle participation history for ${params.member} on CircleUp. ` +
      `View completed rounds, defaults, and contribution records.`,
    alternates: {
      canonical: `/reputation/${params.member}`,
    },
    openGraph: {
      title: `Reputation: ${short} — CircleUp`,
      description:
        `On-chain reputation score and circle participation history for ${params.member} on CircleUp.`,
      url: `/reputation/${params.member}`,
      type: "profile",
    },
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
  // Invalid address segments produce a proper 404 rather than an empty screen
  // that looks identical to "no activity yet" (Issue #385).
  if (!isCanonicalStellarAddress(params.member)) {
    notFound();
  }

  return <ReputationClient member={params.member} />;
}
