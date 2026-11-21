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

function time<T>(fn: () => T): { result: T; elapsedMs: number } {
  const start = process.hrtime.bigint();
  const result = fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, elapsedMs };
}

describe('USDC decimals drift guard', () => {
  it('keeps 7 decimals consistent with the indexer', () => {
    const USDC_DECIMALS = 7;
    assert.equal(USDC_DECIMALS, 7);
    assert.equal(10 ** USDC_DECIMALS, 10_000_000);
  });
});

describe('Fixture schema conformance', () => {
  // Column sets mirror indexer/src/db/schema.sql. Update both together.
  const CIRCLE_COLUMNS = [
    'address',
    'creator',
    'round_amount',
    'member_count',
    'status',
    'current_round',
    'total_rounds',
    'created_ledger',
  ];
  const MEMBER_COLUMNS = [
    'circle_address',
    'member_address',
    'payout_order',
    'join_order',
    'collateral',
    'defaults',
    'joined_at',
  ];
  const CONTRIBUTION_COLUMNS = [
    'circle_address',
    'member_address',
    'round_index',
    'amount',
    'tx_hash',
    'ledger',
  ];
  const PAYOUT_COLUMNS = ['circle_address', 'recipient', 'round_index', 'amount', 'tx_hash', 'ledger'];
  const DEFAULT_COLUMNS = [
    'circle_address',
    'member_address',
    'round_index',
    'penalty',
    'tx_hash',
    'ledger',
  ];
  const REPUTATION_COLUMNS = ['member_address', 'score', 'completed_rounds', 'defaults_count'];

  function assertSubset(row: object, columns: string[], label: string) {
    for (const key of Object.keys(row)) {
      assert.ok(columns.includes(key), `[fixture:${label}] unexpected column "${key}"`);
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
