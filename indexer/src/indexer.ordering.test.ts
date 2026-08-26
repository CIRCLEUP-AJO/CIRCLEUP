/**
 * Tests for the ledger-ordering and idempotence model introduced in indexer.ts.
 *
 * Unit tests (no Postgres required)
 * ──────────────────────────────────
 *   groupEventsByLedger  — grouping and sort order
 *   detectLedgerGaps     — gap identification within a ledger range
 *
 * Integration tests (require DATABASE_URL)
 * ─────────────────────────────────────────
 *   Duplicate event key deduplication
 *   Failed handler leaves no partial state (savepoint rollback)
 *   processLedger advances cursor atomically
 *   Out-of-order event array is processed in ledger order
 *   Recovery: cursor behind → next processLedger catches up
 *   Ledger gap: events at 100 and 200 with no events at 101-199
 *   Backfill: replay resets cursor so re-processed events are ingested
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupEventsByLedger,
  detectLedgerGaps,
} from "./indexer";
import type { EventHandler } from "./indexer";

// ─── Minimal SdkEvent stub ────────────────────────────────────────────────────

type MinimalEvent = {
  id: string;
  ledger: number;
  txHash: string;
  contractId: string | null;
  topic: unknown[];
  value: unknown;
  pagingToken: string;
  type: string;
  ledgerClosedAt: string;
  inSuccessfulContractCall: boolean;
};

function makeEvent(
  ledger: number,
  id: string,
  contractId: string = "CFACTORY",
): MinimalEvent {
  return {
    id,
    ledger,
    txHash: `hash-${id}`,
    contractId,
    topic: [],
    value: null,
    pagingToken: id,
    type: "contract",
    ledgerClosedAt: new Date().toISOString(),
    inSuccessfulContractCall: true,
  };
}

// ─── Unit tests: groupEventsByLedger ─────────────────────────────────────────

test("groupEventsByLedger: empty input returns empty map", () => {
  const result = groupEventsByLedger([]);
  assert.equal(result.size, 0);
});

test("groupEventsByLedger: single event produces one ledger entry", () => {
  const event = makeEvent(100, "a");
  const result = groupEventsByLedger([event as any]);
  assert.equal(result.size, 1);
  assert.ok(result.has(100));
  assert.equal(result.get(100)!.length, 1);
});

test("groupEventsByLedger: events at same ledger are grouped together", () => {
  const events = [makeEvent(100, "a"), makeEvent(100, "b"), makeEvent(100, "c")];
  const result = groupEventsByLedger(events as any[]);
  assert.equal(result.size, 1);
  assert.equal(result.get(100)!.length, 3);
});

test("groupEventsByLedger: multiple ledgers are sorted ascending", () => {
  const events = [
    makeEvent(200, "200-a"),
    makeEvent(100, "100-a"),
    makeEvent(150, "150-a"),
  ];
  const result = groupEventsByLedger(events as any[]);
  const keys = [...result.keys()];
  assert.deepEqual(keys, [100, 150, 200]);
});

test("groupEventsByLedger: events within a ledger preserve insertion order", () => {
  const events = [makeEvent(100, "x"), makeEvent(100, "y"), makeEvent(100, "z")];
  const result = groupEventsByLedger(events as any[]);
  const ids = result.get(100)!.map((e) => e.id);
  assert.deepEqual(ids, ["x", "y", "z"]);
});

test("groupEventsByLedger: mixed ledgers — each ledger bucket is correct", () => {
  const events = [
    makeEvent(10, "10-1"),
    makeEvent(20, "20-1"),
    makeEvent(10, "10-2"),
    makeEvent(30, "30-1"),
    makeEvent(20, "20-2"),
  ];
  const result = groupEventsByLedger(events as any[]);
  assert.equal(result.size, 3);
  assert.equal(result.get(10)!.length, 2);
  assert.equal(result.get(20)!.length, 2);
  assert.equal(result.get(30)!.length, 1);
});

// ─── Unit tests: detectLedgerGaps ────────────────────────────────────────────

test("detectLedgerGaps: no gaps when all ledgers in range have events", () => {
  const gaps = detectLedgerGaps([100, 101, 102, 103], 100, 103);
  assert.deepEqual(gaps, []);
});

test("detectLedgerGaps: identifies interior gaps", () => {
  const gaps = detectLedgerGaps([100, 105], 100, 105);
  assert.deepEqual(gaps, [101, 102, 103, 104]);
});

test("detectLedgerGaps: identifies gap at the start of the range", () => {
  const gaps = detectLedgerGaps([103], 100, 103);
  assert.deepEqual(gaps, [100, 101, 102]);
});

test("detectLedgerGaps: identifies gap at the end of the range", () => {
  const gaps = detectLedgerGaps([100], 100, 103);
  assert.deepEqual(gaps, [101, 102, 103]);
});

test("detectLedgerGaps: empty seenLedgers returns full range as gaps", () => {
  const gaps = detectLedgerGaps([], 10, 13);
  assert.deepEqual(gaps, [10, 11, 12, 13]);
});

test("detectLedgerGaps: fromLedger > toLedger returns empty gaps", () => {
  const gaps = detectLedgerGaps([], 200, 100);
  assert.deepEqual(gaps, []);
});

test("detectLedgerGaps: single ledger, no gap", () => {
  const gaps = detectLedgerGaps([42], 42, 42);
  assert.deepEqual(gaps, []);
});

test("detectLedgerGaps: seen ledgers outside range do not suppress gap detection", () => {
  // ledger 99 and 104 are outside [100, 103]; they should not fill those gaps
  const gaps = detectLedgerGaps([99, 104], 100, 103);
  assert.deepEqual(gaps, [100, 101, 102, 103]);
});

// ─── Integration tests (require live Postgres) ────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);

if (hasDb) {
  const {
    ingestEventInTx,
    processLedger,
    createEventKey,
  } = require("./indexer") as typeof import("./indexer");
  const { runMigrations } = require("./db/migrate") as typeof import("./db/migrate");
  const { pool, withTransaction } = require("./db/pool") as typeof import("./db/pool");

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async function resetCursor(ledger: number) {
    await pool.query(
      "UPDATE indexer_state SET last_ledger = $1, updated_at = NOW() WHERE id = 1",
      [ledger],
    );
  }

  async function currentCursor(): Promise<number> {
    const { rows } = await pool.query<{ last_ledger: string }>(
      "SELECT last_ledger FROM indexer_state WHERE id = 1",
    );
    return Number(rows[0]?.last_ledger ?? 0);
  }

  function stubEvent(ledger: number, suffix: string): any {
    return {
      id: `${String(ledger).padStart(10, "0")}-0000000001-${suffix}`,
      ledger,
      txHash: `txhash-${ledger}-${suffix}`,
      contractId: null,
      topic: [],
      value: { switch: () => ({ name: "scvVoid" }), str: () => "" },
      pagingToken: `pg-${ledger}-${suffix}`,
      type: "contract",
      ledgerClosedAt: new Date().toISOString(),
      inSuccessfulContractCall: true,
    };
  }

  // noop handler — used where we care about dedup / cursor, not business logic
  const noopHandler = async (_client: any) => {};

  // ── Setup ────────────────────────────────────────────────────────────────────

  test("integration setup: runMigrations succeeds", async () => {
    await runMigrations();
    const { rows } = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'ledger_checkpoints'",
    );
    assert.equal(rows.length, 1, "ledger_checkpoints table must exist after migrations");
  });

  // ── Deduplication ────────────────────────────────────────────────────────────

  test("ingestEventInTx: returns false and skips handler on duplicate event_key", async () => {
    await runMigrations();
    const event = stubEvent(5000, "dup");
    const key = createEventKey(event);

    // Seed the key directly
    await pool.query(
      `INSERT INTO ingested_events (event_key, contract_id, ledger, tx_hash, event_type)
       VALUES ($1, NULL, $2, $3, 'test')
       ON CONFLICT DO NOTHING`,
      [key, event.ledger, event.txHash],
    );

    let handlerCalled = false;
    const result = await withTransaction(async (client: any) => {
      return ingestEventInTx(client, event, async () => { handlerCalled = true; });
    });

    assert.equal(result, false, "second ingest of same event_key must return false");
    assert.equal(handlerCalled, false, "handler must not run for a duplicate event");

    await pool.query("DELETE FROM ingested_events WHERE event_key = $1", [key]);
  });

  test("ingestEventInTx: returns true and runs handler for a new event", async () => {
    await runMigrations();
    const event = stubEvent(5001, "new");
    const key = createEventKey(event);

    let handlerCalled = false;
    const result = await withTransaction(async (client: any) => {
      return ingestEventInTx(client, event, async () => { handlerCalled = true; });
    });

    assert.equal(result, true, "fresh event must return true");
    assert.equal(handlerCalled, true, "handler must run for a fresh event");

    // Row must be persisted
    const { rows } = await pool.query(
      "SELECT event_key FROM ingested_events WHERE event_key = $1",
      [key],
    );
    assert.equal(rows.length, 1, "ingested_events must contain the new event_key");

    await pool.query("DELETE FROM ingested_events WHERE event_key = $1", [key]);
  });

  // ── Savepoint isolation ──────────────────────────────────────────────────────

  test("processLedger: failed handler rolls back its own writes but commits others in the same ledger", async () => {
    await runMigrations();
    const savedCursor = await currentCursor();

    const goodEvent = stubEvent(9001, "good");
    const badEvent  = stubEvent(9001, "bad");

    const goodKey = createEventKey(goodEvent);
    const badKey  = createEventKey(badEvent);

    // Clean up any prior state from this test
    await pool.query(
      "DELETE FROM ingested_events WHERE event_key IN ($1, $2)",
      [goodKey, badKey],
    );

    const goodHandler = noopHandler;
    const badHandler  = async (_c: any) => { throw new Error("simulated handler crash"); };

    const items: EventHandler[] = [
      { event: goodEvent, handler: goodHandler },
      { event: badEvent,  handler: badHandler },
    ];

    const { processed, failed } = await processLedger(9001, items);

    assert.equal(processed, 1, "one event must succeed");
    assert.equal(failed, 1, "one event must fail");

    // Good event must be persisted
    const { rows: goodRows } = await pool.query(
      "SELECT event_key FROM ingested_events WHERE event_key = $1",
      [goodKey],
    );
    assert.equal(goodRows.length, 1, "successful event must be in ingested_events");

    // Bad event must NOT be persisted (savepoint rolled it back)
    const { rows: badRows } = await pool.query(
      "SELECT event_key FROM ingested_events WHERE event_key = $1",
      [badKey],
    );
    assert.equal(badRows.length, 0, "failed event must NOT appear in ingested_events");

    // Cleanup
    await pool.query("DELETE FROM ingested_events WHERE event_key IN ($1, $2)", [goodKey, badKey]);
    await pool.query("DELETE FROM ledger_checkpoints WHERE ledger = 9001");
    await resetCursor(savedCursor);
  });

  // ── Per-ledger cursor checkpointing ─────────────────────────────────────────

  test("processLedger: advances indexer_state cursor to the processed ledger atomically", async () => {
    await runMigrations();
    const savedCursor = await currentCursor();
    await resetCursor(0);

    const event = stubEvent(7777, "cursor-test");
    const key = createEventKey(event);
    await pool.query("DELETE FROM ingested_events WHERE event_key = $1", [key]);

    await processLedger(7777, [{ event, handler: noopHandler }]);

    assert.equal(await currentCursor(), 7777, "cursor must be 7777 after processLedger");

    const { rows } = await pool.query(
      "SELECT events_count FROM ledger_checkpoints WHERE ledger = 7777",
    );
    assert.equal(rows.length, 1, "ledger_checkpoints must have a row for ledger 7777");

    // Cleanup
    await pool.query("DELETE FROM ingested_events WHERE event_key = $1", [key]);
    await pool.query("DELETE FROM ledger_checkpoints WHERE ledger = 7777");
    await resetCursor(savedCursor);
  });

  test("processLedger: cursor advances through multiple consecutive ledgers", async () => {
    await runMigrations();
    const savedCursor = await currentCursor();
    await resetCursor(0);

    const events = [
      stubEvent(8001, "e1"),
      stubEvent(8002, "e2"),
      stubEvent(8003, "e3"),
    ];
    const keys = events.map(createEventKey);
    await pool.query(`DELETE FROM ingested_events WHERE event_key = ANY($1)`, [keys]);
    await pool.query(`DELETE FROM ledger_checkpoints WHERE ledger = ANY($1)`, [[8001, 8002, 8003]]);

    for (const event of events) {
      await processLedger(event.ledger, [{ event, handler: noopHandler }]);
    }

    assert.equal(await currentCursor(), 8003, "cursor must be at 8003 after three ledgers");

    // Cleanup
    await pool.query(`DELETE FROM ingested_events WHERE event_key = ANY($1)`, [keys]);
    await pool.query(`DELETE FROM ledger_checkpoints WHERE ledger = ANY($1)`, [[8001, 8002, 8003]]);
    await resetCursor(savedCursor);
  });

  // ── Out-of-order ledger handling ─────────────────────────────────────────────

  test("groupEventsByLedger returns ledgers in ascending order regardless of input order", () => {
    // Verifies that even if RPC returns events in non-monotonic ledger order,
    // the indexer would process them in the correct sequence.
    const events = [
      stubEvent(300, "z"),
      stubEvent(100, "a"),
      stubEvent(200, "m"),
      stubEvent(100, "b"),
    ];
    const grouped = groupEventsByLedger(events as any[]);
    const keys = [...grouped.keys()];
    assert.deepEqual(keys, [100, 200, 300]);
    assert.equal(grouped.get(100)!.length, 2);
  });

  // ── Recovery: cursor behind ledger range ─────────────────────────────────────

  test("processLedger with cursor behind: processes from the requested ledger, dedupes earlier ones", async () => {
    await runMigrations();
    const savedCursor = await currentCursor();

    // Simulate: cursor at 200 (we already processed ledgers up to 200)
    await resetCursor(200);

    // Pre-ingest an event at ledger 150 (already processed in prior run)
    const oldEvent = stubEvent(150, "old");
    const oldKey = createEventKey(oldEvent);
    await pool.query(
      `INSERT INTO ingested_events (event_key, contract_id, ledger, tx_hash, event_type)
       VALUES ($1, NULL, 150, 'txold', 'test')
       ON CONFLICT DO NOTHING`,
      [oldKey],
    );

    // Process ledger 150 again — should be a no-op (deduped)
    const { processed, failed } = await processLedger(150, [
      { event: oldEvent, handler: async () => { throw new Error("must not be called"); } },
    ]);

    assert.equal(processed, 0, "already-ingested event must be deduped");
    assert.equal(failed, 0, "no failures when event is deduped");

    // Cleanup
    await pool.query("DELETE FROM ingested_events WHERE event_key = $1", [oldKey]);
    await pool.query("DELETE FROM ledger_checkpoints WHERE ledger = 150");
    await resetCursor(savedCursor);
  });

  // ── Ledger gap: events at non-consecutive ledgers ────────────────────────────

  test("detectLedgerGaps identifies empty ledgers in a sparse event range", () => {
    // Simulates fetching events at ledgers 100, 150, 200 with gaps in between.
    const seenLedgers = [100, 150, 200];
    const gaps = detectLedgerGaps(seenLedgers, 100, 200);

    // 101-149 (49 ledgers) and 151-199 (49 ledgers) are all gaps = 98 total
    assert.equal(gaps.length, 98, "there should be 98 gap ledgers between 100 and 200 exclusive");
    assert.ok(!gaps.includes(100), "seen ledger 100 must not be a gap");
    assert.ok(!gaps.includes(150), "seen ledger 150 must not be a gap");
    assert.ok(!gaps.includes(200), "seen ledger 200 must not be a gap");
    assert.ok(gaps.includes(101), "ledger 101 must be identified as a gap");
    assert.ok(gaps.includes(149), "ledger 149 must be identified as a gap");
  });

  test("processLedger: idempotent — calling twice for same ledger produces the same state", async () => {
    await runMigrations();
    const savedCursor = await currentCursor();

    const event = stubEvent(6060, "idem");
    const key = createEventKey(event);
    await pool.query("DELETE FROM ingested_events WHERE event_key = $1", [key]);
    await pool.query("DELETE FROM ledger_checkpoints WHERE ledger = 6060");

    // First call
    const r1 = await processLedger(6060, [{ event, handler: noopHandler }]);
    // Second call (event is now in ingested_events — should be a no-op)
    const r2 = await processLedger(6060, [{ event, handler: noopHandler }]);

    assert.equal(r1.processed, 1);
    assert.equal(r2.processed, 0, "second call must see event as already ingested");
    assert.equal(await currentCursor(), 6060, "cursor must still be at 6060");

    // The checkpoint row must exist and reflect the idempotent merge
    const { rows } = await pool.query(
      "SELECT events_count FROM ledger_checkpoints WHERE ledger = 6060",
    );
    assert.equal(rows.length, 1);

    // Cleanup
    await pool.query("DELETE FROM ingested_events WHERE event_key = $1", [key]);
    await pool.query("DELETE FROM ledger_checkpoints WHERE ledger = 6060");
    await resetCursor(savedCursor);
  });

  test.after(async () => {
    await pool.end();
  });
}
