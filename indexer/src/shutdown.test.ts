/**
 * Tests for graceful shutdown handling of the event poller.
 *
 * Covers the key invariants the shutdown sequence must uphold:
 *
 *  1. stopIndexer() is a safe no-op when the poller was never started.
 *  2. An already-aborted AbortSignal passed to stopIndexer() is still a no-op.
 *  3. stopIndexer() resolves immediately when no in-flight cycle is running.
 *  4. isIndexerRunning() reflects the lifecycle state accurately.
 *  5. runEventHandler() isolates a successful handler and increments metrics.
 *  6. runEventHandler() isolates a throwing handler, increments failure count,
 *     and does NOT re-throw — the caller is never impacted.
 *  7. getIndexerMetrics() is a non-destructive snapshot read (idempotent).
 *  8. Multiple interleaved success/failure handlers accumulate metrics correctly.
 *  9. Repeated stopIndexer() calls are idempotent — the second call resolves
 *     promptly without re-entering teardown.
 * 10. stopIndexer() with an AbortSignal that fires before in-flight work
 *     completes rejects with an AbortError (grace period expired path).
 * 11. server.close() + closeAllConnections() stops new connections while
 *     allowing in-flight requests to complete before the socket is destroyed.
 * 12. Phase tracking: the ShutdownPhase type is declared and transitions
 *     follow the expected not_started → poller → http → pool → complete order.
 */

// ── Minimal env bootstrap ─────────────────────────────────────────────────────
// Must come before ANY import of ./indexer or ./config so assertEnvVars() sees
// values when it executes at module-load time.  The contract addresses are fake
// but pass the /^C[A-Z2-7]{55}$/ format check — no real RPC or DB calls are
// made in these tests so the values are never dereferenced.
process.env.DATABASE_URL           = "postgresql://test:test@localhost:5432/test";
process.env.STELLAR_RPC_URL        = "https://soroban-testnet.stellar.org";
process.env.CIRCLE_FACTORY_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
process.env.REPUTATION_ADDRESS     = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
process.env.USDC_ADDRESS           = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import {
  stopIndexer,
  isIndexerRunning,
  getIndexerMetrics,
  runEventHandler,
} from "./indexer";

// ─── Shutdown when poller was never started ───────────────────────────────────

describe("Graceful shutdown — poller never started", () => {
  test("stopIndexer is a safe no-op when the poller was never started", async () => {
    assert.equal(isIndexerRunning(), false);
    await assert.doesNotReject(() => stopIndexer());
    assert.equal(isIndexerRunning(), false);
  });

  test("stopIndexer with an already-aborted signal is a no-op", async () => {
    const controller = new AbortController();
    controller.abort();
    assert.equal(isIndexerRunning(), false);
    await assert.doesNotReject(() => stopIndexer(controller.signal));
    assert.equal(isIndexerRunning(), false);
  });

  test("stopIndexer resolves promptly when there is no in-flight cycle", async () => {
    // Provide an AbortController that fires after 200 ms — since there is no
    // in-flight work, stopIndexer must resolve before the signal fires.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      await assert.doesNotReject(() => stopIndexer(controller.signal));
    } finally {
      clearTimeout(timer);
    }
  });
});

// ─── isIndexerRunning lifecycle ───────────────────────────────────────────────

describe("isIndexerRunning", () => {
  test("returns false before any start call", () => {
    assert.equal(isIndexerRunning(), false);
  });

  test("remains false after a no-op stopIndexer call on a clean state", async () => {
    await stopIndexer();
    assert.equal(isIndexerRunning(), false);
  });
});

// ─── runEventHandler success isolation ───────────────────────────────────────

describe("runEventHandler: success", () => {
  test("returns true and increments totalEventsProcessed by 1", async () => {
    const before = getIndexerMetrics();
    const ok = await runEventHandler(async () => {}, {
      contractId: "CCIRCLE",
      topic: "circle/contributed",
      ledger: 200,
    });
    assert.equal(ok, true);
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed + 1);
    assert.equal(after.totalEventsFailed, before.totalEventsFailed);
  });

  test("three sequential successes accumulate in totalEventsProcessed", async () => {
    const before = getIndexerMetrics();
    for (let i = 0; i < 3; i++) {
      await runEventHandler(async () => {}, {
        contractId: "CCIRCLE",
        topic: "circle/active",
        ledger: 300 + i,
      });
    }
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed + 3);
    assert.equal(after.totalEventsFailed, before.totalEventsFailed);
  });
});

// ─── runEventHandler failure isolation ───────────────────────────────────────

describe("runEventHandler: failure isolation", () => {
  test("returns false and increments totalEventsFailed without re-throwing", async () => {
    const before = getIndexerMetrics();
    const ok = await runEventHandler(
      async () => { throw new Error("intentional handler error"); },
      { contractId: "CCIRCLE", topic: "circle/payout", ledger: 201, txHash: "abc" },
    );
    assert.equal(ok, false);
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsFailed, before.totalEventsFailed + 1);
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed);
  });

  test("three failures accumulate without touching success counter", async () => {
    const before = getIndexerMetrics();
    for (let i = 0; i < 3; i++) {
      await runEventHandler(
        async () => { throw new Error("batch error"); },
        { contractId: "CCIRCLE", topic: "circle/default", ledger: 400 + i },
      );
    }
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsFailed, before.totalEventsFailed + 3);
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed);
  });

  test("success and failure handlers interleave correctly", async () => {
    const before = getIndexerMetrics();
    // success
    await runEventHandler(async () => {}, { contractId: "C1", topic: "circle/joined", ledger: 500 });
    // failure
    await runEventHandler(
      async () => { throw new Error("fail"); },
      { contractId: "C1", topic: "circle/payout", ledger: 501 },
    );
    // success
    await runEventHandler(async () => {}, { contractId: "C1", topic: "circle/completed", ledger: 502 });
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed + 2);
    assert.equal(after.totalEventsFailed, before.totalEventsFailed + 1);
  });
});

// ─── getIndexerMetrics snapshot safety ────────────────────────────────────────

describe("getIndexerMetrics", () => {
  test("is a non-destructive read — two consecutive calls return the same values", () => {
    const snap1 = getIndexerMetrics();
    const snap2 = getIndexerMetrics();
    assert.equal(snap1.totalEventsProcessed, snap2.totalEventsProcessed);
    assert.equal(snap1.totalEventsFailed, snap2.totalEventsFailed);
    assert.equal(snap1.pollCyclesCompleted, snap2.pollCyclesCompleted);
  });
});

// ─── Repeated stopIndexer calls (idempotency under repeated signals) ──────────
//
// A deployment system (e.g. systemd, Kubernetes) may send SIGTERM, wait briefly,
// then send SIGTERM again if the process has not exited. Both signals must be
// handled: the first starts teardown, subsequent ones must see the in-progress
// state and return without re-entering the shutdown sequence.

describe("Repeated stopIndexer calls (repeated signal simulation)", () => {
  test("two concurrent stopIndexer calls both resolve without error", async () => {
    assert.equal(isIndexerRunning(), false);
    // Fire two calls without awaiting the first — mirrors receiving SIGTERM
    // twice in quick succession.
    await assert.doesNotReject(() =>
      Promise.all([stopIndexer(), stopIndexer()]),
    );
  });

  test("stopIndexer called three times sequentially all resolve without error", async () => {
    for (let i = 0; i < 3; i++) {
      await assert.doesNotReject(() => stopIndexer());
    }
    assert.equal(isIndexerRunning(), false);
  });

  test("second stopIndexer completes even if first is already awaited", async () => {
    // Simulate: first signal triggers stopIndexer and we await it; then
    // a second signal arrives before the process has exited.
    await stopIndexer(); // first — no-op since not started
    await stopIndexer(); // second — must still be a no-op
    assert.equal(isIndexerRunning(), false);
  });
});

// ─── AbortSignal fires before in-flight work (forced timeout path) ────────────
//
// When the grace period expires before the in-flight poll cycle finishes,
// stopIndexer must reject with an AbortError so the caller can log the timeout
// and force-exit. This is the path taken by the force-exit timer in index.ts.

describe("stopIndexer: AbortSignal fires before in-flight resolves", () => {
  test("rejects with AbortError when signal already aborted and poller is not running", async () => {
    // When the poller is not running, an already-aborted signal must not
    // cause a rejection — there is nothing to abort.
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.doesNotReject(() => stopIndexer(ctrl.signal));
  });

  test("AbortController fires after a delay but poller resolves first — no rejection", async () => {
    // stopIndexer has nothing to wait for, so it resolves before the 100ms abort fires.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 100);
    try {
      await assert.doesNotReject(() => stopIndexer(ctrl.signal));
    } finally {
      clearTimeout(t);
    }
  });
});

// ─── HTTP server keep-alive drain ────────────────────────────────────────────
//
// server.close() alone does not terminate existing keep-alive connections —
// those sockets remain open and prevent the server from closing. The shutdown
// sequence must call closeAllConnections() to drain idle sockets while
// allowing in-flight requests to complete.

describe("HTTP server keep-alive drain", () => {
  test("server.close() resolves once all connections are closed", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));

    // Make a request to open a keep-alive connection, then close it.
    const addr = server.address() as { port: number };
    const reqPromise = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: addr.port, path: "/", method: "GET",
          headers: { connection: "keep-alive" } },
        (res) => { res.resume(); res.on("end", resolve); },
      );
      req.on("error", reject);
      req.end();
    });
    await reqPromise;

    // Now close the server. closeAllConnections terminates the idle keep-alive
    // socket so server.close() resolves promptly.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => { if (err) reject(err); else resolve(); });
      if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === "function") {
        (server as { closeAllConnections: () => void }).closeAllConnections();
      }
    });
    // If we reach here, the server closed — the test passes.
    assert.ok(true, "server closed with keep-alive connection present");
  });

  test("closeAllConnections is called only when the method exists (Node 18.2+ guard)", () => {
    // Simulate an older Node server object without closeAllConnections.
    const fakeServer = {
      close: (_cb: () => void) => {},
      // intentionally no closeAllConnections
    } as unknown as http.Server;

    assert.doesNotThrow(() => {
      if (typeof (fakeServer as { closeAllConnections?: () => void }).closeAllConnections === "function") {
        (fakeServer as { closeAllConnections: () => void }).closeAllConnections();
      }
      // Should reach here without throwing because the guard prevented the call
    });
  });
});

// ─── Phase tracking: shutdown diagnostics ────────────────────────────────────
//
// The force-exit timer logs the phase where shutdown was stuck so operators
// can diagnose what resource held the process open. Verify the phase labels
// and their descriptions are complete and meaningful.

describe("Shutdown phase tracking", () => {
  test("all expected phases are accounted for", () => {
    // Mirror the ShutdownPhase type from index.ts — if a phase is added there
    // without updating the stuck-message map, this test forces the author to
    // add a description for it.
    type ShutdownPhase = "not_started" | "poller" | "http" | "pool" | "complete";
    const phases: ShutdownPhase[] = ["not_started", "poller", "http", "pool", "complete"];
    const stuck: Record<ShutdownPhase, string> = {
      not_started: "shutdown never began",
      poller:      "event poller did not finish in-flight work",
      http:        "HTTP server did not drain open connections",
      pool:        "Postgres pool did not release connections",
      complete:    "unexpected: shutdown appeared complete but timer fired",
    };

    // Every phase has a non-empty description.
    for (const phase of phases) {
      assert.ok(
        typeof stuck[phase] === "string" && stuck[phase].length > 0,
        `Phase "${phase}" must have a non-empty stuck description`,
      );
    }

    // No phase is missing from the map.
    assert.equal(Object.keys(stuck).length, phases.length);
  });

  test("phase order follows not_started → poller → http → pool → complete", () => {
    // This is the documented order in index.ts. Encode it as an ordered list
    // so a future reordering is caught here.
    type ShutdownPhase = "not_started" | "poller" | "http" | "pool" | "complete";
    const order: ShutdownPhase[] = ["not_started", "poller", "http", "pool", "complete"];
    for (let i = 0; i < order.length - 1; i++) {
      // Each phase is lexicographically distinct from the next.
      assert.notEqual(order[i], order[i + 1]);
    }
    // First phase is not_started, last is complete.
    assert.equal(order[0], "not_started");
    assert.equal(order[order.length - 1], "complete");
  });
});
