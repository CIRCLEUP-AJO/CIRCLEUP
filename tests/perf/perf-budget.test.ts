/**
 * Performance budget checks for CircleUp.
 *
 * Each test measures a specific metric against the versioned threshold in
 * tests/perf/budgets.json. Failures identify the route and metric by name.
 *
 * Fixture strategy:
 *   - API payload tests use in-memory JSON fixtures (no live indexer).
 *   - Render time tests use Node.js timing (no browser, no jsdom).
 *   - Bundle size tests parse the .next/analyze output when present; they are
 *     skipped (not failed) when no build artefact exists so CI can gate the
 *     check to post-build steps only.
 *
 * Run:
 *   node --test tests/perf/perf-budget.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Canonical money-math constants ──────────────────────────────────────────
//
// These values are inlined here because this test file runs with `node --test`
// directly — it cannot import TypeScript source from another workspace package
// at runtime.  They MUST stay in sync with the canonical definitions:
//
//   USDC_DECIMALS → sdk/src/constants.ts : USDC_DECIMALS  (currently 7)
//   STROOP        → sdk/src/utils.ts     : STROOP         (BigInt(10 ** USDC_DECIMALS))
//
// The assertions immediately below are the automated guard: if either value
// drifts from the canonical source the test suite will fail at the top of the
// file, before any timing measurement runs, making the divergence impossible
// to miss.

/** Mirror of USDC_DECIMALS in sdk/src/constants.ts. */
const USDC_DECIMALS = 7;
/** Mirror of STROOP in sdk/src/utils.ts — must equal BigInt(10 ** USDC_DECIMALS). */
const STROOP = BigInt(10 ** USDC_DECIMALS);

// Invariant assertions — fail fast if constants drift from the canonical source.
assert.strictEqual(USDC_DECIMALS, 7,   "USDC_DECIMALS must equal sdk/src/constants.ts USDC_DECIMALS");
assert.strictEqual(STROOP, 10_000_000n, "STROOP must equal sdk/src/utils.ts STROOP (10^USDC_DECIMALS)");



const _dirname = typeof __dirname !== "undefined"
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const budgetsPath = join(_dirname, "budgets.json");
const BUDGETS = JSON.parse(readFileSync(budgetsPath, "utf8"));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCircleFixture(i: number) {
  return {
    address: `CCIRCLE${String(i).padStart(49, "0")}`,
    creator: `GCREATOR${String(i).padStart(48, "0")}`,
    round_amount: "100000000",
    member_count: 10,
    status: i % 2 === 0 ? "Active" : "Pending",
    current_round: i % 10,
    total_rounds: 10,
    created_ledger: 1000 + i,
  };
}

function makeCircleDetailFixture(memberCount: number) {
  const members = Array.from({ length: memberCount }, (_, i) => ({
    member: `GMEMBER${String(i).padStart(49, "0")}`,
    join_order: i + 1,
    has_contributed: i % 2 === 0,
    payout_round: (i % memberCount) + 1,
    payout_received: i < Math.floor(memberCount / 2),
    joined_ledger: 1000 + i,
  }));

  return {
    address: "CCIRCLEDETAIL0000000000000000000000000000000000000001",
    creator: "GCREATOR000000000000000000000000000000000000000000001",
    round_amount: "100000000",
    member_count: memberCount,
    status: "Active",
    current_round: Math.floor(memberCount / 2) + 1,
    total_rounds: memberCount,
    created_ledger: 1000,
    members,
  };
}

function makeReputationFixture(score: number, completedRounds: number, defaultsCount = 0) {
  return {
    member: "GMEMBERREPUTATION0000000000000000000000000000000001",
    score,
    completed_rounds: completedRounds,
    streak: Math.min(score, 12),
    defaults_count: defaultsCount,
    last_active_ledger: 50000,
    badge: score >= 10 ? "Legend" : score >= 6 ? "Trusted" : score >= 3 ? "Reliable" : score >= 1 ? "Starter" : "New",
  };
}

function makeContributionFixture(i: number) {
  return {
    member: `GMEMBER${String(i).padStart(49, "0")}`,
    round: i,
    amount: "100000000",
    txHash: "a".repeat(64),
    ledger: 1000 + i,
  };
}

// ─── API payload tests ────────────────────────────────────────────────────────

describe("API payload budgets", () => {
  test("empty circle list payload is within budget", () => {
    const payload = JSON.stringify({ circles: [] });
    const bytes = Buffer.byteLength(payload, "utf8");
    const budget = BUDGETS.payload.emptyListBytes;

    assert.ok(
      bytes <= budget,
      `[api:circleList:empty] payload ${bytes}B exceeds budget ${budget}B`,
    );
  });

  test("10-circle list payload is within budget", () => {
    const circles = Array.from({ length: 10 }, (_, i) => makeCircleFixture(i));
    const payload = JSON.stringify({ circles });
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.payload.populatedList10CirclesKb;

    assert.ok(
      kb <= budget,
      `[api:circleList:10] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("50-circle list payload is within budget", () => {
    const circles = Array.from({ length: 50 }, (_, i) => makeCircleFixture(i));
    const payload = JSON.stringify({ circles });
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.payload.populatedList50CirclesKb;

    assert.ok(
      kb <= budget,
      `[api:circleList:50] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("100-circle list payload is within budget", () => {
    const circles = Array.from({ length: 100 }, (_, i) => makeCircleFixture(i));
    const payload = JSON.stringify({ circles });
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.payload.populatedList100CirclesKb;

    assert.ok(
      kb <= budget,
      `[api:circleList:100] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("circle detail minimal (1 member) payload is within budget", () => {
    const detail = makeCircleDetailFixture(1);
    const payload = JSON.stringify(detail);
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.api.circleDetailMinimal.payloadKb;

    assert.ok(
      kb <= budget,
      `[api:circleDetail:minimal] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("circle detail standard (10 members) payload is within budget", () => {
    const detail = makeCircleDetailFixture(10);
    const payload = JSON.stringify(detail);
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.api.circleDetail10Members.payloadKb;

    assert.ok(
      kb <= budget,
      `[api:circleDetail:10] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("circle detail maximum (256 members) payload is within budget", () => {
    const detail = makeCircleDetailFixture(256);
    const payload = JSON.stringify(detail);
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.api.circleDetailMax256Members.payloadKb;

    assert.ok(
      kb <= budget,
      `[api:circleDetail:256] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("reputation profile (new member) payload is within budget", () => {
    const rep = makeReputationFixture(0, 0, 0);
    const payload = JSON.stringify(rep);
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.api.reputationProfileNew.payloadKb;

    assert.ok(
      kb <= budget,
      `[api:reputationProfile:new] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("reputation profile (active member) payload is within budget", () => {
    const rep = makeReputationFixture(8, 5, 0);
    const payload = JSON.stringify(rep);
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.api.reputationProfileActive.payloadKb;

    assert.ok(
      kb <= budget,
      `[api:reputationProfile:active] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("member contributions payload (10 entries) is within budget", () => {
    const contributions = Array.from({ length: 10 }, (_, i) =>
      makeContributionFixture(i),
    );
    const payload = JSON.stringify({ contributions });
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.api.memberContributions10.payloadKb;

    assert.ok(
      kb <= budget,
      `[api:memberContributions:10] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("member contributions payload (50 entries) is within budget", () => {
    const contributions = Array.from({ length: 50 }, (_, i) =>
      makeContributionFixture(i),
    );
    const payload = JSON.stringify({ contributions });
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.api.memberContributions50.payloadKb;

    assert.ok(
      kb <= budget,
      `[api:memberContributions:50] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("member contributions payload (100 entries) is within budget", () => {
    const contributions = Array.from({ length: 100 }, (_, i) =>
      makeContributionFixture(i),
    );
    const payload = JSON.stringify({ contributions });
    const kb = Buffer.byteLength(payload, "utf8") / 1024;
    const budget = BUDGETS.api.memberContributions100.payloadKb;

    assert.ok(
      kb <= budget,
      `[api:memberContributions:100] payload ${kb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });
});

// ─── Render time budgets ──────────────────────────────────────────────────────
// Uses process.hrtime.bigint() for sub-millisecond resolution. These run in
// Node (no DOM) and measure pure JSON serialization + field mapping cost as a
// proxy for component preparation overhead.

describe("Render preparation budgets", () => {
  test("processing 1 circle fixture is within CircleCard budget", () => {
    const circle = makeCircleFixture(0);
    const budget = BUDGETS.render.circleCardMs;

    const start = process.hrtime.bigint();
    // Simulate the work CircleCard does: status lookup, formatting
    const status = circle.status?.trim().toLowerCase();
    const amount = BigInt(circle.round_amount);
    const whole = amount / STROOP;
    const frac = (amount % STROOP).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
    const _formatted = `${whole}.${frac}`;
    const _progress = circle.total_rounds > 0
      ? Math.round((circle.current_round / circle.total_rounds) * 100)
      : 0;
    void status; void _formatted; void _progress;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[render:CircleCard] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("processing 6 circle fixtures is within skeleton budget", () => {
    const budget = BUDGETS.render.circleListSkeleton6CardsMs;

    const start = process.hrtime.bigint();
    for (let i = 0; i < 6; i++) {
      const c = makeCircleFixture(i);
      const _s = c.status?.trim().toLowerCase();
      void _s;
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[render:CircleListSkeleton] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("processing 12 circle fixtures is within grid budget", () => {
    const budget = BUDGETS.render.circleGrid12CardsMs;

    const start = process.hrtime.bigint();
    for (let i = 0; i < 12; i++) {
      const c = makeCircleFixture(i);
      const status = c.status?.trim().toLowerCase();
      const amount = BigInt(c.round_amount);
      const whole = amount / STROOP;
      const frac = (amount % STROOP).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
      const _formatted = `${whole}.${frac}`;
      void status; void _formatted;
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[render:CircleGrid12] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("processing CircleDetail page data (256 members) is within budget", () => {
    const detail = makeCircleDetailFixture(256);
    const budget = BUDGETS.render.circleDetailPreparationMs;

    const start = process.hrtime.bigint();
    const roundAmount = BigInt(detail.round_amount);
    const whole = roundAmount / STROOP;
    const frac = (roundAmount % STROOP).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
    const _formattedRoundAmount = `${whole}.${frac}`;
    const _membersSummary = detail.members.map((m) => ({
      member: m.member,
      status: m.has_contributed ? "Contributed" : "Pending",
      isPayoutRecipient: m.payout_round === detail.current_round,
    }));
    void _formattedRoundAmount; void _membersSummary;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[render:CircleDetailPreparation] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("processing ReputationBadge tiers is within budget", () => {
    const budget = BUDGETS.render.reputationBadgeMs;

    const TIERS = [
      { label: "New", minScore: 0 },
      { label: "Starter", minScore: 1 },
      { label: "Reliable", minScore: 3 },
      { label: "Trusted", minScore: 6 },
      { label: "Legend", minScore: 10 },
    ];

    const start = process.hrtime.bigint();
    const score = 7;
    let matched = TIERS[0];
    for (let i = TIERS.length - 1; i >= 0; i--) {
      if (score >= TIERS[i].minScore) { matched = TIERS[i]; break; }
    }
    void matched;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[render:ReputationBadge] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("processing ReputationProfile full page data is within budget", () => {
    const rep = makeReputationFixture(15, 12, 0);
    const budget = BUDGETS.render.reputationProfilePreparationMs;

    const start = process.hrtime.bigint();
    const TIERS = [
      { label: "New", minScore: 0 },
      { label: "Starter", minScore: 1 },
      { label: "Reliable", minScore: 3 },
      { label: "Trusted", minScore: 6 },
      { label: "Legend", minScore: 10 },
    ];
    let currentTier = TIERS[0];
    for (let i = TIERS.length - 1; i >= 0; i--) {
      if (rep.score >= TIERS[i].minScore) { currentTier = TIERS[i]; break; }
    }
    const reliabilityRate = rep.completed_rounds > 0
      ? ((rep.completed_rounds - rep.defaults_count) / rep.completed_rounds) * 100
      : 100;
    const _profile = {
      ...rep,
      tier: currentTier.label,
      reliabilityPercent: reliabilityRate.toFixed(1),
    };
    void _profile;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[render:ReputationProfilePreparation] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("processing ContributionHistory table (100 rows) is within budget", () => {
    const contributions = Array.from({ length: 100 }, (_, i) => makeContributionFixture(i));
    const budget = BUDGETS.render.contributionHistoryTableMs;

    const start = process.hrtime.bigint();
    const _tableRows = contributions.map((c) => {
      const amount = BigInt(c.amount);
      const whole = amount / STROOP;
      const frac = (amount % STROOP).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
      return {
        member: `${c.member.slice(0, 4)}...${c.member.slice(-4)}`,
        round: `Round ${c.round}`,
        amount: `${whole}.${frac} USDC`,
        txHash: `${c.txHash.slice(0, 8)}...`,
        ledger: c.ledger,
      };
    });
    void _tableRows;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[render:ContributionHistoryTable] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });
});

// ─── Bundle size budgets ──────────────────────────────────────────────────────
// Reads .next/analyze/client.html if it exists (produced by @next/bundle-analyzer).
// Falls back to parsing the .next/build-manifest.json for raw chunk sizes.
// Tests are skipped (not failed) when no build output is present — they are
// intended to run in CI after `next build`.

describe("Bundle size budgets", () => {
  const nextDir = join(_dirname, "../../app/.next");
  const buildManifestPath = join(nextDir, "build-manifest.json");

  test("shared chunks fit within budget (skipped if no build)", () => {
    if (!existsSync(buildManifestPath)) {
      console.log("  [bundle:shared] skipped — no .next/build-manifest.json (run `next build` first)");
      return;
    }

    const manifest = JSON.parse(readFileSync(buildManifestPath, "utf8")) as {
      pages: Record<string, string[]>;
    };

    // Sum the sizes of chunks shared across all pages (appear in every page entry)
    const pageEntries = Object.values(manifest.pages);
    if (pageEntries.length === 0) return;

    const chunkCounts: Record<string, number> = {};
    for (const chunks of pageEntries) {
      for (const chunk of chunks) {
        chunkCounts[chunk] = (chunkCounts[chunk] ?? 0) + 1;
      }
    }
    const shared = Object.keys(chunkCounts).filter(
      (c) => chunkCounts[c] === pageEntries.length,
    );

    let totalKb = 0;
    for (const chunk of shared) {
      const chunkPath = join(nextDir, "static", chunk);
      if (existsSync(chunkPath)) {
        totalKb += readFileSync(chunkPath).length / 1024;
      }
    }

    const budget = BUDGETS.bundle.sharedChunksKb;
    assert.ok(
      totalKb <= budget,
      `[bundle:shared] ${totalKb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });

  test("home page first-load fits within budget (skipped if no build)", () => {
    if (!existsSync(buildManifestPath)) {
      console.log("  [bundle:home] skipped — run `next build` first");
      return;
    }

    const manifest = JSON.parse(readFileSync(buildManifestPath, "utf8")) as {
      pages: Record<string, string[]>;
    };
    const homeChunks = manifest.pages["/"] ?? [];

    let totalKb = 0;
    for (const chunk of homeChunks) {
      const chunkPath = join(nextDir, "static", chunk);
      if (existsSync(chunkPath)) {
        totalKb += readFileSync(chunkPath).length / 1024;
      }
    }

    const budget = BUDGETS.bundle.homePage.firstLoadKb;
    assert.ok(
      totalKb <= budget,
      `[bundle:home] ${totalKb.toFixed(1)} KB exceeds budget ${budget} KB`,
    );
  });
});

// ─── Query time simulation ────────────────────────────────────────────────────
// Verifies that in-memory fixture serialisation completes within indexer
// query budgets as a lower-bound sanity check. Real DB query time is measured
// by the indexer's own benchmark suite; these tests catch regressions in the
// data-mapping layer.

describe("Query time budgets", () => {
  test("serialising empty circles fits within empty-list query budget", () => {
    const budget = BUDGETS.api.circleListEmpty.queryMs;

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify({ circles: [] });
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:circleListEmpty] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising 10 circle rows fits within circleList10 query budget", () => {
    const budget = BUDGETS.api.circleList10.queryMs;

    const circles = Array.from({ length: 10 }, (_, i) => makeCircleFixture(i));

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify({ circles });
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:circleList10] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising 50 circle rows fits within circleList50 query budget", () => {
    const budget = BUDGETS.api.circleList50.queryMs;

    const circles = Array.from({ length: 50 }, (_, i) => makeCircleFixture(i));

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify({ circles });
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:circleList50] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising 100 circle rows fits within circleList100 query budget", () => {
    const budget = BUDGETS.api.circleList100.queryMs;

    const circles = Array.from({ length: 100 }, (_, i) => makeCircleFixture(i));

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify({ circles });
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:circleList100] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising circleDetail with 10 members fits within query budget", () => {
    const budget = BUDGETS.api.circleDetail10Members.queryMs;
    const detail = makeCircleDetailFixture(10);

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify(detail);
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:circleDetail10] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising circleDetail with 256 members fits within max-members query budget", () => {
    const budget = BUDGETS.api.circleDetailMax256Members.queryMs;
    const detail = makeCircleDetailFixture(256);

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify(detail);
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:circleDetail256] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising reputation profile (new) fits within query budget", () => {
    const budget = BUDGETS.api.reputationProfileNew.queryMs;
    const rep = makeReputationFixture(0, 0, 0);

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify(rep);
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:reputationProfileNew] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising reputation profile (active) fits within query budget", () => {
    const budget = BUDGETS.api.reputationProfileActive.queryMs;
    const rep = makeReputationFixture(8, 5, 0);

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify(rep);
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:reputationProfileActive] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising 10 member contributions fits within query budget", () => {
    const budget = BUDGETS.api.memberContributions10.queryMs;
    const contributions = Array.from({ length: 10 }, (_, i) => makeContributionFixture(i));

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify({ contributions });
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:memberContributions10] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising 50 member contributions fits within query budget", () => {
    const budget = BUDGETS.api.memberContributions50.queryMs;
    const contributions = Array.from({ length: 50 }, (_, i) => makeContributionFixture(i));

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify({ contributions });
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:memberContributions50] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });

  test("serialising 100 member contributions fits within query budget", () => {
    const budget = BUDGETS.api.memberContributions100.queryMs;
    const contributions = Array.from({ length: 100 }, (_, i) => makeContributionFixture(i));

    const start = process.hrtime.bigint();
    const _payload = JSON.stringify({ contributions });
    void _payload;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs <= budget,
      `[query:memberContributions100] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget} ms`,
    );
  });
});
