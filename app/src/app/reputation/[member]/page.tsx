import { indexerFetch } from "@/lib/indexerFetch";
import type { Metadata } from "next";
import { INDEXER_URL, shortAddress } from "@/lib/config";
import { validateAddress } from "@/lib/address";
import {
  RouteOutcomeError,
  resolveRouteOutcome,
  type RouteOutcome,
} from "@/lib/routeOutcome";
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
  const memberParam = typeof params?.member === "string" ? params.member.trim() : "";
  const validation = validateAddress(memberParam, { kind: "G", requireChecksum: true });
  const safeMember = validation.ok ? validation.address : null;

  if (!safeMember) {
    return {
      title: "Reputation — CircleUp",
      description: "On-chain reputation score and contribution history on CircleUp.",
      twitter: {
        card: "summary",
        title: "Reputation — CircleUp",
        description: "On-chain reputation score and contribution history on CircleUp.",
      },
    };
  }

  const lookup = await lookupReputationMember(safeMember);
  if (!lookup.ok) {
    // Temporary failure: keep the generic title rather than claiming the
    // member is unknown, and omit the canonical link.
    return {
      title: "Reputation — CircleUp",
      description: "On-chain reputation score and contribution history on CircleUp.",
      twitter: {
        card: "summary",
        title: "Reputation — CircleUp",
        description: "On-chain reputation score and contribution history on CircleUp.",
      },
    };
  }

  if (lookup.outcome.kind === "unknown" || lookup.outcome.kind === "indexing-delayed") {
    const title =
      lookup.outcome.kind === "indexing-delayed"
        ? "Member Indexing Delayed — CircleUp"
        : "Member Not Found — CircleUp";
    const description =
      lookup.outcome.kind === "indexing-delayed"
        ? "This member has not been indexed yet. Please check back shortly."
        : "The requested member address has no recorded activity on CircleUp.";
    return {
      title,
      description,
      twitter: { card: "summary", title, description },
    };
  }

  const short = shortAddress(safeMember);
  return {
    title: `Reputation: ${short} — CircleUp`,
    description:
      `On-chain reputation score and circle participation history for ${safeMember} on CircleUp. ` +
      `View completed rounds, defaults, and contribution records.`,
    alternates: {
      canonical: `/reputation/${safeMember}`,
    },
    openGraph: {
      title: `Reputation: ${short} — CircleUp`,
      description:
        `On-chain reputation score and circle participation history for ${safeMember} on CircleUp.`,
      url: `/reputation/${safeMember}`,
      type: "profile",
    },
    twitter: {
      card: "summary",
      title: `Reputation: ${short} — CircleUp`,
      description:
        `On-chain reputation score and circle participation history for ${safeMember} on CircleUp.`,
    },
  };
}

// ─── URL validation ────────────────────────────────────────────────────────────

/**
 * Returns true when `url` is a syntactically valid absolute HTTP/HTTPS URL.
 * A misconfigured INDEXER_URL (empty string, relative path, placeholder text,
 * etc.) would otherwise cause indexerFetch() to throw an opaque TypeError that looks
 * identical to a real network failure and gives no actionable guidance.
 */
function isValidUrl(url: string): boolean {
  if (!url || url.trim() === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Member existence lookup ───────────────────────────────────────────────────
//
// The indexer deliberately serves unknown members as `200` with `found: false`
// (see Issue #461): a missing row is "no activity yet", not an error — and the
// contribution/default counters let us tell "real, explicitly-tracked zero
// score" apart from "no record at all".
//
// The lookup resolves to a route outcome so the page can distinguish a
// genuinely unknown member (404) from a delayed index (404 + delayed copy),
// a contract read failure (502), and a service outage (503).
type MemberLookup =
  | { ok: true; outcome: RouteOutcome }
  | { ok: false };

/**
 * Checks whether a member has any recorded on-chain presence, so unknown
 * reputation members can be served a real 404 (Issue #486). Returns
 * `{ ok: false }` when the indexer is unreachable or misbehaving — the page
 * then renders normally and lets the client-side ReputationClient surface its
 * existing outage / retry states instead of mislabelling an outage as "member
 * not found".
 */
async function lookupReputationMember(member: string): Promise<MemberLookup> {
  if (!isValidUrl(INDEXER_URL)) {
    return { ok: false };
  }

  let res: Response;
  try {
    res = await indexerFetch(`${INDEXER_URL}/reputation/${member}`, {
      cache: "no-store",
    });
  } catch {
    return { ok: false };
  }

  if (res.status === 404) {
    return { ok: true, outcome: { kind: "unknown" } };
  }
  if (!res.ok) {
    return { ok: false };
  }

  try {
    const data = (await res.json()) as {
      found?: unknown;
      contributions?: unknown;
      defaults?: unknown;
      indexing?: unknown;
    };
    if (typeof data !== "object" || data === null) {
      return { ok: false };
    }
    if (data.indexing === "pending" || data.indexing === "delayed") {
      return { ok: true, outcome: { kind: "indexing-delayed" } };
    }
    return { ok: true, outcome: { kind: "ok" } };
  } catch {
    return { ok: false };
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────
//
// This is a Server Component — it renders on the server and streams HTML.
// All client-side state (fetch, loading spinner, refresh button) lives in
// ReputationClient which is marked "use client".  The page itself validates
// the route param, serves a 404 for unknown members, and passes the member
// address down to the client.

export default async function ReputationPage({
  params,
}: {
  params: { member: string };
}) {
  // Validation runs before any RPC or indexer lookup so malformed segments
  // never reach downstream services (Issue #385 / #968).
  const validation = validateAddress(params.member, {
    kind: "G",
    requireChecksum: true,
  });
  if (!validation.ok) {
    resolveRouteOutcome({ kind: "invalid-address" });
  }
  const member = validation.address;

  // Issue #486: a well-formed address with no recorded on-chain presence
  // (no reputation row, no contributions, no defaults) has no reputation page.
  // Serving a real 404 — instead of a 200 page that reads like "nothing yet" —
  // gives users and search engines an unambiguous signal that the member is
  // unknown, while the not-found page guides them on what to check next.
  const lookup = await lookupReputationMember(member);
  if (!lookup.ok) {
    // Temporary failure: let the client surface its outage / retry states.
    return <ReputationClient member={member} />;
  }

  if (lookup.outcome.kind !== "ok") {
    resolveRouteOutcome(lookup.outcome);
  }

  return <ReputationClient member={member} />;
}
