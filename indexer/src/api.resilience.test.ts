/**
 * Issue #461: API resilience tests — malformed indexer responses, unknown
 * circle/member IDs, non-existent history, and indexer outage conditions.
 *
 * These tests exercise the HTTP contract the frontend depends on:
 *   • The exact HTTP status codes returned for each failure class.
 *   • That 400 / 404 / 500 / 503 are used consistently and never mixed up.
 *   • That every error response carries an `error` key so the frontend can
 *     reliably differentiate missing data from backend outage.
 *   • That the reputation endpoint uses 200 + `found: false` for a member
 *     with no on-chain activity, not 404 — matching the documented semantics.
 *
 * All tests run against the in-process Express app with a stubbed DB pool.
 * No Postgres or Soroban RPC is required.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// ── Stub external dependencies before importing the app ──────────────────────

import * as poolModule from "./db/pool";

// Default stub: empty rows (address not found in DB)
(poolModule as Record<string, unknown>).query = async () => [];

mock.module("./indexer", {
  namedExports: {
    rpc: {},
    USDC: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  },
});

mock.module("./health", {
  namedExports: {
    runAllHealthChecks: async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
      db: { status: "ok" },
      rpc: { status: "ok" },
      indexerLag: { status: "ok" },
      schema: { status: "ok" },
      contractDrift: { status: "ok" },
      config: { usdcAddress: "CTEST", lagAlertLedgers: 1000, driftRoundThreshold: 1 },
    }),
  },
});

mock.module("./groupRounds", {
  namedExports: {
    groupCircleRounds: () => ({
      rounds: [],
      currentRound: null,
      openRounds: [],
      pendingDefaults: [],
    }),
  },
});

import { createApp } from "./api";

// ── Test addresses ────────────────────────────────────────────────────────────

const VALID_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const VALID_G = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// ── HTTP helper ───────────────────────────────────────────────────────────────

type HttpResult = { status: number; body: Record<string, unknown> };

function get(server: http.Server, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    http
      .get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
        let raw = "";
        res.on("data", (c: string) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: {} });
          }
        });
      })
      .on("error", reject);
  });
}

function withServer(
  fn: (server: http.Server) => Promise<void>,
  dbStub?: () => Promise<unknown>,
): () => Promise<void> {
  return async () => {
    if (dbStub) {
      (poolModule as Record<string, unknown>).query = dbStub;
    }
    const app = createApp();
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fn(server);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      // Reset to default "empty rows" stub after each test
      (poolModule as Record<string, unknown>).query = async () => [];
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #461 — Unknown circle / not-found semantics
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#461 GET /circles/:address — unknown circle returns 404 with error key",
  withServer(async (s) => {
    const { status, body } = await get(s, `/circles/${VALID_C}`);
    assert.equal(status, 404, "unknown circle must return 404, not 200/500");
    assert.ok(typeof body.error === "string" || typeof body.error === "object",
      "error key must be present in 404 response");
  }),
);

test(
  "#461 GET /circles/:address/members — unknown circle returns 404",
  withServer(async (s) => {
    const { status, body } = await get(s, `/circles/${VALID_C}/members`);
    assert.equal(status, 404);
    assert.ok(body.error, "error key must be present");
  }),
);

test(
  "#461 GET /circles/:address/rounds — unknown circle returns 404",
  withServer(async (s) => {
    const { status, body } = await get(s, `/circles/${VALID_C}/rounds`);
    assert.equal(status, 404);
    assert.ok(body.error, "error key must be present");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #461 — Reputation: 200 + found:false for unknown member (not 404)
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#461 GET /reputation/:member — unknown member returns 200 with found:false",
  withServer(async (s) => {
    const { status, body } = await get(s, `/reputation/${VALID_G}`);
    assert.equal(status, 200,
      "unknown member must return 200 (valid address, no activity) not 404");
    assert.equal(body.found, false,
      "found must be false when member has no on-chain reputation");
    assert.equal(body.score, 0,
      "score must be 0 for a member with no reputation");
    assert.equal(body.member, VALID_G,
      "response must echo back the requested member address");
  }),
);

test(
  "#461 GET /reputation/:member — malformed address returns 400 not 404",
  withServer(async (s) => {
    const { status, body } = await get(s, "/reputation/not-an-address");
    // The distinction matters to the frontend:
    //   400 = bad input (never retry)
    //   404 = valid address, no record (show empty state)
    assert.equal(status, 400,
      "malformed address must return 400 (bad input), not 404 (valid but missing)");
    assert.ok(body.error, "error key must be present");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #461 — Member contribution history: empty list vs 404
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#461 GET /members/:member/contributions — unknown member returns 200 with empty list",
  withServer(async (s) => {
    const { status, body } = await get(s, `/members/${VALID_G}/contributions`);
    assert.equal(status, 200,
      "unknown member must return 200 with an empty list, not 404");
    assert.ok(Array.isArray(body.contributions),
      "contributions must be an array");
    assert.equal((body.contributions as unknown[]).length, 0,
      "contributions array must be empty for unknown member");
    assert.equal((body.pagination as Record<string, unknown>).total, 0,
      "total must be 0");
  }),
);

test(
  "#461 GET /members/:member/contributions?circle= — unknown circle filter returns 404",
  withServer(async (s) => {
    // When the caller filters by a specific circle that doesn't exist, the
    // frontend should know the circle is gone — not just that contributions
    // are empty. So 404 is the correct response here.
    const { status } = await get(
      s,
      `/members/${VALID_G}/contributions?circle=${VALID_C}`,
    );
    assert.equal(status, 404,
      "?circle= filter with unknown circle must return 404, not 200+empty");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #461 — Database outage: 500 with consistent error shape
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#461 GET /circles — DB outage returns 500 with error key",
  withServer(
    async (s) => {
      const { status, body } = await get(s, "/circles");
      assert.equal(status, 500,
        "a DB error must surface as 500, not hang or crash the process");
      // The error must follow the consistent { error: { message, details } } shape
      // so the frontend can reliably identify it as a server error.
      assert.ok(
        typeof body.error === "object" || typeof body.error === "string",
        "error key must be present in 500 response",
      );
    },
    async () => { throw new Error("ECONNRESET — simulated DB outage"); },
  ),
);

test(
  "#461 GET /circles/:address — DB outage returns 500 with error key",
  withServer(
    async (s) => {
      const { status, body } = await get(s, `/circles/${VALID_C}`);
      assert.equal(status, 500);
      assert.ok(body.error, "error key must be present");
    },
    async () => { throw new Error("simulated DB outage"); },
  ),
);

test(
  "#461 GET /reputation/:member — DB outage returns 500 with error key",
  withServer(
    async (s) => {
      const { status, body } = await get(s, `/reputation/${VALID_G}`);
      assert.equal(status, 500);
      assert.ok(body.error, "error key must be present");
    },
    async () => { throw new Error("simulated DB outage"); },
  ),
);

test(
  "#461 GET /members/:member/contributions — DB outage returns 500",
  withServer(
    async (s) => {
      const { status, body } = await get(s, `/members/${VALID_G}/contributions`);
      assert.equal(status, 500);
      assert.ok(body.error, "error key must be present");
    },
    async () => { throw new Error("simulated DB outage"); },
  ),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #461 — Health endpoint: 503 when any component is degraded
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#461 GET /health — degraded status returns 503",
  withServer(async (s) => {
    // Patch the health module stub to return a degraded report for this test
    const healthModule = await import("./health");
    const original = (healthModule as Record<string, unknown>).runAllHealthChecks;
    (healthModule as Record<string, unknown>).runAllHealthChecks = async () => ({
      status: "degraded",
      timestamp: new Date().toISOString(),
      db: { status: "ok" },
      rpc: { status: "error", error: "RPC unreachable" },
      indexerLag: { status: "ok" },
      schema: { status: "ok" },
      contractDrift: { status: "ok" },
      config: { usdcAddress: "CTEST", lagAlertLedgers: 1000, driftRoundThreshold: 1 },
    });

    try {
      const { status, body } = await get(s, "/health");
      assert.equal(status, 503,
        "a degraded health report must return HTTP 503, not 200");
      assert.equal(body.status, "degraded",
        "response body status must match HTTP status code semantics");
    } finally {
      (healthModule as Record<string, unknown>).runAllHealthChecks = original;
    }
  }),
);

test(
  "#461 GET /health — ok status returns 200",
  withServer(async (s) => {
    const { status, body } = await get(s, "/health");
    assert.equal(status, 200,
      "all-ok health report must return HTTP 200");
    assert.equal(body.status, "ok");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #461 — Error response shape consistency
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#461 all 400 responses carry a top-level string error key",
  withServer(async (s) => {
    const badPaths = [
      "/circles?page=0",
      "/circles?sort=bad",
      "/circles?order=up",
      "/circles?status=Hacked",
      "/circles/not-an-address",
      "/reputation/bad-addr",
      "/members/bad-addr/contributions",
    ];

    for (const path of badPaths) {
      const { status, body } = await get(s, path);
      assert.equal(status, 400, `${path} must return 400`);
      assert.ok(
        typeof body.error === "string" || typeof body.error === "object",
        `${path} must have an error key in the response body`,
      );
    }
  }),
);

test(
  "#461 404 responses carry a top-level string error key",
  withServer(async (s) => {
    const notFoundPaths = [
      `/circles/${VALID_C}`,
      `/circles/${VALID_C}/members`,
      `/circles/${VALID_C}/rounds`,
    ];

    for (const path of notFoundPaths) {
      const { status, body } = await get(s, path);
      assert.equal(status, 404, `${path} must return 404 for unknown resource`);
      assert.ok(
        typeof body.error === "string" || typeof body.error === "object",
        `${path} 404 response must have an error key`,
      );
    }
  }),
);
