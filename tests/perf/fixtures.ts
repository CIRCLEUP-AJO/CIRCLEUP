/**
 * Deterministic, offline fixture builders for the performance budget suite.
 *
 * Maintenance rules:
 *  - Row shapes MUST mirror `indexer/src/db/schema.sql` (snake_case columns).
 *    When schema.sql changes, update this file in the same PR.
 *  - Never use real user records, live Stellar RPC, or production data.
 *  - Addresses are generated locally (see `contractAddress` / `accountAddress`)
 *    which mirror `StrKey.encodeContract` / `StrKey.encodeEd25519PublicKey`
 *    from `indexer/src/fixtures/event-fixtures.ts`. We cannot import
 *    `@stellar/stellar-sdk` here because the root perf suite runs under
 *    `node --experimental-strip-types --test` and cannot load workspace TS.
 */

export type Tier = 'small' | 'typical' | 'highWater';

/** Protocol MAX_MEMBERS constant (see contracts/circle). */
export const MAX_MEMBERS = 256;

export const TIERS: Record<Tier, { circles: number; members: number; contributions: number }> = {
  small: { circles: 10, members: 10, contributions: 10 },
  typical: { circles: 50, members: 32, contributions: 50 },
  highWater: { circles: 100, members: MAX_MEMBERS, contributions: 100 },
};

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Deterministic pseudo-random byte stream (xorshift32) — no crypto needed. */
function bytes(seed: number, length: number): number[] {
  let state = (seed * 2654435761) >>> 0 || 1;
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out.push(state & 0xff);
  }
  return out;
}

function base32Encode(data: number[]): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** StrKey-style contract address (C...), 56 chars. */
export function contractAddress(seed: number): string {
  return `C${base32Encode(bytes(seed + 1, 32)).slice(0, 55)}`;
}

/** StrKey-style ed25519 public key (G...), 56 chars. */
export function accountAddress(seed: number): string {
  return `G${base32Encode(bytes(seed + 7, 32)).slice(0, 55)}`;
}

export interface CircleRow {
  address: string;
  creator: string;
  round_amount: string;
  member_count: number;
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: number;
}

export interface CircleMemberRow {
  circle_address: string;
  member_address: string;
  payout_order: number;
  join_order: number;
  collateral: string;
  defaults: number;
  joined_at: string;
}

export interface ContributionRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: number;
}

export interface PayoutRow {
  circle_address: string;
  recipient: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: number;
}

export interface DefaultRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  penalty: string;
  tx_hash: string;
  ledger: number;
}

export interface ReputationRow {
  member_address: string;
  score: number;
  completed_rounds: number;
  defaults_count: number;
}

const STATUSES = ['open', 'active', 'completed'] as const;

export function makeCircleRow(i: number, tier: Tier = 'typical'): CircleRow {
  const totalRounds = TIERS[tier].members;
  return {
    address: contractAddress(i),
    creator: accountAddress(i),
    round_amount: String(50_000_000 + i * 1_000_000),
    member_count: totalRounds,
    status: STATUSES[i % STATUSES.length],
    current_round: i % totalRounds,
    total_rounds: totalRounds,
    created_ledger: 1_000_000 + i * 100,
  };
}

export function makeCircleMemberRow(
  circleAddress: string,
  i: number,
  tier: Tier = 'typical',
): CircleMemberRow {
  return {
    circle_address: circleAddress,
    member_address: accountAddress(i + 10_000),
    payout_order: i,
    join_order: i,
    collateral: '10000000',
    defaults: i % 5 === 0 ? 1 : 0,
    joined_at: new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
  };
}

export function makeContributionRow(i: number, tier: Tier = 'typical'): ContributionRow {
  return {
    circle_address: contractAddress(i % TIERS[tier].circles),
    member_address: accountAddress(i + 10_000),
    round_index: i % TIERS[tier].members,
    amount: '50000000',
    tx_hash: base32Encode(bytes(i + 99, 32)).slice(0, 64).toLowerCase(),
    ledger: 1_000_000 + i * 10,
  };
}

export function makePayoutRow(i: number, tier: Tier = 'typical'): PayoutRow {
  return {
    circle_address: contractAddress(i % TIERS[tier].circles),
    recipient: accountAddress(i + 10_000),
    round_index: i % TIERS[tier].members,
    amount: '50000000',
    tx_hash: base32Encode(bytes(i + 199, 32)).slice(0, 64).toLowerCase(),
    ledger: 1_000_000 + i * 10,
  };
}

export function makeDefaultRow(i: number, tier: Tier = 'typical'): DefaultRow {
  return {
    circle_address: contractAddress(i % TIERS[tier].circles),
    member_address: accountAddress(i + 10_000),
    round_index: i % TIERS[tier].members,
    penalty: '5000000',
    tx_hash: base32Encode(bytes(i + 299, 32)).slice(0, 64).toLowerCase(),
    ledger: 1_000_000 + i * 10,
  };
}

export function makeReputationRow(
  score: number,
  completedRounds: number,
  defaultsCount: number,
): ReputationRow {
  return {
    member_address: accountAddress(score + completedRounds),
    score,
    completed_rounds: completedRounds,
    defaults_count: defaultsCount,
  };
}

/** API-shaped circle detail payload (what the app renders). */
export function makeCircleDetailPayload(memberCount: number) {
  const circle = makeCircleRow(0, 'typical');
  return {
    ...circle,
    member_count: memberCount,
    total_rounds: memberCount,
    members: Array.from({ length: memberCount }, (_, i) =>
      makeCircleMemberRow(circle.address, i, 'typical'),
    ),
    contributions: Array.from({ length: memberCount }, (_, i) =>
      makeContributionRow(i, 'typical'),
    ),
  };
}

/** API-shaped circle list payload. */
export function makeCircleListPayload(count: number) {
  return {
    circles: Array.from({ length: count }, (_, i) => makeCircleRow(i, 'typical')),
    total: count,
  };
}

/** API-shaped contribution list payload. */
export function makeContributionListPayload(count: number) {
  return {
    contributions: Array.from({ length: count }, (_, i) => makeContributionRow(i, 'typical')),
    total: count,
  };
}
