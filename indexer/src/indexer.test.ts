import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runEventHandler,
  getIndexerMetrics,
  USDC,
  isTransientRpcError,
  withRpcRetry,
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

test("isTransientRpcError detects network and rate-limit failures", () => {
  assert.equal(isTransientRpcError(Object.assign(new Error("boom"), { code: "ECONNRESET" })), true);
  assert.equal(isTransientRpcError(Object.assign(new Error("nope"), { status: 429 })), true);
  assert.equal(isTransientRpcError(new Error("gateway timeout from upstream")), true);
  assert.equal(isTransientRpcError(new Error("invalid contract id")), false);
  assert.equal(isTransientRpcError(null), false);
});

test("withRpcRetry succeeds after transient failures", async () => {
  let attempts = 0;
  const sleeps: number[] = [];

  const result = await withRpcRetry(
    "test-call",
    async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      return "ok";
    },
    {
      maxAttempts: 4,
      baseDelayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test("withRpcRetry fails fast on non-transient errors", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRpcRetry(
        "test-call",
        async () => {
          attempts++;
          throw new Error("invalid startLedger");
        },
        { maxAttempts: 4, baseDelayMs: 10, sleep: async () => {} },
      ),
    /failed after 1 attempt/,
  );
  assert.equal(attempts, 1);
});

test("withRpcRetry exhausts attempts on persistent transient errors", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRpcRetry(
        "test-call",
        async () => {
          attempts++;
          throw Object.assign(new Error("rate limit"), { status: 429 });
        },
        { maxAttempts: 3, baseDelayMs: 5, sleep: async () => {} },
      ),
    /failed after 3 attempt/,
  );
  assert.equal(attempts, 3);
});
