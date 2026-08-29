import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runEventHandler,
  getIndexerMetrics,
  USDC,
  stopIndexer,
  isIndexerRunning,
  parseCircleCreatedEvent,
  computeJitteredDelay,
  isTransientRpcError,
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

// ─── computeJitteredDelay — full jitter for RPC retry ───────────────────────

test("computeJitteredDelay returns value in [0, delayMs)", () => {
  for (let i = 0; i < 100; i++) {
    const result = computeJitteredDelay(500);
    assert.ok(result >= 0, `jittered delay ${result} should be >= 0`);
    assert.ok(result < 500, `jittered delay ${result} should be < 500`);
  }
});

test("computeJitteredDelay produces varied values", () => {
  const samples = new Set<number>();
  for (let i = 0; i < 30; i++) {
    samples.add(computeJitteredDelay(1000));
  }
  // With 30 samples in [0, 1000), we should see variety
  assert.ok(samples.size > 10, `expected varied jitter values, got ${samples.size} distinct`);
});

test("computeJitteredDelay(0) always returns 0", () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(computeJitteredDelay(0), 0);
  }
});

// ─── Metrics — verify new fields are tracked ─────────────────────────────────

test("getIndexerMetrics returns all expected fields", () => {
  const metrics = getIndexerMetrics();
  assert.ok("totalEventsProcessed" in metrics, "should have totalEventsProcessed");
  assert.ok("totalEventsFailed" in metrics, "should have totalEventsFailed");
  assert.ok("pollCyclesCompleted" in metrics, "should have pollCyclesCompleted");
  assert.ok("pollCyclesFailed" in metrics, "should have pollCyclesFailed");
  assert.ok("lastPollDurationMs" in metrics, "should have lastPollDurationMs");
  assert.ok("lastPollLedgerRange" in metrics, "should have lastPollLedgerRange");
  assert.ok("backoffConsecutiveFailures" in metrics, "should have backoffConsecutiveFailures");
  assert.ok("backoffCurrentIntervalMs" in metrics, "should have backoffCurrentIntervalMs");
});

// ─── isTransientRpcError — expanded coverage ─────────────────────────────────

test("isTransientRpcError identifies all transient error codes", () => {
  const transientCodes = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH"];
  for (const code of transientCodes) {
    assert.equal(isTransientRpcError({ code }), true, `${code} should be transient`);
  }
});

test("isTransientRpcError identifies transient HTTP status codes", () => {
  for (const status of [429, 502, 503, 504]) {
    assert.equal(isTransientRpcError({ status }), true, `status ${status} should be transient`);
  }
});

test("isTransientRpcError rejects non-transient errors", () => {
  assert.equal(isTransientRpcError(null), false);
  assert.equal(isTransientRpcError(undefined), false);
  assert.equal(isTransientRpcError({ code: "ENOENT" }), false);
  assert.equal(isTransientRpcError({ status: 400 }), false);
});
