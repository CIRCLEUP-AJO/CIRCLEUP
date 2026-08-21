import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runEventHandler,
  getIndexerMetrics,
  USDC,
  stopIndexer,
  isIndexerRunning,
  parseCircleCreatedEvent,
  groupEventsByLedger,
  isTransientRpcError,
  withRpcRetry,
  createEventKey,
} from "./indexer";

test("USDC is read from the validated USDC_ADDRESS env var, not left dangling", () => {
  assert.equal(USDC, process.env.USDC_ADDRESS);
  assert.ok(USDC && USDC.length > 0, "USDC_ADDRESS must be a non-empty string once config validation passes");
});

test("runEventHandler counts a successful handler and returns true", async () => {
  const before = getIndexerMetrics();

  const ok = await runEventHandler(async () => {}, {
    contractId: "CCIRCLE",
    topic: "circle/joined",
    ledger: 100,
  });

  assert.equal(ok, true);
  const after = getIndexerMetrics();
  assert.equal(after.totalEventsProcessed, before.totalEventsProcessed + 1);
  assert.equal(after.totalEventsFailed, before.totalEventsFailed);
});

test("runEventHandler isolates a throwing handler instead of propagating", async () => {
  const before = getIndexerMetrics();

  const ok = await runEventHandler(
    async () => {
      throw new Error("malformed event payload");
    },
    { contractId: "CCIRCLE", topic: "circle/contributed", ledger: 101, txHash: "deadbeef" },
  );

  assert.equal(ok, false);
  const after = getIndexerMetrics();
  assert.equal(after.totalEventsFailed, before.totalEventsFailed + 1);
  assert.equal(after.totalEventsProcessed, before.totalEventsProcessed);
});

test("stopIndexer is a safe no-op when the poller was never started", async () => {
  assert.equal(isIndexerRunning(), false);
  await assert.doesNotReject(() => stopIndexer());
  assert.equal(isIndexerRunning(), false);
});

// ─── parseCircleCreatedEvent — factory/circle_created field-mapping tests ─────
//
// These tests act as a contract between the on-chain event shape and the
// indexer.  If anyone changes the factory event data tuple they'll see these
// tests fail before the DB gets silently written with wrong data.

test("parseCircleCreatedEvent: parses well-formed tuple into named fields", () => {
  const result = parseCircleCreatedEvent([
    "CCIRCLEXXX",
    "GCREATORYYY",
    3,
  ]);

  assert.equal(result.circleAddress, "CCIRCLEXXX");
  assert.equal(result.creator, "GCREATORYYY");
  assert.equal(result.circleIndex, 3, "third element is circle_index, not round_deadline_ledgers");
});

test("parseCircleCreatedEvent: circle_index 0 is valid (first-ever circle)", () => {
  const result = parseCircleCreatedEvent(["CABC", "GDEF", 0]);
  assert.equal(result.circleIndex, 0);
});

test("parseCircleCreatedEvent: circle_index is distinct from round_deadline_ledgers", () => {
  // Regression guard: the previous handler aliased this field as
  // `roundDeadlineLedgers` which silently wrote a factory counter value into
  // the deadline column.  Ensure the parser returns the field under the correct
  // name and that a large realistic circle_index is preserved as-is.
  const largeIndex = 9999;
  const result = parseCircleCreatedEvent(["CABC", "GDEF", largeIndex]);
  assert.equal(result.circleIndex, largeIndex);
  // TypeScript: the returned object must NOT have a roundDeadlineLedgers field
  assert.equal(
    ("roundDeadlineLedgers" in result),
    false,
    "parsed result must not expose the old misnamed field",
  );
});

test("parseCircleCreatedEvent: throws on missing tuple elements", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["CABC", "GDEF"]),
    /expected data tuple/,
    "should throw a descriptive error when circle_index is absent",
  );
});

test("parseCircleCreatedEvent: throws on null/undefined input", () => {
  assert.throws(() => parseCircleCreatedEvent(null), /expected data tuple/);
  assert.throws(() => parseCircleCreatedEvent(undefined), /expected data tuple/);
});

test("parseCircleCreatedEvent: throws when circle_address is empty string", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["", "GDEF", 1]),
    /circle_address must be a non-empty string/,
  );
});

test("parseCircleCreatedEvent: throws when creator is empty string", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["CABC", "", 1]),
    /creator must be a non-empty string/,
  );
});

test("parseCircleCreatedEvent: throws when circle_index is negative", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["CABC", "GDEF", -1]),
    /circle_index must be a non-negative integer/,
  );
});

test("parseCircleCreatedEvent: throws when circle_index is not an integer", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["CABC", "GDEF", 1.5]),
    /circle_index must be a non-negative integer/,
  );
});

// ─── groupEventsByLedger ──────────────────────────────────────────────────────

function makeEvent(ledger: number, txHash = "deadbeef", extraTopic = "t"): any {
  return { ledger, txHash, contractId: "CA", topic: [extraTopic, "x"], value: 0 };
}

test("groupEventsByLedger: returns an empty Map for an empty input", () => {
  const result = groupEventsByLedger([]);
  assert.equal(result.size, 0);
});

test("groupEventsByLedger: groups events by ledger sequence", () => {
  const events = [makeEvent(100), makeEvent(102), makeEvent(100), makeEvent(101)];
  const result = groupEventsByLedger(events);

  assert.equal(result.size, 3);
  assert.equal(result.get(100)!.length, 2);
  assert.equal(result.get(101)!.length, 1);
  assert.equal(result.get(102)!.length, 1);
});

test("groupEventsByLedger: iterates in ascending ledger order regardless of input order", () => {
  const events = [makeEvent(300), makeEvent(100), makeEvent(200)];
  const result = groupEventsByLedger(events);
  const keys = [...result.keys()];
  assert.deepEqual(keys, [100, 200, 300]);
});

test("groupEventsByLedger: single-ledger input produces one group", () => {
  const events = [makeEvent(50), makeEvent(50), makeEvent(50)];
  const result = groupEventsByLedger(events);
  assert.equal(result.size, 1);
  assert.equal(result.get(50)!.length, 3);
});

test("groupEventsByLedger: preserves per-ledger event order from RPC", () => {
  const e1 = makeEvent(10, "tx1");
  const e2 = makeEvent(10, "tx2");
  const e3 = makeEvent(10, "tx3");
  const result = groupEventsByLedger([e1, e2, e3]);
  assert.deepEqual(result.get(10), [e1, e2, e3]);
});

// ─── createEventKey ───────────────────────────────────────────────────────────
//
// createEventKey calls scValToNative on both topic entries and value, so the
// stubs must be real xdr.ScVal objects (not plain JS values).

import { xdr as stellarXdr } from "@stellar/stellar-sdk";

function makeFullEvent(overrides: Partial<{
  ledger: number;
  txHash: string;
  contractId: string;
}> = {}): any {
  return {
    ledger: overrides.ledger ?? 42,
    txHash: overrides.txHash ?? "abc123",
    contractId: overrides.contractId ?? "CABC",
    // Empty topic array — topicParts joins to "" without calling scValToNative
    topic: [],
    // scvVoid() is the simplest valid xdr.ScVal; scValToNative returns null
    value: stellarXdr.ScVal.scvVoid(),
  };
}

test("createEventKey: identical inputs produce the same key", () => {
  const k1 = createEventKey(makeFullEvent());
  const k2 = createEventKey(makeFullEvent());
  assert.equal(k1, k2);
});

test("createEventKey: different ledgers produce different keys", () => {
  const k1 = createEventKey(makeFullEvent({ ledger: 100 }));
  const k2 = createEventKey(makeFullEvent({ ledger: 101 }));
  assert.notEqual(k1, k2);
});

test("createEventKey: different txHashes produce different keys", () => {
  const k1 = createEventKey(makeFullEvent({ txHash: "aaaa" }));
  const k2 = createEventKey(makeFullEvent({ txHash: "bbbb" }));
  assert.notEqual(k1, k2);
});

// ─── isTransientRpcError ──────────────────────────────────────────────────────

test("isTransientRpcError: returns false for null/undefined", () => {
  assert.equal(isTransientRpcError(null), false);
  assert.equal(isTransientRpcError(undefined), false);
});

test("isTransientRpcError: returns true for ECONNRESET code", () => {
  const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(isTransientRpcError(err), true);
});

test("isTransientRpcError: returns true for HTTP 429", () => {
  assert.equal(isTransientRpcError({ status: 429 }), true);
});

test("isTransientRpcError: returns true for HTTP 503", () => {
  assert.equal(isTransientRpcError({ status: 503 }), true);
});

test("isTransientRpcError: returns false for a generic Error", () => {
  assert.equal(isTransientRpcError(new Error("bad request")), false);
});

test("isTransientRpcError: returns true for 'rate limit' in message", () => {
  assert.equal(isTransientRpcError(new Error("HTTP 429: rate limit exceeded")), true);
});

// ─── withRpcRetry ─────────────────────────────────────────────────────────────

test("withRpcRetry: returns immediately on first-try success", async () => {
  let calls = 0;
  const result = await withRpcRetry("test", async () => {
    calls++;
    return "ok";
  }, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRpcRetry: retries transient errors and eventually succeeds", async () => {
  let calls = 0;
  const result = await withRpcRetry(
    "test",
    async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      return "done";
    },
    { maxAttempts: 4, baseDelayMs: 1, sleep: async () => {} },
  );
  assert.equal(result, "done");
  assert.equal(calls, 3);
});

test("withRpcRetry: fails immediately on non-transient error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRpcRetry(
        "test",
        async () => {
          calls++;
          throw new Error("bad request");
        },
        { maxAttempts: 4, baseDelayMs: 1, sleep: async () => {} },
      ),
    /Soroban RPC test failed after 1 attempt/,
  );
  assert.equal(calls, 1);
});

test("withRpcRetry: exhausts all attempts for persistent transient error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRpcRetry(
        "test",
        async () => {
          calls++;
          throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        },
        { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
      ),
    /failed after 3 attempt/,
  );
  assert.equal(calls, 3);
});
