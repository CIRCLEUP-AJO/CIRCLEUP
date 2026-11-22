/**
 * Issue #853: History pagination bounds tests.
 *
 * Covers the retention and size-limit contract for paginated history endpoints:
 *   • /members/:member/contributions
 *   • /circles/:address/history
 *
 * For each endpoint we verify:
 *   - limit=101 is rejected with 400 (over the MAX_LIMIT of 100)
 *   - limit=100 is accepted (at the boundary)
 *   - limit=0  is rejected with 400 (below minimum of 1)
 *   - page=0   is rejected with 400
 *   - page=1 & limit=1 with an empty DB returns a valid pagination envelope:
 *       { page:1, limit:1, total:0, totalPages:0, hasMore:false }
 *   - when page >= totalPages, hasMore is false (final-page detection)
 *
 * Tests run against the in-process Express app with a fully stubbed DB pool.
 * No Postgres, no Soroban RPC required.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// ── Stub external dependencies before importing the app ──────────────────────
//
// The stubs must be installed before `createApp` is imported so that every
// lazy `require`/`import` inside api.ts resolves to our fakes, not real
// network/DB connections.

import * as poolModule from "./db/pool";

// Default: empty result set (address not found, no rows).
(poolModule as Record<string, unknown>).query = async () => [];
// queryOne wraps query; stub it too so endpoints that use it directly get null.
(poolModule as Record<string, unknown>).queryOne = async () => null;
// queryExact is used by /history and /audit for COUNT queries; default to a
// zero-count row so those endpoints can respond without throwing.
(poolModule as Record<string, unknown>).queryExact = async () => ({ count: "0" });

mock.module("./indexer", {
  namedExports: {
    rpc: {},
    USDC: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    getIndexerMetrics: () => ({}),
    isIndexerRunning: () => false,
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
      config: {
        usdcAddress: "CTEST",
        lagAlertLedgers: 1000,
        driftRoundThreshold: 1,
      },
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
        res.on("data", (chunk: string) => (raw += chunk));
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

/**
 * Run `fn` against a freshly-created, ephemeral HTTP server.
 *
 * `dbStubs` optionally replaces the pool helpers for the duration of the test,
 * and is reset to the defaults afterwards so test isolation is preserved.
 */
function withServer(
  fn: (server: http.Server) => Promise<void>,
  dbStubs?: {
    query?: () => Promise<unknown>;
    queryOne?: () => Promise<unknown>;
    queryExact?: () => Promise<unknown>;
  },
): () => Promise<void> {
  return async () => {
    // Install per-test stubs if provided.
    if (dbStubs?.query) (poolModule as Record<string, unknown>).query = dbStubs.query;
    if (dbStubs?.queryOne) (poolModule as Record<string, unknown>).queryOne = dbStubs.queryOne;
    if (dbStubs?.queryExact) (poolModule as Record<string, unknown>).queryExact = dbStubs.queryExact;

    const app = createApp();
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    try {
      await fn(server);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      // Always restore the safe defaults so subsequent tests are not affected.
      (poolModule as Record<string, unknown>).query = async () => [];
      (poolModule as Record<string, unknown>).queryOne = async () => null;
      (poolModule as Record<string, unknown>).queryExact = async () => ({ count: "0" });
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// /members/:member/contributions — limit bounds
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#853 GET /members/:member/contributions?limit=101 — over-max returns 400",
  withServer(async (s) => {
    const { status, body } = await get(s, `/members/${VALID_G}/contributions?limit=101`);
    assert.equal(status, 400,
      "limit=101 exceeds MAX_LIMIT=100 and must be rejected with 400");
    assert.ok(
      typeof body.error === "string" || typeof body.error === "object",
      "400 response must include an error key",
    );
  }),
);

test(
  "#853 GET /members/:member/contributions?limit=100 — at-max is accepted",
  withServer(async (s) => {
    const { status } = await get(s, `/members/${VALID_G}/contributions?limit=100`);
    // With an empty DB this returns 200 + empty list, not 400.
    assert.equal(status, 200,
      "limit=100 is exactly at the maximum and must be accepted");
  }),
);

test(
  "#853 GET /members/:member/contributions?limit=0 — below-min returns 400",
  withServer(async (s) => {
    const { status, body } = await get(s, `/members/${VALID_G}/contributions?limit=0`);
    assert.equal(status, 400,
      "limit=0 is below the minimum of 1 and must be rejected with 400");
    assert.ok(
      typeof body.error === "string" || typeof body.error === "object",
      "400 response must include an error key",
    );
  }),
);

test(
  "#853 GET /members/:member/contributions?page=0 — invalid page returns 400",
  withServer(async (s) => {
    const { status, body } = await get(s, `/members/${VALID_G}/contributions?page=0`);
    assert.equal(status, 400,
      "page=0 is not a positive integer and must be rejected with 400");
    assert.ok(
      typeof body.error === "string" || typeof body.error === "object",
      "400 response must include an error key",
    );
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// /members/:member/contributions — empty-DB pagination envelope
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#853 GET /members/:member/contributions?page=1&limit=1 — empty DB returns valid pagination",
  withServer(async (s) => {
    const { status, body } = await get(
      s,
      `/members/${VALID_G}/contributions?page=1&limit=1`,
    );
    assert.equal(status, 200,
      "a valid address with no contributions must return 200, not 404");

    const pagination = body.pagination as Record<string, unknown>;
    assert.ok(pagination, "response must include a pagination key");
    assert.equal(pagination.page, 1,   "page must echo the requested page number");
    assert.equal(pagination.limit, 1,  "limit must echo the requested limit");
    assert.equal(pagination.total, 0,  "total must be 0 for an empty DB");
    assert.equal(pagination.totalPages, 0,
      "totalPages must be 0 when there are no records");
    assert.equal(pagination.hasMore, false,
      "hasMore must be false when there are no records");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// /members/:member/contributions — final-page detection (hasMore=false)
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#853 GET /members/:member/contributions — final page has hasMore=false",
  withServer(
    async (s) => {
      // With total=3 and limit=2, page=2 is the final page (totalPages=2).
      // hasMore must be false because page (2) is not less than totalPages (2).
      const { status, body } = await get(
        s,
        `/members/${VALID_G}/contributions?page=2&limit=2`,
      );
      assert.equal(status, 200);

      const pagination = body.pagination as Record<string, unknown>;
      assert.equal(pagination.page, 2);
      assert.equal(pagination.limit, 2);
      assert.equal(pagination.total, 3,     "total must reflect the stubbed count");
      assert.equal(pagination.totalPages, 2, "ceil(3/2) = 2 total pages");
      assert.equal(pagination.hasMore, false,
        "page=2 equals totalPages=2, so hasMore must be false");
    },
    {
      // The contributions endpoint uses queryOne for the COUNT aggregate.
      // Return total=3 so we get a two-page result set with limit=2.
      queryOne: async () => ({ count: "3", total_amount: "0" }),
    },
  ),
);

test(
  "#853 GET /members/:member/contributions — non-final page has hasMore=true",
  withServer(
    async (s) => {
      // With total=3 and limit=2, page=1 is NOT the final page.
      const { status, body } = await get(
        s,
        `/members/${VALID_G}/contributions?page=1&limit=2`,
      );
      assert.equal(status, 200);

      const pagination = body.pagination as Record<string, unknown>;
      assert.equal(pagination.hasMore, true,
        "page=1 is less than totalPages=2, so hasMore must be true");
    },
    {
      queryOne: async () => ({ count: "3", total_amount: "0" }),
    },
  ),
);

// ═══════════════════════════════════════════════════════════════════════════════
// /circles/:address/history — limit bounds
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#853 GET /circles/:address/history?limit=101 — over-max returns 400",
  withServer(async (s) => {
    const { status, body } = await get(s, `/circles/${VALID_C}/history?limit=101`);
    assert.equal(status, 400,
      "limit=101 exceeds MAX_LIMIT=100 and must be rejected with 400");
    assert.ok(
      typeof body.error === "string" || typeof body.error === "object",
      "400 response must include an error key",
    );
  }),
);

test(
  "#853 GET /circles/:address/history?limit=100 — at-max is accepted",
  withServer(
    async (s) => {
      const { status } = await get(s, `/circles/${VALID_C}/history?limit=100`);
      // The circle exists (queryOne returns a row), COUNT=0 from queryExact.
      assert.equal(status, 200,
        "limit=100 is exactly at the maximum and must be accepted");
    },
    {
      // /history calls queryOne to look up the circle row; return a fake circle.
      queryOne: async () => ({ address: VALID_C }),
    },
  ),
);

test(
  "#853 GET /circles/:address/history?limit=0 — below-min returns 400",
  withServer(async (s) => {
    const { status, body } = await get(s, `/circles/${VALID_C}/history?limit=0`);
    assert.equal(status, 400,
      "limit=0 is below the minimum of 1 and must be rejected with 400");
    assert.ok(
      typeof body.error === "string" || typeof body.error === "object",
      "400 response must include an error key",
    );
  }),
);

test(
  "#853 GET /circles/:address/history?page=0 — invalid page returns 400",
  withServer(async (s) => {
    const { status, body } = await get(s, `/circles/${VALID_C}/history?page=0`);
    assert.equal(status, 400,
      "page=0 is not a positive integer and must be rejected with 400");
    assert.ok(
      typeof body.error === "string" || typeof body.error === "object",
      "400 response must include an error key",
    );
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// /circles/:address/history — empty-DB pagination envelope
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#853 GET /circles/:address/history?page=1&limit=1 — empty DB returns valid pagination",
  withServer(
    async (s) => {
      const { status, body } = await get(
        s,
        `/circles/${VALID_C}/history?page=1&limit=1`,
      );
      assert.equal(status, 200,
        "a known circle with no events must return 200, not 404");

      const pagination = body.pagination as Record<string, unknown>;
      assert.ok(pagination, "response must include a pagination key");
      assert.equal(pagination.page, 1);
      assert.equal(pagination.limit, 1);
      assert.equal(pagination.total, 0,       "total must be 0 for an empty event log");
      assert.equal(pagination.totalPages, 0,  "totalPages must be 0 when total is 0");
      assert.equal(pagination.hasMore, false,
        "hasMore must be false when there are no events");
    },
    {
      // /history calls queryOne first (circle lookup) then queryExact (COUNT).
      queryOne: async () => ({ address: VALID_C }),
      // queryExact returns the zero count — already the default, but explicit
      // here so the test intent is obvious.
      queryExact: async () => ({ count: "0" }),
    },
  ),
);

// ═══════════════════════════════════════════════════════════════════════════════
// /circles/:address/history — final-page detection (hasMore=false)
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#853 GET /circles/:address/history — final page has hasMore=false",
  withServer(
    async (s) => {
      // total=5, limit=3 → totalPages=ceil(5/3)=2.  page=2 is the last page.
      const { status, body } = await get(
        s,
        `/circles/${VALID_C}/history?page=2&limit=3`,
      );
      assert.equal(status, 200);

      const pagination = body.pagination as Record<string, unknown>;
      assert.equal(pagination.page, 2);
      assert.equal(pagination.limit, 3);
      assert.equal(pagination.total, 5,
        "total must reflect the stubbed COUNT");
      assert.equal(pagination.totalPages, 2,
        "ceil(5/3) = 2 total pages");
      assert.equal(pagination.hasMore, false,
        "page=2 equals totalPages=2, so hasMore must be false");
    },
    {
      queryOne: async () => ({ address: VALID_C }),
      queryExact: async () => ({ count: "5" }),
    },
  ),
);

test(
  "#853 GET /circles/:address/history — non-final page has hasMore=true",
  withServer(
    async (s) => {
      // total=5, limit=3, page=1 → hasMore=true (page 1 < totalPages 2).
      const { status, body } = await get(
        s,
        `/circles/${VALID_C}/history?page=1&limit=3`,
      );
      assert.equal(status, 200);

      const pagination = body.pagination as Record<string, unknown>;
      assert.equal(pagination.hasMore, true,
        "page=1 is less than totalPages=2, so hasMore must be true");
    },
    {
      queryOne: async () => ({ address: VALID_C }),
      queryExact: async () => ({ count: "5" }),
    },
  ),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #985 — deprecation policy: pagination transition compatibility
//
// The documented policy (docs/api-deprecation-policy.md) allows a transition
// window during which both the legacy page-based pagination envelope and the
// cursor-based form must parse. Deprecated inputs must still work and must be
// announced with `Deprecation` / `Sunset` response headers.
// ═══════════════════════════════════════════════════════════════════════════════

type HttpResultWithHeaders = HttpResult & { headers: http.IncomingHttpHeaders };

function getWithHeaders(server: http.Server, path: string): Promise<HttpResultWithHeaders> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    http
      .get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
        let raw = "";
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(raw);
          } catch {
            body = {};
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      })
      .on("error", reject);
  });
}

/** Assert the pagination envelope keeps its documented wire types. */
function assertPaginationWireTypes(
  pagination: Record<string, unknown>,
  label: string,
): void {
  assert.equal(typeof pagination.page, "number", `${label}: page must be a number`);
  assert.equal(typeof pagination.limit, "number", `${label}: limit must be a number`);
  assert.equal(typeof pagination.total, "number", `${label}: total must be a number`);
  assert.equal(typeof pagination.totalPages, "number", `${label}: totalPages must be a number`);
  assert.equal(typeof pagination.hasMore, "boolean", `${label}: hasMore must be a boolean`);
  assert.ok(Number.isInteger(pagination.page), `${label}: page must be an integer`);
  assert.ok(Number.isInteger(pagination.limit), `${label}: limit must be an integer`);
  assert.ok(Number.isInteger(pagination.total), `${label}: total must be an integer`);
  assert.ok(Number.isInteger(pagination.totalPages), `${label}: totalPages must be an integer`);
}

test(
  "#985 legacy page-based pagination envelope keeps documented wire types",
  withServer(async (s) => {
    const { status, body } = await get(
      s,
      `/members/${VALID_G}/contributions?page=1&limit=2`,
    );
    assert.equal(status, 200, "legacy page-based request must still succeed");
    const pagination = body.pagination as Record<string, unknown>;
    assert.ok(pagination, "legacy response must include the pagination envelope");
    assertPaginationWireTypes(pagination, "legacy contributions");
  }),
);

test(
  "#985 cursor-based pagination form parses during the transition",
  withServer(
    async (s) => {
      const { status, body } = await get(
        s,
        `/members/${VALID_G}/contributions?limit=2&cursor=0`,
      );
      assert.equal(status, 200, "cursor-based request must be accepted");
      // The cursor form must still expose the documented envelope fields so
      // consumers can migrate incrementally.
      const pagination = body.pagination as Record<string, unknown>;
      assert.ok(pagination, "cursor response must include the pagination envelope");
      assertPaginationWireTypes(pagination, "cursor contributions");
      // A cursor response must advertise the next cursor (null on last page).
      assert.ok(
        "nextCursor" in pagination,
        "cursor response must include nextCursor (null when exhausted)",
      );
    },
    {
      queryOne: async () => ({ count: "3", total_amount: "0" }),
    },
  ),
);

test(
  "#985 deprecated pagination parameter still works and is announced via headers",
  withServer(
    async (s) => {
      const { status, body, headers } = await getWithHeaders(
        s,
        `/circles/${VALID_C}/history?page=1&limit=2`,
      );
      assert.equal(status, 200, "deprecated page parameter must still be honoured");

      // The deprecation must be observable on the wire.
      assert.ok(
        headers["deprecation"] !== undefined,
        "deprecated pagination must send a Deprecation header",
      );
      assert.ok(
        headers["sunset"] !== undefined,
        "deprecated pagination must send a Sunset header",
      );

      // The legacy envelope must remain intact during the window.
      const pagination = body.pagination as Record<string, unknown>;
      assert.ok(pagination, "deprecated response must still include pagination");
      assertPaginationWireTypes(pagination, "deprecated history");
    },
    {
      queryOne: async () => ({ address: VALID_C }),
      queryExact: async () => ({ count: "5" }),
    },
  ),
);

test(
  "#985 /circles/:address/history envelope keeps documented wire types",
  withServer(
    async (s) => {
      const { status, body } = await get(
        s,
        `/circles/${VALID_C}/history?page=2&limit=3`,
      );
      assert.equal(status, 200);
      const pagination = body.pagination as Record<string, unknown>;
      assert.ok(pagination, "history response must include the pagination envelope");
      assertPaginationWireTypes(pagination, "history");
    },
    {
      queryOne: async () => ({ address: VALID_C }),
      queryExact: async () => ({ count: "5" }),
    },
  ),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-endpoint: all 400 validation responses include an error key
// ═══════════════════════════════════════════════════════════════════════════════

test(
  "#853 all history 400 responses carry a top-level error key",
  withServer(async (s) => {
    const badPaths = [
      `/members/${VALID_G}/contributions?limit=101`,
      `/members/${VALID_G}/contributions?limit=0`,
      `/members/${VALID_G}/contributions?page=0`,
      `/circles/${VALID_C}/history?limit=101`,
      `/circles/${VALID_C}/history?limit=0`,
      `/circles/${VALID_C}/history?page=0`,
    ];

    for (const path of badPaths) {
      const { status, body } = await get(s, path);
      assert.equal(status, 400, `${path} must return 400`);
      assert.ok(
        typeof body.error === "string" || typeof body.error === "object",
        `${path} 400 response must have a top-level error key`,
      );
    }
  }),
);
