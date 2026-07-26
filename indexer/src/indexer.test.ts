import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runEventHandler,
  getIndexerMetrics,
  USDC,
  stopIndexer,
  isIndexerRunning,
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
