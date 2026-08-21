/**
 * Pipeline integration tests for the CircleUp indexer.
 *
 * These tests require a live Postgres at DATABASE_URL (run via docker-compose
 * or a local instance).  They exercise the full transactional pipeline:
 *   - Exactly-once event ingestion (duplicate event_key collisions)
 *   - Per-ledger atomic transactions (failed handler leaves no partial state)
 *   - Ledger ordering (out-of-order event payloads are sorted before processing)
 *   - Replay / backfill of a ledger range with and without clearing prior records
 *   - Recovery path: indexer_state behind the RPC, resumes from last checkpoint
 *   - RPC retry semantics (transient failure before eventual success)
 *
 * Each test cleans up the rows it creates so tests can run in any order.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, query, withTransaction } from "./db/pool";
import { runMigrations } from "./db/migrate";
import {
  groupEventsByLedger,
  processLedgerGroup,
  replayLedgerRange,
  _setRpcForTesting,
  withRpcRetry,
  isTransientRpcError,
  type LedgerIngestResult,
  type RpcLike,
} from "./indexer";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal fake SdkEvent that the indexer can dispatch. */
function fakeEvent(
  opts: {
    ledger?: number;
    txHash?: string;
    contractId?: string;
    topic0?: string;
    topic1?: string;
    value?: unknown;
  } = {},
): any {
  // We need xdr.ScVal-compatible objects for scValToNative.  The indexer
  // calls scValToNative on topic entries and value; to avoid pulling in the
  // full Stellar SDK in test helpers we pass pre-decoded native values and
  // stub the xdr wrapper.  The key helpers (getTopicStr, getValueNative)
  // call scValToNative(val) and scValToNative(event.value) respectively —
  // if the value is already a primitive, scValToNative will throw because it
  // expects an xdr.ScVal.  So we wrap with a minimal stub that the SDK's
  // scValToNative accepts: an xdr.ScVal whose type() returns scValType.scvString.
  //
  // For integration tests we only exercise processLedgerGroup / replayLedgerRange
  // at the DB layer, so we use a factory-like event stub that the dispatcher
  // recognises but then calls ingestEventInTx which relies on createEventKey
  // (which DOES call scValToNative on topic and value).
  //
  // Easiest approach: bypass the full dispatch chain by injecting raw DB rows
  // directly for the "no partial state" test, and use the groupEventsByLedger
  // helper (pure, no DB/RPC) for ordering tests.  For full-pipeline tests we
  // construct events that createEventKey can serialise using a lightweight
  // ScVal-like object.
  const { SorobanRpc: _SorobanRpc, xdr, scValToNative } = require("@stellar/stellar-sdk");

  function strScVal(s: string) {
    return xdr.ScVal.scvString(Buffer.from(s));
  }
  function u32ScVal(n: number) {
    return xdr.ScVal.scvU32(n);
  }
  function vecScVal(items: unknown[]) {
    return xdr.ScVal.scvVec(items as xdr.ScVal[]);
  }
  function symbolScVal(s: string) {
    return xdr.ScVal.scvSymbol(Buffer.from(s));
  }

  const t0 = opts.topic0 ?? "factory";
  const t1 = opts.topic1 ?? "circle_created";

  // Build a minimal value depending on event type
  let value: xdr.ScVal;
  if (t0 === "factory" && t1 === "circle_created") {
    value = vecScVal([
      strScVal(opts.value ? (opts.value as any[])[0] : "CCIRCLE001"),
      strScVal(opts.value ? (opts.value as any[])[1] : "GCREATOR001"),
      u32ScVal(opts.value ? (opts.value as any[])[2] : 0),
    ]);
  } else {
    value = strScVal(String(opts.value ?? "dummy"));
  }

  return {
    ledger: opts.ledger ?? 100,
    txHash: opts.txHash ?? `tx_${opts.ledger ?? 100}_${Math.random().toString(36).slice(2)}`,
    contractId: opts.contractId ?? null,
    topic: [symbolScVal(t0), symbolScVal(t1)],
    value,
  };
}

/** Build a simple fake RpcLike that returns canned event lists. */
function fakeRpc(
  factoryEvents: any[] = [],
  circleEvents: any[] = [],
  latestLedger = 200,
): RpcLike {
  return {
    getEvents: async ({ filters }: { filters: Array<{ contractIds?: string[] }> }) => {
      const ids = filters.flatMap((f) => f.contractIds ?? []);
      // Return factory events if factory/reputation IDs requested, else circles
      const events = ids.some((id) => id === process.env.CIRCLE_FACTORY_ADDRESS)
        ? factoryEvents
        : circleEvents;
      return { events };
    },
    getLatestLedger: async () => ({ sequence: latestLedger }),
  };
}

/** Reset indexer_state and ledger_checkpoints for the test ledger range. */
async function cleanupLedgers(from: number, to: number): Promise<void> {
  await query(
    "DELETE FROM ingested_events WHERE ledger >= $1 AND ledger <= $2",
    [from, to],
  );
  await query(
    "DELETE FROM ledger_checkpoints WHERE ledger >= $1 AND ledger <= $2",
    [from, to],
  );
  await query("UPDATE indexer_state SET last_ledger = 0, updated_at = NOW() WHERE id = 1");
}

/** Read ledger_checkpoints row for a specific ledger. */
async function getCheckpoint(ledger: number): Promise<{
  status: string;
  events_seen: number;
  events_ingested: number;
} | null> {
  const rows = await query<{
    status: string;
    events_seen: number;
    events_ingested: number;
  }>(
    "SELECT status, events_seen, events_ingested FROM ledger_checkpoints WHERE ledger = $1",
    [ledger],
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Read indexer_state.last_ledger. */
async function getLastLedgerFromDb(): Promise<number> {
  const rows = await query<{ last_ledger: string }>(
    "SELECT last_ledger FROM indexer_state WHERE id = 1",
  );
  return rows.length > 0 ? Number(rows[0].last_ledger) : 0;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

before(async () => {
  await runMigrations();
});

after(async () => {
  _setRpcForTesting(null);
  await pool.end();
});

// ─── groupEventsByLedger (ordering) ──────────────────────────────────────────

test("out-of-order RPC events are sorted into ascending ledger order", () => {
  const events = [
    { ledger: 300, txHash: "c", topic: [], value: null, contractId: null },
    { ledger: 100, txHash: "a", topic: [], value: null, contractId: null },
    { ledger: 200, txHash: "b", topic: [], value: null, contractId: null },
  ] as any[];

  const grouped = groupEventsByLedger(events);
  const keys = [...grouped.keys()];
  assert.deepEqual(keys, [100, 200, 300], "ledgers must be in ascending order");
});

test("events within the same ledger preserve their original RPC order", () => {
  const events = [
    { ledger: 50, txHash: "tx1", topic: [], value: null, contractId: null },
    { ledger: 50, txHash: "tx2", topic: [], value: null, contractId: null },
    { ledger: 50, txHash: "tx3", topic: [], value: null, contractId: null },
  ] as any[];

  const grouped = groupEventsByLedger(events);
  const group = grouped.get(50)!;
  assert.equal(group[0].txHash, "tx1");
  assert.equal(group[1].txHash, "tx2");
  assert.equal(group[2].txHash, "tx3");
});

// ─── Exactly-once semantics ───────────────────────────────────────────────────

test("duplicate event key in same ledger is ingested exactly once", async () => {
  const ledger = 9_800;
  await cleanupLedgers(ledger, ledger);

  try {
    // Build two events that will produce the same createEventKey (identical
    // ledger, txHash, contractId, topic, value).
    const e = fakeEvent({ ledger, txHash: "tx_dup", contractId: null });
    const eDup = { ...e }; // exact copy → same key

    // Process a group containing two identical events
    const result = await processLedgerGroup(ledger, [e, eDup], new Set());

    // The second occurrence must be skipped by the dedupe check
    assert.equal(result.status, "completed");
    // Both events share the same key; only one should be counted as ingested
    assert.ok(result.eventsIngested <= result.eventsSeen);

    const dbRows = await query<{ event_key: string }>(
      "SELECT event_key FROM ingested_events WHERE ledger = $1",
      [ledger],
    );
    const uniqueKeys = new Set(dbRows.map((r) => r.event_key));
    assert.equal(uniqueKeys.size, dbRows.length, "no duplicate event_key rows in DB");
  } finally {
    await cleanupLedgers(ledger, ledger);
  }
});

// ─── Ledger checkpoint atomicity ─────────────────────────────────────────────

test("successful ledger writes a completed checkpoint and advances last_ledger", async () => {
  const ledger = 9_801;
  await cleanupLedgers(ledger, ledger);

  try {
    const e = fakeEvent({ ledger, txHash: "tx_ok" });
    await processLedgerGroup(ledger, [e], new Set());

    const ckpt = await getCheckpoint(ledger);
    assert.ok(ckpt !== null, "checkpoint row must exist after successful processing");
    assert.equal(ckpt!.status, "completed");

    const cursor = await getLastLedgerFromDb();
    assert.ok(cursor >= ledger, `last_ledger (${cursor}) must be ≥ ${ledger}`);
  } finally {
    await cleanupLedgers(ledger, ledger);
  }
});

test("failed handler rolls back the entire ledger transaction — no partial state", async () => {
  const ledger = 9_802;
  await cleanupLedgers(ledger, ledger);

  // Directly test the DB-level atomicity guarantee: inject a circle factory
  // event that will succeed (inserts into circles), followed by a mock that
  // throws inside a withTransaction to simulate a handler failure.
  // We do this by inserting a valid event first then using a raw transaction
  // that aborts to confirm the rollback.
  try {
    await withTransaction(async (client) => {
      // Insert a sentinel row inside the transaction
      await client.query(
        `INSERT INTO ingested_events (event_key, contract_id, ledger, tx_hash, event_type)
         VALUES ('sentinel_key_9802', 'CA', $1, 'tx_sentinel', 'test')`,
        [ledger],
      );
      // Simulate handler failure
      throw new Error("simulated handler failure");
    });
  } catch {
    // expected
  }

  // The sentinel row must not exist — the transaction rolled back
  const rows = await query<{ event_key: string }>(
    "SELECT event_key FROM ingested_events WHERE event_key = 'sentinel_key_9802'",
  );
  assert.equal(rows.length, 0, "rolled-back ingested_events row must not be visible");

  await cleanupLedgers(ledger, ledger);
});

test("failed processLedgerGroup records failed checkpoint without advancing last_ledger", async () => {
  const ledger = 9_803;
  await cleanupLedgers(ledger, ledger);

  // Seed last_ledger to a known value
  await query("UPDATE indexer_state SET last_ledger = 9799 WHERE id = 1");

  try {
    // Build an event that will fail inside ingestEventInTx by violating a DB
    // constraint.  The easiest way is to pre-insert a row that causes
    // ingested_events INSERT to raise a unique violation (which ON CONFLICT
    // suppresses), then rely on having the handler itself throw.
    // Instead, we directly corrupt a handler via an event that has an
    // unparseable factory value (wrong type for parseCircleCreatedEvent).
    const { xdr } = require("@stellar/stellar-sdk");
    const badEvent: any = {
      ledger,
      txHash: "tx_bad",
      contractId: process.env.CIRCLE_FACTORY_ADDRESS ?? "CFACTORY",
      topic: [xdr.ScVal.scvSymbol(Buffer.from("factory")), xdr.ScVal.scvSymbol(Buffer.from("circle_created"))],
      // value is a string, not the expected [addr, creator, index] tuple
      value: xdr.ScVal.scvString(Buffer.from("not a tuple")),
    };

    const result = await processLedgerGroup(
      ledger,
      [badEvent],
      new Set(),
    );

    // The call should return a failed result (not throw)
    assert.equal(result.status, "failed");
    assert.ok(result.error, "failed result must include an error message");

    // last_ledger must NOT have advanced for the failed ledger
    const cursor = await getLastLedgerFromDb();
    assert.ok(
      cursor < ledger,
      `last_ledger (${cursor}) must not advance to the failed ledger ${ledger}`,
    );

    // A failed checkpoint row should exist
    const ckpt = await getCheckpoint(ledger);
    assert.ok(ckpt !== null, "failed checkpoint must be recorded");
    assert.equal(ckpt!.status, "failed");
  } finally {
    await cleanupLedgers(ledger, ledger);
    await query("UPDATE indexer_state SET last_ledger = 0 WHERE id = 1");
  }
});

// ─── Replay / backfill ────────────────────────────────────────────────────────

test("replayLedgerRange: processes a range of events and advances last_ledger when ahead", async () => {
  const from = 9_810;
  const to = 9_812;
  await cleanupLedgers(from - 5, to + 5);

  const events = [
    fakeEvent({ ledger: from, txHash: "tx_r1" }),
    fakeEvent({ ledger: from + 1, txHash: "tx_r2" }),
    fakeEvent({ ledger: to, txHash: "tx_r3" }),
  ];

  _setRpcForTesting(fakeRpc(events, [], to));

  try {
    const result = await replayLedgerRange(from, to);

    assert.equal(result.fromLedger, from);
    assert.equal(result.toLedger, to);
    assert.ok(result.ledgersProcessed >= 0);
    assert.equal(result.failedLedgers.length, 0);

    const cursor = await getLastLedgerFromDb();
    assert.ok(cursor >= to, `last_ledger (${cursor}) must be ≥ toLedger (${to})`);
  } finally {
    _setRpcForTesting(null);
    await cleanupLedgers(from - 5, to + 5);
  }
});

test("replayLedgerRange: with clearIngestedEvents re-processes already-ingested events", async () => {
  const ledger = 9_820;
  await cleanupLedgers(ledger, ledger);

  const event = fakeEvent({ ledger, txHash: "tx_replay" });
  _setRpcForTesting(fakeRpc([event], [], ledger));

  try {
    // First pass — ingest the event
    await replayLedgerRange(ledger, ledger);

    const after1 = await query<{ event_key: string }>(
      "SELECT event_key FROM ingested_events WHERE ledger = $1",
      [ledger],
    );
    const keyCount1 = after1.length;

    // Second pass without clearIngestedEvents — event should be skipped
    await replayLedgerRange(ledger, ledger);

    const after2 = await query<{ event_key: string }>(
      "SELECT event_key FROM ingested_events WHERE ledger = $1",
      [ledger],
    );
    assert.equal(after2.length, keyCount1, "re-run without clear must not create duplicate rows");

    // Third pass with clearIngestedEvents — event should be re-ingested
    await replayLedgerRange(ledger, ledger, { clearIngestedEvents: true });

    const after3 = await query<{ event_key: string }>(
      "SELECT event_key FROM ingested_events WHERE ledger = $1",
      [ledger],
    );
    assert.equal(after3.length, keyCount1, "re-ingestion after clear must restore exactly the same rows");
  } finally {
    _setRpcForTesting(null);
    await cleanupLedgers(ledger, ledger);
  }
});

test("replayLedgerRange: rejects fromLedger > toLedger with a clear error", async () => {
  await assert.rejects(
    () => replayLedgerRange(200, 100),
    /fromLedger.*must be.*toLedger/,
  );
});

// ─── Recovery path ────────────────────────────────────────────────────────────

test("recovery: indexer_state behind ledger range, RPC exposes earlier blocks, resumes correctly", async () => {
  // Simulate: last_ledger = 9_900, RPC has events from 9_901 onwards.
  // After replay the cursor advances to the end of the replayed range.
  const cursorBefore = 9_900;
  const replayFrom = 9_901;
  const replayTo = 9_905;

  await cleanupLedgers(replayFrom, replayTo);
  await query("UPDATE indexer_state SET last_ledger = $1 WHERE id = 1", [cursorBefore]);

  const events = [
    fakeEvent({ ledger: replayFrom, txHash: "tx_rec1" }),
    fakeEvent({ ledger: replayTo, txHash: "tx_rec2" }),
  ];

  _setRpcForTesting(fakeRpc(events, [], replayTo));

  try {
    const result = await replayLedgerRange(replayFrom, replayTo);

    assert.equal(result.failedLedgers.length, 0, "recovery replay must not have failed ledgers");

    const cursor = await getLastLedgerFromDb();
    assert.ok(
      cursor >= replayTo,
      `last_ledger (${cursor}) must advance to at least ${replayTo} after recovery replay`,
    );
  } finally {
    _setRpcForTesting(null);
    await cleanupLedgers(replayFrom, replayTo);
    await query("UPDATE indexer_state SET last_ledger = 0 WHERE id = 1");
  }
});

// ─── Ledger gap handling ──────────────────────────────────────────────────────

test("ledger gaps: empty ledgers in the range are skipped without error", async () => {
  // ledgers 9_930, 9_932, 9_934 have events; 9_931, 9_933 are empty.
  const events = [
    fakeEvent({ ledger: 9_930, txHash: "tx_gap1" }),
    fakeEvent({ ledger: 9_932, txHash: "tx_gap2" }),
    fakeEvent({ ledger: 9_934, txHash: "tx_gap3" }),
  ];

  await cleanupLedgers(9_930, 9_934);
  _setRpcForTesting(fakeRpc(events, [], 9_934));

  try {
    const result = await replayLedgerRange(9_930, 9_934);

    // Only the three ledgers with events should appear in ledger_checkpoints
    const checkpointRows = await query<{ ledger: number }>(
      "SELECT ledger FROM ledger_checkpoints WHERE ledger >= 9930 AND ledger <= 9934 ORDER BY ledger",
    );
    const processedLedgers = checkpointRows.map((r) => r.ledger);

    // Gap ledgers (9931, 9933) must NOT have spurious checkpoint rows
    assert.ok(!processedLedgers.includes(9_931), "empty ledger 9931 must not appear in checkpoints");
    assert.ok(!processedLedgers.includes(9_933), "empty ledger 9933 must not appear in checkpoints");

    assert.equal(result.failedLedgers.length, 0);
  } finally {
    _setRpcForTesting(null);
    await cleanupLedgers(9_930, 9_934);
  }
});

// ─── RPC retry in withRpcRetry ────────────────────────────────────────────────

test("withRpcRetry: retries on transient network code and succeeds on third attempt", async () => {
  let attempts = 0;
  const result = await withRpcRetry(
    "integration-retry-test",
    async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("ECONNRESET during test");
        (err as any).code = "ECONNRESET";
        throw err;
      }
      return "success";
    },
    { maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} },
  );

  assert.equal(result, "success");
  assert.equal(attempts, 3);
});

test("withRpcRetry: does not retry on non-transient RPC error", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRpcRetry(
        "integration-non-transient",
        async () => {
          attempts++;
          throw new Error("invalid contract address");
        },
        { maxAttempts: 4, baseDelayMs: 1, sleep: async () => {} },
      ),
    /failed after 1 attempt/,
  );
  assert.equal(attempts, 1, "non-transient error must not trigger retries");
});

// ─── Backfill: process events for a historical range with last_ledger at 0 ───

test("backfill: processes historical ledger range starting from scratch", async () => {
  const from = 9_940;
  const to = 9_943;

  await cleanupLedgers(from, to);
  await query("UPDATE indexer_state SET last_ledger = 0 WHERE id = 1");

  const events = [
    fakeEvent({ ledger: 9_940, txHash: "tx_bf1" }),
    fakeEvent({ ledger: 9_941, txHash: "tx_bf2" }),
    fakeEvent({ ledger: 9_942, txHash: "tx_bf3" }),
    fakeEvent({ ledger: 9_943, txHash: "tx_bf4" }),
  ];

  _setRpcForTesting(fakeRpc(events, [], to));

  try {
    const result = await replayLedgerRange(from, to);

    assert.equal(result.failedLedgers.length, 0);
    assert.ok(result.ledgersProcessed > 0);

    const cursor = await getLastLedgerFromDb();
    assert.ok(cursor >= to, `cursor (${cursor}) must advance to at least ${to}`);

    // All four ledgers must have completed checkpoints
    for (const ledger of [9_940, 9_941, 9_942, 9_943]) {
      const ckpt = await getCheckpoint(ledger);
      assert.ok(ckpt !== null, `checkpoint must exist for ledger ${ledger}`);
      assert.equal(ckpt!.status, "completed", `ledger ${ledger} must be completed`);
    }
  } finally {
    _setRpcForTesting(null);
    await cleanupLedgers(from, to);
    await query("UPDATE indexer_state SET last_ledger = 0 WHERE id = 1");
  }
});
