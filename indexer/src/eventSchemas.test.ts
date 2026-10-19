/**
 * Event schema, fixture and projection-agreement tests (Issues #687, #691).
 *
 * Every fixture in src/fixtures/event-fixtures.ts is:
 *   1. classified directly from its native-decoded values (classifyEvent), and
 *   2. encoded to real xdr.ScVal topics/data, decoded again by the indexer's
 *      own routing (routeEvent → classifySdkEvent), and — when projected —
 *      run against a recording Postgres client so the SQL parameters can be
 *      compared field-by-field with the event payload.
 *
 * No database or RPC is needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeToScVal, xdr, type SorobanRpc } from "@stellar/stellar-sdk";
import type { PoolClient } from "pg";
import {
  EVENT_SCHEMAS,
  UnsupportedEventError,
  checkFieldKind,
  classifyEvent,
  getEventSchema,
} from "./eventSchemas";
import { routeEvent } from "./indexer";
import { buildFailureEvidence, classifyHandlerError } from "./eventFailures";
import {
  ALL_EVENT_FIXTURES,
  COMPATIBLE_VARIANT_FIXTURES,
  FIXTURE_ALICE,
  FIXTURE_BOB,
  FIXTURE_CAROL,
  FIXTURE_CIRCLE,
  FIXTURE_LEDGER,
  FIXTURE_TX_HASH,
  QUARANTINED_VARIANT_FIXTURES,
  SUPPORTED_EVENT_FIXTURES,
  fixtureNativeData,
  fixtureNativeTopics,
  type EventFixture,
  type TypedValue,
} from "./fixtures/event-fixtures";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SdkEvent = SorobanRpc.Api.EventResponse;

function encode(t: TypedValue): xdr.ScVal {
  if (t.kind === "address_vec") {
    return xdr.ScVal.scvVec(
      (t.value as string[]).map((a) => nativeToScVal(a, { type: "address" })),
    );
  }
  return nativeToScVal(t.value, { type: t.kind });
}

function toSdkEvent(fixture: EventFixture): SdkEvent {
  const value = Array.isArray(fixture.data)
    ? xdr.ScVal.scvVec(fixture.data.map(encode))
    : encode(fixture.data);
  return {
    id: `${String(FIXTURE_LEDGER).padStart(13, "0")}-0000000001-0000000000`,
    type: "contract",
    ledger: FIXTURE_LEDGER,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    pagingToken: "1",
    inSuccessfulContractCall: true,
    txHash: FIXTURE_TX_HASH,
    contractId: fixture.contractId,
    topic: fixture.topics.map(encode),
    value,
  } as unknown as SdkEvent;
}

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function recordingClient(rowCount = 1): { client: PoolClient; calls: RecordedQuery[] } {
  const calls: RecordedQuery[] = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rowCount, rows: [] };
    },
  };
  return { client: client as unknown as PoolClient, calls };
}

function fixtureById(id: string): EventFixture {
  const found = ALL_EVENT_FIXTURES.find((fx) => fx.id === id);
  assert.ok(found, `fixture '${id}' must exist`);
  return found;
}

async function project(id: string, rowCount = 1): Promise<RecordedQuery[]> {
  const routed = routeEvent(toSdkEvent(fixtureById(id)));
  assert.ok(routed, `${id} must route to a handler`);
  const { client, calls } = recordingClient(rowCount);
  await routed.handler(client);
  return calls;
}

// ─── Registry coverage ────────────────────────────────────────────────────────

test("every registered schema has exactly one supported fixture", () => {
  for (const schema of EVENT_SCHEMAS) {
    const type = `${schema.family}/${schema.name}`;
    const matches = SUPPORTED_EVENT_FIXTURES.filter(
      (fx) => fx.topics[0].value === schema.family && fx.topics[1].value === schema.name,
    );
    assert.equal(matches.length, 1, `${type} needs one supported fixture, found ${matches.length}`);
    assert.equal(
      matches[0].expected,
      schema.handling,
      `${type} fixture expectation must match the schema's handling`,
    );
    assert.equal(matches[0].version, schema.version, `${type} fixture must use the newest version`);
  }
});

test("schema registry has no duplicate family/name entries", () => {
  const keys = EVENT_SCHEMAS.map((s) => `${s.family}/${s.name}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("optional (since > 1) fields only appear after all required fields", () => {
  for (const schema of EVENT_SCHEMAS) {
    if (!("tuple" in schema.data)) continue;
    let seenOptional = false;
    for (const field of schema.data.tuple) {
      const optional = (field.since ?? 1) > 1;
      if (seenOptional) {
        assert.ok(optional, `${schema.family}/${schema.name}: ${field.name} follows an optional field`);
      }
      seenOptional ||= optional;
    }
  }
});

// ─── Classification of native-decoded fixtures ───────────────────────────────

for (const fixture of ALL_EVENT_FIXTURES) {
  test(`classifyEvent: ${fixture.id} → ${fixture.expected}`, () => {
    const result = classifyEvent({
      topics: fixtureNativeTopics(fixture),
      data: fixtureNativeData(fixture),
      contractId: fixture.contractId,
    });
    assert.equal(result.status, fixture.expected, JSON.stringify(result, (_k, v) =>
      typeof v === "bigint" ? `${v}n` : v));
    if (fixture.version !== undefined && (result.status === "projected" || result.status === "ignored")) {
      assert.equal(result.version, fixture.version);
    }
  });
}

test("checkFieldKind: rejects wrong numeric kinds and empty strings", () => {
  assert.equal(checkFieldKind("u32", 1), null);
  assert.notEqual(checkFieldKind("u32", -1), null);
  assert.notEqual(checkFieldKind("u32", 1.5), null);
  assert.notEqual(checkFieldKind("u32", 1n), null);
  assert.equal(checkFieldKind("i128", -5n), null);
  assert.notEqual(checkFieldKind("u64", -5n), null);
  assert.notEqual(checkFieldKind("address", ""), null);
  assert.notEqual(checkFieldKind("address_vec", ["ok", 3]), null);
});

test("getEventSchema returns undefined for unregistered events", () => {
  assert.equal(getEventSchema("circle", "member_swapped"), undefined);
  assert.ok(getEventSchema("circle", "payout"));
});

// ─── Decoding through the indexer's routing ──────────────────────────────────

for (const fixture of [...SUPPORTED_EVENT_FIXTURES, ...COMPATIBLE_VARIANT_FIXTURES]) {
  test(`routeEvent: ${fixture.id} decodes from XDR and routes as ${fixture.expected}`, () => {
    const routed = routeEvent(toSdkEvent(fixture));
    if (fixture.expected === "ignored") {
      assert.equal(routed, null, "ignored events must not get a handler");
    } else {
      assert.ok(routed, "projected events must get a handler");
    }
  });
}

for (const fixture of QUARANTINED_VARIANT_FIXTURES) {
  test(`routeEvent: ${fixture.id} is quarantined, never projected`, async () => {
    const routed = routeEvent(toSdkEvent(fixture));
    assert.ok(routed, "quarantined events must stay visible (not dropped)");
    const { client, calls } = recordingClient();
    await assert.rejects(() => routed.handler(client), (err: unknown) => {
      assert.ok(err instanceof UnsupportedEventError);
      assert.match((err as Error).message, /^Quarantined/);
      return true;
    });
    assert.equal(calls.length, 0, "a quarantined event must not write any projection");
  });
}

test("quarantine errors are permanent and recorded as UnsupportedEventError evidence", async () => {
  const fixture = fixtureById("circle/payout with reordered fields");
  const event = toSdkEvent(fixture);
  const routed = routeEvent(event);
  assert.ok(routed);
  const { client } = recordingClient();
  const err = await routed.handler(client).then(
    () => assert.fail("expected the quarantine handler to throw"),
    (e: unknown) => e,
  );
  assert.equal(classifyHandlerError(err), "permanent");
  const evidence = buildFailureEvidence({
    event,
    contractId: fixture.contractId,
    eventType: "circle/payout",
    error: err,
  });
  assert.equal(evidence.errorName, "UnsupportedEventError");
  assert.equal(evidence.eventId, event.id);
});

// ─── Projection agreement (event fields → SQL parameters) ────────────────────

test("projection: factory/circle_created writes circle identity and creator", async () => {
  const [insert] = await project("factory/circle_created");
  assert.match(insert.text, /INSERT INTO circles/);
  assert.deepEqual(insert.values, [FIXTURE_CIRCLE, FIXTURE_ALICE, FIXTURE_LEDGER]);
  // initialized fires first in the same tx: creator must back-fill the placeholder.
  assert.match(insert.text, /WHERE circles\.creator = ''/);
});

test("projection: circle/initialized v2 writes config and one member row per rotation slot", async () => {
  const [circle, members, ...rest] = await project("circle/initialized v2");
  assert.match(circle.text, /INSERT INTO circles/);
  assert.deepEqual(circle.values, [FIXTURE_CIRCLE, "100000000", 3, FIXTURE_LEDGER]);
  assert.match(members.text, /INSERT INTO circle_members/);
  assert.match(members.text, /WITH ORDINALITY/);
  assert.deepEqual(members.values, [FIXTURE_CIRCLE, [FIXTURE_ALICE, FIXTURE_BOB, FIXTURE_CAROL]]);
  assert.equal(rest.length, 0);
});

test("projection: circle/initialized v1 writes config only (no rotation to project)", async () => {
  const calls = await project("circle/initialized v1 (historical)");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [FIXTURE_CIRCLE, "100000000", 3, FIXTURE_LEDGER]);
});

test("projection: circle/joined updates the member's join order and collateral", async () => {
  const [update] = await project("circle/joined");
  assert.match(update.text, /UPDATE circle_members/);
  assert.deepEqual(update.values, [FIXTURE_CIRCLE, FIXTURE_BOB, 2, "100000000"]);
});

test("projection: circle/joined fails visibly when no member row exists", async () => {
  await assert.rejects(() => project("circle/joined", 0), /no circle_members row/);
});

test("projection: circle/active sets status Active", async () => {
  const [update] = await project("circle/active");
  assert.match(update.text, /status = 'Active'/);
  assert.deepEqual(update.values, [FIXTURE_CIRCLE]);
});

test("projection: circle/contributed records member, round, exact amount and ledger context", async () => {
  const [insert] = await project("circle/contributed");
  assert.match(insert.text, /INSERT INTO contributions/);
  assert.deepEqual(insert.values, [FIXTURE_CIRCLE, FIXTURE_BOB, 0, "100000000", FIXTURE_TX_HASH, FIXTURE_LEDGER]);
});

test("projection: circle/contributed with an unknown trailing field projects the known fields", async () => {
  const [insert] = await project("circle/contributed with unknown trailing field");
  assert.deepEqual(insert.values, [FIXTURE_CIRCLE, FIXTURE_BOB, 0, "100000000", FIXTURE_TX_HASH, FIXTURE_LEDGER]);
});

test("projection: circle/payout records recipient/amount/round and advances current_round", async () => {
  const [insert, advance] = await project("circle/payout");
  assert.match(insert.text, /INSERT INTO payouts/);
  assert.deepEqual(insert.values, [FIXTURE_CIRCLE, FIXTURE_ALICE, 0, "300000000", FIXTURE_TX_HASH, FIXTURE_LEDGER]);
  assert.match(advance.text, /current_round/);
  assert.deepEqual(advance.values, [1, FIXTURE_CIRCLE]);
});

test("projection: circle/default records penalty and increments the member's defaults", async () => {
  const [insert, increment] = await project("circle/default");
  assert.match(insert.text, /INSERT INTO defaults/);
  assert.deepEqual(insert.values, [FIXTURE_CIRCLE, FIXTURE_CAROL, 1, "20000000", FIXTURE_TX_HASH, FIXTURE_LEDGER]);
  assert.match(increment.text, /defaults = defaults \+ 1/);
  assert.deepEqual(increment.values, [FIXTURE_CIRCLE, FIXTURE_CAROL]);
});

test("projection: circle/round_started sets current_round to the new round", async () => {
  const [update] = await project("circle/round_started");
  assert.deepEqual(update.values, [1, FIXTURE_CIRCLE]);
});

test("projection: circle/exceptional_settlement flags the round's payout", async () => {
  const [insert] = await project("circle/exceptional_settlement");
  assert.match(insert.text, /is_exceptional/);
  assert.deepEqual(insert.values, [FIXTURE_CIRCLE, FIXTURE_BOB, 1, "200000000", FIXTURE_TX_HASH, FIXTURE_LEDGER, 1]);
});

test("projection: circle/completed sets status Completed", async () => {
  const [update] = await project("circle/completed");
  assert.match(update.text, /status = 'Completed'/);
  assert.deepEqual(update.values, [FIXTURE_CIRCLE]);
});

test("projection: circle/cancelled sets status and writes an audit row with caller and ledger", async () => {
  const [update, audit] = await project("circle/cancelled");
  assert.match(update.text, /status = 'Cancelled'/);
  assert.match(audit.text, /circle_audit_events/);
  assert.deepEqual(audit.values, [FIXTURE_CIRCLE, FIXTURE_ALICE, String(FIXTURE_LEDGER), FIXTURE_TX_HASH]);
});

test("projection: circle/closed writes totals, reason and an audit row", async () => {
  const [update, audit] = await project("circle/closed");
  assert.match(update.text, /status = 'Closed'/);
  assert.deepEqual(update.values, [FIXTURE_CIRCLE, "280000000", "completed"]);
  assert.deepEqual(audit.values, [
    FIXTURE_CIRCLE,
    FIXTURE_ALICE,
    FIXTURE_LEDGER,
    FIXTURE_TX_HASH,
    "280000000",
    "300000000",
    "completed",
  ]);
});

test("projection: circle/paused and circle/resumed toggle the paused flag", async () => {
  const [paused] = await project("circle/paused");
  assert.match(paused.text, /paused = TRUE/);
  assert.deepEqual(paused.values, [FIXTURE_CIRCLE]);
  const [resumed] = await project("circle/resumed");
  assert.match(resumed.text, /paused = FALSE/);
  assert.deepEqual(resumed.values, [FIXTURE_CIRCLE]);
});

test("projection: reputation/score_updated upserts the member's score", async () => {
  const [upsert] = await project("reputation/score_updated");
  assert.match(upsert.text, /INSERT INTO reputation/);
  assert.deepEqual(upsert.values, [FIXTURE_ALICE, 7]);
});

test("projection: legacy reputation/increment reads the member from topic[2]", async () => {
  const [upsert] = await project("reputation/increment (legacy)");
  assert.deepEqual(upsert.values, [FIXTURE_ALICE, 6]);
});
