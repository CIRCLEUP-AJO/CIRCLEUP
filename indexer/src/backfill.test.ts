import { test } from "node:test";
import assert from "node:assert/strict";
import { batchEnd, boundedInteger, BatchLimitError } from "./backfill";
import { fetchAllEventsWithPagination } from "./indexer";
import type { SorobanRpc } from "@stellar/stellar-sdk";
const event = (id: string, ledger = 10) => ({ id, ledger }) as SorobanRpc.Api.EventResponse;

test("batch configuration has hard integer caps", () => {
  assert.equal(batchEnd(10, 1000, 100), 109);
  assert.equal(batchEnd(10, 12, 100), 12);
  for (const value of ["0", "-1", "1.2", "Infinity", "10001", ""]) assert.throws(() => boundedInteger("ledgers", value, 100, 10000));
});
test("page and event exhaustion fail without exposing a partial batch", async () => {
  const rpc = { getEvents: async () => ({ latestLedger: 100, events: [event("a"),event("b")] }) };
  await assert.rejects(fetchAllEventsWithPagination(rpc, { fromLedger: 10, toLedger: 20, filters: [], limit: 2, maxPages: 1 }), BatchLimitError);
  await assert.rejects(fetchAllEventsWithPagination(rpc, { fromLedger: 10, toLedger: 20, filters: [], limit: 2, maxEvents: 1 }), BatchLimitError);
});
test("interrupted fetch restarts from the same ledger and retrieves the full range", async () => {
  const starts: number[] = [];
  let stopped = false;
  const rpc = { getEvents: async (req: SorobanRpc.Server.GetEventsRequest) => {
    if (req.startLedger !== undefined) starts.push(req.startLedger);
    if (req.cursor) return { latestLedger: 100, events: [] };
    stopped = true;
    return { latestLedger: 100, events: [event("a"),event("b")] };
  }};
  const options = { fromLedger: 10, toLedger: 20, filters: [], limit: 2 };
  await assert.rejects(fetchAllEventsWithPagination(rpc, { ...options, shouldStop: () => stopped }), /interrupted/);
  const complete = await fetchAllEventsWithPagination(rpc, options);
  assert.deepEqual(starts, [10,10]);
  assert.equal(complete.length, 2);
});
test("a short final page succeeds even when it uses the last allowed page", async () => {
  const rpc = { getEvents: async () => ({ latestLedger: 100, events: [event("a")] }) };
  assert.equal((await fetchAllEventsWithPagination(rpc, { fromLedger: 10, toLedger: 20, filters: [], limit: 2, maxPages: 1 })).length, 1);
});
