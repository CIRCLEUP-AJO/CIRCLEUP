/**
 * Issue 97: Verify event poller pagination before advancing the ledger cursor.
 *
 * Verifies that:
 * 1. Multi-page event queries iterate through all available pages in deterministic order.
 * 2. On page 1, `startLedger` is supplied and `cursor` is omitted.
 * 3. On subsequent pages, `cursor` is supplied and `startLedger` is omitted (Soroban RPC requirement).
 * 4. Events beyond `toLedger` terminate pagination and are excluded from the current cycle.
 * 5. A failure on any page throws an error immediately, aborting the process before cursor advancement.
 * 6. Repeated cursors terminate gracefully without infinite loops.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchAllEventsWithPagination } from "./indexer";
import type { SorobanRpc } from "@stellar/stellar-sdk";

type SdkEvent = SorobanRpc.Api.EventResponse;

function makeMockEvent(ledger: number, id: string, pagingToken?: string): SdkEvent {
  return {
    id,
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    topic: ["factory", "circle_created"],
    value: {},
    pagingToken: pagingToken ?? id,
    inSuccessfulContractCall: true,
  } as unknown as SdkEvent;
}

describe("fetchAllEventsWithPagination", () => {
  it("fetches single page when events count is below limit", async () => {
    const pageEvents = [
      makeMockEvent(100, "001-01"),
      makeMockEvent(100, "001-02"),
    ];

    const calls: SorobanRpc.Server.GetEventsRequest[] = [];
    const mockRpc = {
      getEvents: async (req: SorobanRpc.Server.GetEventsRequest) => {
        calls.push(req);
        return {
          latestLedger: 105,
          events: pageEvents,
        };
      },
    };

    const results = await fetchAllEventsWithPagination(mockRpc, {
      fromLedger: 100,
      toLedger: 105,
      filters: [],
      limit: 10,
    });

    assert.strictEqual(results.length, 2);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].startLedger, 100);
    assert.strictEqual(calls[0].cursor, undefined);
  });

  it("iterates across multiple pages supplying cursor and omitting startLedger on page 2+", async () => {
    const page1Events = [
      makeMockEvent(100, "001-01", "cursor-page-1-end"),
      makeMockEvent(100, "001-02", "cursor-page-1-end"),
    ];
    const page2Events = [
      makeMockEvent(101, "002-01", "cursor-page-2-end"),
      makeMockEvent(101, "002-02", "cursor-page-2-end"),
    ];
    const page3Events = [
      makeMockEvent(102, "003-01", "cursor-page-3-end"),
    ];

    const calls: SorobanRpc.Server.GetEventsRequest[] = [];
    const mockRpc = {
      getEvents: async (req: SorobanRpc.Server.GetEventsRequest) => {
        calls.push(req);
        if (calls.length === 1) {
          return { latestLedger: 105, events: page1Events };
        }
        if (calls.length === 2) {
          return { latestLedger: 105, events: page2Events };
        }
        return { latestLedger: 105, events: page3Events };
      },
    };

    const results = await fetchAllEventsWithPagination(mockRpc, {
      fromLedger: 100,
      toLedger: 105,
      filters: [],
      limit: 2, // limit is 2, so page 1 and 2 trigger next page, page 3 has 1 item so terminates
    });

    assert.strictEqual(results.length, 5);
    assert.strictEqual(calls.length, 3);

    // Page 1: Must have startLedger, must NOT have cursor
    assert.strictEqual(calls[0].startLedger, 100);
    assert.strictEqual(calls[0].cursor, undefined);

    // Page 2: Must have cursor, must NOT have startLedger
    assert.strictEqual(calls[1].cursor, "cursor-page-1-end");
    assert.strictEqual(calls[1].startLedger, undefined);

    // Page 3: Must have cursor, must NOT have startLedger
    assert.strictEqual(calls[2].cursor, "cursor-page-2-end");
    assert.strictEqual(calls[2].startLedger, undefined);
  });

  it("stops pagination and filters out events occurring after toLedger", async () => {
    const page1Events = [
      makeMockEvent(100, "001-01"),
      makeMockEvent(101, "001-02"),
    ];
    const page2Events = [
      makeMockEvent(102, "002-01"), // within toLedger = 102
      makeMockEvent(103, "002-02"), // exceeds toLedger = 102
    ];

    const calls: SorobanRpc.Server.GetEventsRequest[] = [];
    const mockRpc = {
      getEvents: async (req: SorobanRpc.Server.GetEventsRequest) => {
        calls.push(req);
        if (calls.length === 1) {
          return { latestLedger: 105, events: page1Events };
        }
        return { latestLedger: 105, events: page2Events };
      },
    };

    const results = await fetchAllEventsWithPagination(mockRpc, {
      fromLedger: 100,
      toLedger: 102,
      filters: [],
      limit: 2,
    });

    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[results.length - 1].ledger, 102);
    // Even though page2 returned 2 items (= limit), because it encountered ledger > toLedger, it terminates!
    assert.strictEqual(calls.length, 2);
  });

  it("throws and returns no partial events if an intermediate page fetch fails", async () => {
    const page1Events = [
      makeMockEvent(100, "001-01", "cursor-1"),
      makeMockEvent(100, "001-02", "cursor-1"),
    ];

    let callCount = 0;
    const mockRpc = {
      getEvents: async () => {
        callCount++;
        if (callCount === 1) {
          return { latestLedger: 105, events: page1Events };
        }
        throw new Error("RPC network drop on page 2");
      },
    };

    await assert.rejects(
      async () => {
        await fetchAllEventsWithPagination(mockRpc, {
          fromLedger: 100,
          toLedger: 105,
          filters: [],
          limit: 2,
        });
      },
      /RPC network drop on page 2/,
    );
  });

  it("terminates pagination if returned cursor repeats to prevent infinite loops", async () => {
    const loopingEvents = [
      makeMockEvent(100, "001-01", "stuck-cursor"),
      makeMockEvent(100, "001-02", "stuck-cursor"),
    ];

    let calls = 0;
    const mockRpc = {
      getEvents: async () => {
        calls++;
        return { latestLedger: 105, events: loopingEvents };
      },
    };

    await assert.rejects(fetchAllEventsWithPagination(mockRpc, {
      fromLedger: 100, toLedger: 105, filters: [], limit: 2,
    }), /cursor did not advance/);

    assert.strictEqual(calls, 2);

  });
});
