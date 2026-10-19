/**
 * Representative contract event fixtures (Issues #687 and #691).
 *
 * One `supported` fixture per entry in EVENT_SCHEMAS, in the exact
 * native-decoded shape the contracts emit today, plus `variant` fixtures for
 * shapes the indexer must quarantine instead of projecting.  The fixtures are
 * typed (each field carries its Soroban kind) so tests can encode them to
 * real `xdr.ScVal`s and push them through the same decode → classify →
 * project path the live poller uses.
 *
 * Maintenance rules (docs/EVENT_COMPATIBILITY.md, "Fixtures"):
 *   - Changing an emitted event in contracts/ requires updating its fixture
 *     here in the same PR.  eventSchemas.test.ts fails if a schema has no
 *     supported fixture.
 *   - Never edit a fixture to make a failing test pass without a schema
 *     version decision: a fixture that no longer classifies as `projected`
 *     means the change is breaking.
 *   - Keep historical shapes (e.g. initialized v1, reputation/increment) as
 *     fixtures for as long as the indexer must replay ledgers containing them.
 */

import { StrKey } from "@stellar/stellar-sdk";
import type { FieldKind } from "../eventSchemas";

// ─── Deterministic addresses ─────────────────────────────────────────────────

const contractAddr = (seed: number) => StrKey.encodeContract(Buffer.alloc(32, seed));
const accountAddr = (seed: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, seed));

export const FIXTURE_CIRCLE = contractAddr(1);
export const FIXTURE_OTHER_CIRCLE = contractAddr(2);
export const FIXTURE_FACTORY = contractAddr(3);
export const FIXTURE_REPUTATION = contractAddr(4);
export const FIXTURE_ALICE = accountAddr(10);
export const FIXTURE_BOB = accountAddr(11);
export const FIXTURE_CAROL = accountAddr(12);
export const FIXTURE_ADMIN = accountAddr(13);

export const FIXTURE_ROUND_AMOUNT = 100_000_000n; // 10 USDC
export const FIXTURE_LEDGER = 4_242;
export const FIXTURE_TX_HASH = "ab".repeat(32);

// ─── Fixture shape ───────────────────────────────────────────────────────────

/** A typed value: `kind` drives XDR encoding, `value` is the native decode. */
export interface TypedValue {
  kind: FieldKind;
  value: unknown;
}

export interface EventFixture {
  /** Unique, descriptive fixture name. */
  id: string;
  contractId: string;
  /** Topic values; topic[0] and topic[1] are symbols. */
  topics: TypedValue[];
  /** Tuple payload (array) or scalar payload (single TypedValue). */
  data: TypedValue[] | TypedValue;
  /** Expected classification. */
  expected: "projected" | "ignored" | "unknown" | "incompatible";
  /** Expected matched schema version (supported fixtures only). */
  version?: number;
}

const sym = (value: string): TypedValue => ({ kind: "symbol", value });
const addr = (value: string): TypedValue => ({ kind: "address", value });
const u32 = (value: number): TypedValue => ({ kind: "u32", value });
const u64 = (value: bigint): TypedValue => ({ kind: "u64", value });
const i128 = (value: bigint): TypedValue => ({ kind: "i128", value });
const addrVec = (value: string[]): TypedValue => ({ kind: "address_vec", value });

const circleTopics = (name: string) => [sym("circle"), sym(name)];

/** Native-decoded data payload of a fixture (what scValToNative returns). */
export function fixtureNativeData(fixture: EventFixture): unknown {
  return Array.isArray(fixture.data) ? fixture.data.map((d) => d.value) : fixture.data.value;
}

/** Native-decoded topics of a fixture. */
export function fixtureNativeTopics(fixture: EventFixture): unknown[] {
  return fixture.topics.map((t) => t.value);
}

// ─── Supported shapes (one per schema) ───────────────────────────────────────

export const SUPPORTED_EVENT_FIXTURES: EventFixture[] = [
  {
    id: "factory/circle_created",
    contractId: FIXTURE_FACTORY,
    topics: [sym("factory"), sym("circle_created")],
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_ALICE), u32(0)],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/initialized v2",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("initialized"),
    data: [
      addr(FIXTURE_CIRCLE),
      u32(3),
      i128(FIXTURE_ROUND_AMOUNT),
      addrVec([FIXTURE_ALICE, FIXTURE_BOB, FIXTURE_CAROL]),
    ],
    expected: "projected",
    version: 2,
  },
  {
    id: "circle/joined",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("joined"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_BOB), u32(2), i128(FIXTURE_ROUND_AMOUNT)],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/active",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("active"),
    data: [addr(FIXTURE_CIRCLE), u64(5_242n)],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/contributed",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("contributed"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_BOB), u32(0), i128(FIXTURE_ROUND_AMOUNT)],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/payout",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("payout"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_ALICE), i128(FIXTURE_ROUND_AMOUNT * 3n), u32(0)],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/default",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("default"),
    data: [
      addr(FIXTURE_CIRCLE),
      addr(FIXTURE_CAROL),
      i128(20_000_000n),
      u32(1),
      i128(80_000_000n),
    ],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/round_started",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("round_started"),
    data: [addr(FIXTURE_CIRCLE), u32(1), addr(FIXTURE_BOB), u64(6_242n)],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/exceptional_settlement",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("exceptional_settlement"),
    data: [
      addr(FIXTURE_CIRCLE),
      addr(FIXTURE_BOB),
      i128(FIXTURE_ROUND_AMOUNT * 2n),
      u32(1),
      u32(1),
    ],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/completed",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("completed"),
    data: [addr(FIXTURE_CIRCLE), u32(3)],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/cancelled",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("cancelled"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_ALICE), u32(FIXTURE_LEDGER)],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/collateral_released",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("collateral_released"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_ALICE), i128(FIXTURE_ROUND_AMOUNT)],
    expected: "ignored",
    version: 1,
  },
  {
    id: "circle/closed",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("closed"),
    data: [
      addr(FIXTURE_CIRCLE),
      addr(FIXTURE_ALICE),
      i128(280_000_000n),
      i128(300_000_000n),
      sym("completed"),
    ],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/paused",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("paused"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_ADMIN), u32(FIXTURE_LEDGER)],
    expected: "projected",
    version: 1,
  },
  {
    id: "circle/resumed",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("resumed"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_ADMIN), u32(FIXTURE_LEDGER + 10)],
    expected: "projected",
    version: 1,
  },
  {
    id: "reputation/score_updated",
    contractId: FIXTURE_REPUTATION,
    topics: [sym("reputation"), sym("score_updated")],
    data: [addr(FIXTURE_ALICE), u32(7)],
    expected: "projected",
    version: 1,
  },
  {
    id: "reputation/increment (legacy)",
    contractId: FIXTURE_REPUTATION,
    topics: [sym("reputation"), sym("increment"), addr(FIXTURE_ALICE)],
    data: u32(6),
    expected: "projected",
    version: 1,
  },
  {
    id: "reputation/caller_added",
    contractId: FIXTURE_REPUTATION,
    topics: [sym("reputation"), sym("caller_added")],
    data: addr(FIXTURE_CIRCLE),
    expected: "ignored",
    version: 1,
  },
  {
    id: "reputation/caller_removed",
    contractId: FIXTURE_REPUTATION,
    topics: [sym("reputation"), sym("caller_removed")],
    data: addr(FIXTURE_CIRCLE),
    expected: "ignored",
    version: 1,
  },
];

// ─── Historical and forward-compatible shapes ────────────────────────────────

export const COMPATIBLE_VARIANT_FIXTURES: EventFixture[] = [
  {
    // v1 contract builds: no trailing members field.
    id: "circle/initialized v1 (historical)",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("initialized"),
    data: [addr(FIXTURE_CIRCLE), u32(3), i128(FIXTURE_ROUND_AMOUNT)],
    expected: "projected",
    version: 1,
  },
  {
    // A future contract appends a field the indexer does not know yet:
    // trailing additions are backwards compatible and still project.
    id: "circle/contributed with unknown trailing field",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("contributed"),
    data: [
      addr(FIXTURE_CIRCLE),
      addr(FIXTURE_BOB),
      u32(0),
      i128(FIXTURE_ROUND_AMOUNT),
      u32(99),
    ],
    expected: "projected",
    version: 1,
  },
];

// ─── Shapes that must be quarantined ─────────────────────────────────────────

export const QUARANTINED_VARIANT_FIXTURES: EventFixture[] = [
  {
    id: "unknown circle event name",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("member_swapped"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_ALICE)],
    expected: "unknown",
  },
  {
    id: "unknown family from a watched contract",
    contractId: FIXTURE_FACTORY,
    topics: [sym("factory_v2"), sym("circle_created")],
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_ALICE), u32(0)],
    expected: "unknown",
  },
  {
    id: "single-topic event",
    contractId: FIXTURE_CIRCLE,
    topics: [sym("circle")],
    data: [addr(FIXTURE_CIRCLE)],
    expected: "unknown",
  },
  {
    // Fields reordered (round_index before amount) — a breaking change that
    // would silently swap amount and round if projected.
    id: "circle/payout with reordered fields",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("payout"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_ALICE), u32(0), i128(FIXTURE_ROUND_AMOUNT * 3n)],
    expected: "incompatible",
  },
  {
    id: "circle/contributed with a removed field",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("contributed"),
    data: [addr(FIXTURE_CIRCLE), addr(FIXTURE_BOB), u32(0)],
    expected: "incompatible",
  },
  {
    id: "circle/default with a bare scalar payload",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("default"),
    data: addr(FIXTURE_CAROL),
    expected: "incompatible",
  },
  {
    // Payload claims to be another circle: projecting it would attribute
    // the contribution to the wrong row.
    id: "circle/contributed attributed to a different circle",
    contractId: FIXTURE_CIRCLE,
    topics: circleTopics("contributed"),
    data: [addr(FIXTURE_OTHER_CIRCLE), addr(FIXTURE_BOB), u32(0), i128(FIXTURE_ROUND_AMOUNT)],
    expected: "incompatible",
  },
  {
    id: "reputation/increment without the member topic",
    contractId: FIXTURE_REPUTATION,
    topics: [sym("reputation"), sym("increment")],
    data: u32(6),
    expected: "incompatible",
  },
];

export const ALL_EVENT_FIXTURES: EventFixture[] = [
  ...SUPPORTED_EVENT_FIXTURES,
  ...COMPATIBLE_VARIANT_FIXTURES,
  ...QUARANTINED_VARIANT_FIXTURES,
];
