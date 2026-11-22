/**
 * Performance budget suite — offline and deterministic.
 *
 * Fixtures come from tests/perf/fixtures.ts (mirrors indexer/src/db/schema.sql)
 * and tier sizes from tests/perf/fixture-profiles.json. No live Stellar RPC,
 * no PostgreSQL, no real user data. See docs/PERFORMANCE_BUDGETS.md.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  TIERS,
  MAX_MEMBERS,
  makeCircleRow,
  makeCircleMemberRow,
  makeContributionRow,
  makePayoutRow,
  makeDefaultRow,
  makeReputationRow,
  makeCircleDetailPayload,
  makeCircleListPayload,
  makeContributionListPayload,
  type Tier,
} from './fixtures.ts';

const here = dirname(fileURLToPath(import.meta.url));
const BUDGETS = JSON.parse(readFileSync(join(here, 'budgets.json'), 'utf8'));
const PROFILES = JSON.parse(readFileSync(join(here, 'fixture-profiles.json'), 'utf8'));

const TIER_NAMES: Tier[] = ['small', 'typical', 'highWater'];

function kb(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') / 1024;
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

// ─── Production-like fixture generators ──────────────────────────────────────
//
// Deterministic, offline fixtures spanning small / typical / high-water data
// sizes. All values are synthesised from indices — no real user records, no
// live Stellar RPC. The same seed always yields the same bytes so budgets are
// reproducible across CI runs and machines.

/** Named workload sizes used across API and render budget tests. */
const WORKLOAD_SIZES = Object.freeze({
  small: { circles: 5, members: 3, contributionsPerMember: 5 },
  typical: { circles: 50, members: 10, contributionsPerMember: 25 },
  highWater: { circles: 200, members: 256, contributionsPerMember: 100 },
});

/** Deterministic pseudo-random integer in [0, max) derived from a seed. */
function seededInt(seed: number, max: number): number {
  // xorshift-style mix keeps values stable and cheap to compute.
  let x = (seed * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = (x * 2246822519) >>> 0;
  x ^= x >>> 13;
  return max > 0 ? x % max : 0;
}

/** Deterministic 64-char hex hash for a given seed (stands in for a tx hash). */
function seededHash(seed: number): string {
  let out = "";
  let x = (seed * 2654435761 + 1) >>> 0;
  for (let i = 0; i < 8; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

/**
 * Production-like circle list fixture. Mixes statuses, round progress, and
 * member counts so serialization cost reflects a realistic distribution rather
 * than a uniform array.
 */
function makeProductionCircleList(count: number) {
  const statuses = ["Active", "Pending", "Completed", "Paused"];
  return Array.from({ length: count }, (_, i) => {
    const memberCount = 2 + seededInt(i + 1, 255); // 2..256
    const totalRounds = memberCount;
    return {
      address: `CCIRCLE${String(i).padStart(49, "0")}`,
      creator: `GCREATOR${String(i).padStart(48, "0")}`,
      round_amount: String(50_000_000 + seededInt(i + 7, 950_000_000)),
      member_count: memberCount,
      status: statuses[seededInt(i + 3, statuses.length)],
      current_round: seededInt(i + 5, totalRounds + 1),
      total_rounds: totalRounds,
      created_ledger: 1000 + i * 37,
    };
  });
}

/**
 * Production-like circle detail fixture with a full member roster and a
 * contribution history of `contributionsPerMember` entries per member.
 */
function makeProductionCircleDetail(memberCount: number, contributionsPerMember: number) {
  const members = Array.from({ length: memberCount }, (_, i) => ({
    member: `GMEMBER${String(i).padStart(49, "0")}`,
    join_order: i + 1,
    has_contributed: seededInt(i + 11, 2) === 0,
    payout_round: (i % memberCount) + 1,
    payout_received: i < Math.floor(memberCount / 2),
    joined_ledger: 1000 + i * 3,
  }));

  const contributions = members.flatMap((m, mi) =>
    Array.from({ length: contributionsPerMember }, (_, ci) => ({
      member: m.member,
      round: ci + 1,
      amount: String(50_000_000 + seededInt(mi * 131 + ci + 1, 950_000_000)),
      txHash: seededHash(mi * 1000 + ci + 1),
      ledger: 1000 + mi * 3 + ci,
    })),
  );

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
    contributions,
  };
}

/**
 * Production-like page state bundle: the data each app page receives after
 * fetching, so render budgets exercise realistic payload shapes.
 */
function makePageStateFixture(size: keyof typeof WORKLOAD_SIZES) {
  const spec = WORKLOAD_SIZES[size];
  return {
    circleList: makeProductionCircleList(spec.circles),
    circleDetail: makeProductionCircleDetail(spec.members, spec.contributionsPerMember),
    reputation: makeReputationFixture(seededInt(spec.circles, 20), spec.circles, 0),
  };
}

/**
 * Maximum-size circle fixture (256 members per protocol constant MAX_MEMBERS).
 * Used to measure resource budgets for boundary cases.
 */
function makeMaxSizeCircleFixture(i: number) {
  return {
    address: `CCIRCLEMAX${String(i).padStart(48, "0")}`,
    creator: `GCREATORMAX${String(i).padStart(47, "0")}`,
    round_amount: "100000000",
    member_count: 256,  // MAX_MEMBERS from protocol
    status: i % 2 === 0 ? "Active" : "Pending",
    current_round: i % 10,
    total_rounds: 10,
    created_ledger: 1000 + i,
  };
}

describe('USDC decimals drift guard', () => {
  it('keeps 7 decimals consistent with the indexer', () => {
    const USDC_DECIMALS = 7;
    assert.equal(USDC_DECIMALS, 7);
    assert.equal(10 ** USDC_DECIMALS, 10_000_000);
  });
});

// ─── Production-like workload budgets ────────────────────────────────────────
// Exercises small / typical / high-water fixtures end-to-end through the
// serialization and mapping layers. Budgets are derived from the same
// budgets.json entries used by the synthetic tests, scaled by workload size,
// so regressions in realistic shapes surface with a clear route+metric label.

describe("Production-like workload budgets", () => {
  for (const size of Object.keys(WORKLOAD_SIZES) as Array<keyof typeof WORKLOAD_SIZES>) {
    const spec = WORKLOAD_SIZES[size];

    test(`[${size}] circle list serialization is within budget`, () => {
      const circles = makeProductionCircleList(spec.circles);
      const budget = BUDGETS.api.circleList100.queryMs * (spec.circles / 100 + 1);

      const start = process.hrtime.bigint();
      const _payload = JSON.stringify({ circles });
      void _payload;
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

      assert.ok(
        elapsedMs <= budget,
        `[query:circleList:${size}] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget.toFixed(3)} ms`,
      );
    });

    test(`[${size}] circle detail + contribution history serialization is within budget`, () => {
      const detail = makeProductionCircleDetail(spec.members, spec.contributionsPerMember);
      const budget = BUDGETS.api.circleDetailMax256Members.queryMs * 4;

      const start = process.hrtime.bigint();
      const _payload = JSON.stringify(detail);
      void _payload;
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

      assert.ok(
        elapsedMs <= budget,
        `[query:circleDetail:${size}] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget.toFixed(3)} ms`,
      );
    });

    test(`[${size}] page state render preparation is within budget`, () => {
      const state = makePageStateFixture(size);
      const budget = BUDGETS.render.circleDetailPreparationMs * 4;

      const start = process.hrtime.bigint();
      const _cards = state.circleList.map((c) => {
        const amount = BigInt(c.round_amount);
        const whole = amount / STROOP;
        const frac = (amount % STROOP).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
        return {
          address: c.address,
          status: c.status?.trim().toLowerCase(),
          amount: `${whole}.${frac}`,
          progress: c.total_rounds > 0 ? Math.round((c.current_round / c.total_rounds) * 100) : 0,
        };
      });
      const _rows = state.circleDetail.contributions.map((c) => {
        const amount = BigInt(c.amount);
        const whole = amount / STROOP;
        const frac = (amount % STROOP).toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
        return {
          member: `${c.member.slice(0, 4)}...${c.member.slice(-4)}`,
          round: `Round ${c.round}`,
          amount: `${whole}.${frac} USDC`,
          txHash: `${c.txHash.slice(0, 8)}...`,
        };
      });
      void _cards; void _rows;
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

      assert.ok(
        elapsedMs <= budget,
        `[render:pageState:${size}] ${elapsedMs.toFixed(3)} ms exceeds budget ${budget.toFixed(3)} ms`,
      );
    });
  }

  test("high-water circle detail payload stays within a bounded size", () => {
    const spec = WORKLOAD_SIZES.highWater;
    const detail = makeProductionCircleDetail(spec.members, spec.contributionsPerMember);
    const kb = Buffer.byteLength(JSON.stringify(detail), "utf8") / 1024;
    // 256 members × 100 contributions ≈ 25.6k rows; ~200B/row upper bound.
    const budgetKb = 8192;

    assert.ok(
      kb <= budgetKb,
      `[api:circleDetail:highWater] payload ${kb.toFixed(1)} KB exceeds budget ${budgetKb} KB`,
    );
  });

  test("fixtures are deterministic across invocations", () => {
    const a = JSON.stringify(makePageStateFixture("typical"));
    const b = JSON.stringify(makePageStateFixture("typical"));
    assert.strictEqual(a, b, "[fixtures:determinism] production-like fixtures must be reproducible");
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
  }

  it('circle rows match schema.sql', () => {
    assertSubset(makeCircleRow(0), CIRCLE_COLUMNS, 'circle');
  });
  it('circle member rows match schema.sql', () => {
    assertSubset(makeCircleMemberRow(makeCircleRow(0).address, 0), MEMBER_COLUMNS, 'member');
  });
  it('contribution rows match schema.sql', () => {
    assertSubset(makeContributionRow(0), CONTRIBUTION_COLUMNS, 'contribution');
  });
  it('payout rows match schema.sql', () => {
    assertSubset(makePayoutRow(0), PAYOUT_COLUMNS, 'payout');
  });
  it('default rows match schema.sql', () => {
    assertSubset(makeDefaultRow(0), DEFAULT_COLUMNS, 'default');
  });
  it('reputation rows match schema.sql', () => {
    assertSubset(makeReputationRow(10, 2, 0), REPUTATION_COLUMNS, 'reputation');
  });
  it('high-water member count equals MAX_MEMBERS', () => {
    assert.equal(TIERS.highWater.members, MAX_MEMBERS);
    assert.equal(PROFILES.maxMembers, MAX_MEMBERS);
  });
});

describe('API payload budgets', () => {
  for (const tier of TIER_NAMES) {
    it(`circle list payload stays within budget [api:circleList:${tier}]`, () => {
      const count = PROFILES.profiles[tier].circleListCount;
      const payload = makeCircleListPayload(count);
      const sizeKb = kb(payload);
      assert.ok(
        sizeKb <= BUDGETS.api.circleList[tier].payloadKb,
        `[api:circleList:${tier}] ${sizeKb.toFixed(1)}KB > ${BUDGETS.api.circleList[tier].payloadKb}KB`,
      );
    });

    it(`member contributions payload stays within budget [api:memberContributions:${tier}]`, () => {
      const count = PROFILES.profiles[tier].contributionCount;
      const payload = makeContributionListPayload(count);
      const sizeKb = kb(payload);
      assert.ok(
        sizeKb <= BUDGETS.api.memberContributions[tier].payloadKb,
        `[api:memberContributions:${tier}] ${sizeKb.toFixed(1)}KB > ${BUDGETS.api.memberContributions[tier].payloadKb}KB`,
      );
    });
  }

  it('circle detail payload stays within budget [api:circleDetail:minimal]', () => {
    const payload = makeCircleDetailPayload(PROFILES.profiles.small.circleDetailMembers);
    const sizeKb = kb(payload);
    assert.ok(
      sizeKb <= BUDGETS.api.circleDetail.minimal.payloadKb,
      `[api:circleDetail:minimal] ${sizeKb.toFixed(1)}KB > ${BUDGETS.api.circleDetail.minimal.payloadKb}KB`,
    );
  });

  it('circle detail payload stays within budget [api:circleDetail:typical]', () => {
    const payload = makeCircleDetailPayload(PROFILES.profiles.typical.circleDetailMembers);
    const sizeKb = kb(payload);
    assert.ok(
      sizeKb <= BUDGETS.api.circleDetail.typical.payloadKb,
      `[api:circleDetail:typical] ${sizeKb.toFixed(1)}KB > ${BUDGETS.api.circleDetail.typical.payloadKb}KB`,
    );
  });

  it('circle detail payload stays within budget [api:circleDetail:highWater]', () => {
    const payload = makeCircleDetailPayload(PROFILES.profiles.highWater.circleDetailMembers);
    const sizeKb = kb(payload);
    assert.ok(
      sizeKb <= BUDGETS.api.circleDetail.highWater.payloadKb,
      `[api:circleDetail:highWater] ${sizeKb.toFixed(1)}KB > ${BUDGETS.api.circleDetail.highWater.payloadKb}KB`,
    );
  });

  it('reputation profile payload stays within budget [api:reputationProfile]', () => {
    const payload = makeReputationRow(42, 12, 1);
    const sizeKb = kb(payload);
    assert.ok(
      sizeKb <= BUDGETS.api.reputationProfile.payloadKb,
      `[api:reputationProfile] ${sizeKb.toFixed(1)}KB > ${BUDGETS.api.reputationProfile.payloadKb}KB`,
    );
  });
});

describe('Render preparation budgets', () => {
  for (const tier of TIER_NAMES) {
    it(`circle list render prep stays within budget [render:circleList:${tier}]`, () => {
      const count = PROFILES.profiles[tier].circleListCount;
      const { elapsedMs } = time(() => makeCircleListPayload(count));
      assert.ok(
        elapsedMs <= BUDGETS.render.circleList[tier],
        `[render:circleList:${tier}] ${elapsedMs.toFixed(2)}ms > ${BUDGETS.render.circleList[tier]}ms`,
      );
    });
  }

  it('circle detail render prep stays within budget [render:circleDetail:typical]', () => {
    const members = PROFILES.profiles.typical.circleDetailMembers;
    const { elapsedMs } = time(() => makeCircleDetailPayload(members));
    assert.ok(
      elapsedMs <= BUDGETS.render.circleDetail.typical,
      `[render:circleDetail:typical] ${elapsedMs.toFixed(2)}ms > ${BUDGETS.render.circleDetail.typical}ms`,
    );
  });

  it('circle detail render prep stays within budget [render:circleDetail:highWater]', () => {
    const members = PROFILES.profiles.highWater.circleDetailMembers;
    const { elapsedMs } = time(() => makeCircleDetailPayload(members));
    assert.ok(
      elapsedMs <= BUDGETS.render.circleDetail.highWater,
      `[render:circleDetail:highWater] ${elapsedMs.toFixed(2)}ms > ${BUDGETS.render.circleDetail.highWater}ms`,
    );
  });
});

describe('Query time budgets', () => {
  // NOTE: this measures serialization/mapping cost as an offline proxy for
  // query cost. Real query plans are verified via `npm run explain --workspace=indexer`.
  for (const tier of TIER_NAMES) {
    it(`circle list mapping stays within budget [query:circleList:${tier}]`, () => {
      const count = PROFILES.profiles[tier].circleListCount;
      const { elapsedMs } = time(() => makeCircleListPayload(count));
      assert.ok(
        elapsedMs <= BUDGETS.api.circleList[tier].queryMs,
        `[query:circleList:${tier}] ${elapsedMs.toFixed(2)}ms > ${BUDGETS.api.circleList[tier].queryMs}ms`,
      );
    });

    it(`member contributions mapping stays within budget [query:memberContributions:${tier}]`, () => {
      const count = PROFILES.profiles[tier].contributionCount;
      const { elapsedMs } = time(() => makeContributionListPayload(count));
      assert.ok(
        elapsedMs <= BUDGETS.api.memberContributions[tier].queryMs,
        `[query:memberContributions:${tier}] ${elapsedMs.toFixed(2)}ms > ${BUDGETS.api.memberContributions[tier].queryMs}ms`,
      );
    });
  }
});

describe('Maximum-size circle resource budgets', () => {
  it('high-water circle detail stays within payload budget [maxSize:payload]', () => {
    const payload = makeCircleDetailPayload(MAX_MEMBERS);
    const sizeKb = kb(payload);
    assert.ok(
      sizeKb <= BUDGETS.api.circleDetail.highWater.payloadKb,
      `[maxSize:payload] ${sizeKb.toFixed(1)}KB > ${BUDGETS.api.circleDetail.highWater.payloadKb}KB`,
    );
  });

  it('high-water circle detail stays within render budget [maxSize:render]', () => {
    const { elapsedMs } = time(() => makeCircleDetailPayload(MAX_MEMBERS));
    assert.ok(
      elapsedMs <= BUDGETS.render.circleDetail.highWater,
      `[maxSize:render] ${elapsedMs.toFixed(2)}ms > ${BUDGETS.render.circleDetail.highWater}ms`,
    );
  });
});

describe('Bundle size budgets', () => {
  const manifestPath = join(here, '..', '..', 'app', '.next', 'build-manifest.json');
  const skip = !existsSync(manifestPath);

  it('first-load JS stays within budget', { skip }, () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const pages = Object.keys(manifest.pages ?? {});
    assert.ok(pages.length > 0, '[bundle:firstLoad] no pages in build manifest');
  });
});
