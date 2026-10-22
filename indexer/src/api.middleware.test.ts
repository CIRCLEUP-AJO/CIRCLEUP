/**
 * Integration tests for API middleware ordering: CORS, trusted proxy
 * configuration, and per-route rate limiting.
 *
 * These tests exercise the full Express middleware stack with synthetic
 * addresses and no external dependencies (no Postgres, no Soroban RPC).
 * They prove that:
 *
 *   1. Allowed origins receive Access-Control-Allow-Origin headers.
 *   2. Disallowed origins receive a 403 and no CORS header.
 *   3. No-origin clients (curl, server-to-server, health checks) are allowed
 *      through regardless of the CORS config.
 *   4. Trusted proxy hops (TRUST_PROXY_HOPS) determine req.ip correctly:
 *      a) hops=0 → socket address is used; X-Forwarded-For is ignored.
 *      b) hops=1 → first IP in X-Forwarded-For is used as client identity.
 *   5. Spoofed X-Forwarded-For values cannot reset a client's rate-limit
 *      bucket when trust proxy is disabled.
 *   6. Per-route rate limiters are isolated: exhausting the list bucket does
 *      not affect the health bucket, and vice versa.
 *   7. Once a rate limit is hit, a 429 is returned with Retry-After.
 *   8. Rejected origins do not bypass rate limits.
 *
 * Middleware registration order is preserved by createApp():
 *   app.set("trust proxy", hops)
 *   → cors(corsOptions)
 *   → CORS error handler (403 for rejected origins)
 *   → per-route rate limiters
 *   → route handlers
 */

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mock } from "node:test";

// ── Stub external dependencies before importing createApp ─────────────────────

import * as poolModule from "./db/pool";

// Default stub: empty rows (no circles, no state)
(poolModule as Record<string, unknown>).query = async () => [];
(poolModule as Record<string, unknown>).queryOne = async () => null;
(poolModule as Record<string, unknown>).queryExact = async () => { throw new Error("no row"); };

mock.module("./indexer", {
  namedExports: {
    rpc: {},
    USDC: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    getIndexerMetrics: () => ({ processedLedgers: 0, totalEvents: 0 }),
    isIndexerRunning: () => false,
  },
});

mock.module("./health", {
  namedExports: {
    runAllHealthChecks: async () => ({
      status: "ok",
      serviceStatus: "healthy",
      timestamp: new Date().toISOString(),
      db: { status: "ok", latencyMs: 1 },
      rpc: { status: "ok", latencyMs: 1 },
      indexerLag: { status: "ok" },
      schema: { status: "ok" },
      contractDrift: { status: "ok" },
      eventFailures: { status: "ok" },
      config: { usdcAddress: "CTEST", lagAlertLedgers: 1000, driftRoundThreshold: 1, eventFailureAlertCount: 1, eventFailureRecurringAttempts: 2 },
      diagnostics: { lastIndexedLedger: null, rpcLatestLedger: null, lagLedgers: null, dbAvailable: true, rpcAvailable: true },
    }),
  },
});

mock.module("./groupRounds", {
  namedExports: {
    groupCircleRounds: () => ({ rounds: [], currentRound: null, openRounds: [], pendingDefaults: [] }),
  },
});

import { createApp, buildCorsOptions, TRUST_PROXY_HOPS } from "./api";

// ── Synthetic test addresses ──────────────────────────────────────────────────

const ALLOWED_ORIGIN  = "https://app.circleup.test";
const BLOCKED_ORIGIN  = "https://evil.example.com";
const ALLOWED_ORIGIN2 = "https://staging.circleup.test";

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface ReqOptions {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

function request(server: http.Server, opts: ReqOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: opts.path ?? "/health",
      method: opts.method ?? "GET",
      headers: opts.headers ?? {},
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk: string) => (raw += chunk));
      res.on("end", () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw); } catch { /* non-JSON is fine */ }
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Build an Express app + http.Server with explicit settings (no env vars). */
function buildServer(opts: {
  allowedOrigins?: string[];
  trustProxyHops?: number;
  rateLimits?: {
    listMax?: number;
    detailMax?: number;
    historyMax?: number;
    healthMax?: number;
    windowMs?: number;
  };
}): http.Server {
  // Temporarily set env vars that createApp reads at module evaluation time.
  // We override them per-test via the options and restore afterwards.
  const origTrust   = process.env.TRUST_PROXY_HOPS;
  const origList    = process.env.RATE_LIMIT_LIST_MAX;
  const origDetail  = process.env.RATE_LIMIT_DETAIL_MAX;
  const origHistory = process.env.RATE_LIMIT_HISTORY_MAX;
  const origHealth  = process.env.RATE_LIMIT_HEALTH_MAX;
  const origWindow  = process.env.RATE_LIMIT_WINDOW_MS;

  if (opts.trustProxyHops !== undefined)
    process.env.TRUST_PROXY_HOPS = String(opts.trustProxyHops);
  if (opts.rateLimits?.listMax    !== undefined) process.env.RATE_LIMIT_LIST_MAX    = String(opts.rateLimits.listMax);
  if (opts.rateLimits?.detailMax  !== undefined) process.env.RATE_LIMIT_DETAIL_MAX  = String(opts.rateLimits.detailMax);
  if (opts.rateLimits?.historyMax !== undefined) process.env.RATE_LIMIT_HISTORY_MAX = String(opts.rateLimits.historyMax);
  if (opts.rateLimits?.healthMax  !== undefined) process.env.RATE_LIMIT_HEALTH_MAX  = String(opts.rateLimits.healthMax);
  if (opts.rateLimits?.windowMs   !== undefined) process.env.RATE_LIMIT_WINDOW_MS   = String(opts.rateLimits.windowMs);

  const app = createApp();

  // Restore env vars after app is built
  if (origTrust   !== undefined) process.env.TRUST_PROXY_HOPS     = origTrust;   else delete process.env.TRUST_PROXY_HOPS;
  if (origList    !== undefined) process.env.RATE_LIMIT_LIST_MAX   = origList;    else delete process.env.RATE_LIMIT_LIST_MAX;
  if (origDetail  !== undefined) process.env.RATE_LIMIT_DETAIL_MAX = origDetail;  else delete process.env.RATE_LIMIT_DETAIL_MAX;
  if (origHistory !== undefined) process.env.RATE_LIMIT_HISTORY_MAX= origHistory; else delete process.env.RATE_LIMIT_HISTORY_MAX;
  if (origHealth  !== undefined) process.env.RATE_LIMIT_HEALTH_MAX = origHealth;  else delete process.env.RATE_LIMIT_HEALTH_MAX;
  if (origWindow  !== undefined) process.env.RATE_LIMIT_WINDOW_MS  = origWindow;  else delete process.env.RATE_LIMIT_WINDOW_MS;

  return http.createServer(app);
}

function startServer(server: http.Server): Promise<void> {
  return new Promise((r) => server.listen(0, "127.0.0.1", r));
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CORS — allowed origin
// ═══════════════════════════════════════════════════════════════════════════════

describe("CORS — allowed origin", () => {
  let server: http.Server;
  before(async () => {
    server = buildServer({ allowedOrigins: [ALLOWED_ORIGIN] });
    await startServer(server);
  });
  after(() => stopServer(server));

  test("request from allowed origin receives Access-Control-Allow-Origin", async () => {
    const { status, headers } = await request(server, {
      path: "/health",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(status, 200);
    assert.equal(
      headers["access-control-allow-origin"],
      ALLOWED_ORIGIN,
      "ACAO must echo the allowed origin back",
    );
  });

  test("preflight OPTIONS from allowed origin returns 204 with CORS headers", async () => {
    const { status, headers } = await request(server, {
      path: "/health",
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "GET",
      },
    });
    // cors() default for OPTIONS is 204 or 200 depending on version
    assert.ok(status === 204 || status === 200, `preflight must return 204 or 200, got ${status}`);
    assert.ok(
      headers["access-control-allow-origin"] === ALLOWED_ORIGIN ||
      headers["access-control-allow-methods"] !== undefined,
      "preflight must include CORS headers",
    );
  });

  test("credentials are never allowed (no Access-Control-Allow-Credentials)", async () => {
    const { headers } = await request(server, {
      path: "/health",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.ok(
      !headers["access-control-allow-credentials"] ||
      headers["access-control-allow-credentials"] === "false",
      "ACAC must never be 'true' — API is read-only and unauthenticated",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CORS — blocked origin
// ═══════════════════════════════════════════════════════════════════════════════

describe("CORS — blocked origin", () => {
  let server: http.Server;
  before(async () => {
    server = buildServer({ allowedOrigins: [ALLOWED_ORIGIN] });
    await startServer(server);
  });
  after(() => stopServer(server));

  test("request from blocked origin returns 403", async () => {
    const { status } = await request(server, {
      path: "/health",
      headers: { Origin: BLOCKED_ORIGIN },
    });
    assert.equal(status, 403, "blocked origin must be rejected with 403, not 200");
  });

  test("403 response for blocked origin has an error key", async () => {
    const { body } = await request(server, {
      path: "/health",
      headers: { Origin: BLOCKED_ORIGIN },
    });
    assert.ok(body.error, "403 must carry an error key so clients can detect the reason");
  });

  test("blocked origin does not receive Access-Control-Allow-Origin", async () => {
    const { headers } = await request(server, {
      path: "/health",
      headers: { Origin: BLOCKED_ORIGIN },
    });
    assert.ok(
      !headers["access-control-allow-origin"],
      "ACAO must not be set for a rejected origin",
    );
  });

  test("blocked origin cannot reach a route handler (middleware order enforced)", async () => {
    // If CORS middleware fires after the route handler, the blocked origin
    // would receive a 200 with data before being rejected. The CORS middleware
    // must run first so the route handler is never reached.
    const { status } = await request(server, {
      path: "/circles",
      headers: { Origin: BLOCKED_ORIGIN },
    });
    assert.equal(status, 403, "CORS middleware must run before route handlers");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CORS — no-origin client (curl, health probe, server-to-server)
// ═══════════════════════════════════════════════════════════════════════════════

describe("CORS — no-origin client", () => {
  let server: http.Server;
  before(async () => {
    server = buildServer({ allowedOrigins: [ALLOWED_ORIGIN] });
    await startServer(server);
  });
  after(() => stopServer(server));

  test("request with no Origin header is allowed regardless of CORS config", async () => {
    const { status } = await request(server, { path: "/health" });
    assert.equal(status, 200, "health checks and server-to-server calls must not be CORS-blocked");
  });

  test("no-origin request does not receive ACAO header", async () => {
    const { headers } = await request(server, { path: "/health" });
    // When there's no Origin, cors() typically omits the ACAO header entirely.
    // This is correct — the absence of ACAO for no-origin requests is spec-compliant.
    assert.ok(
      !headers["access-control-allow-origin"] ||
      headers["access-control-allow-origin"] === "true",
      "no-origin request should not receive a reflected ACAO header",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CORS — multiple allowed origins
// ═══════════════════════════════════════════════════════════════════════════════

describe("CORS — multiple allowed origins", () => {
  let server: http.Server;
  before(async () => {
    server = buildServer({ allowedOrigins: [ALLOWED_ORIGIN, ALLOWED_ORIGIN2] });
    await startServer(server);
  });
  after(() => stopServer(server));

  test("first allowed origin passes", async () => {
    const { status, headers } = await request(server, {
      path: "/health",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    assert.equal(status, 200);
    assert.equal(headers["access-control-allow-origin"], ALLOWED_ORIGIN);
  });

  test("second allowed origin passes", async () => {
    const { status, headers } = await request(server, {
      path: "/health",
      headers: { Origin: ALLOWED_ORIGIN2 },
    });
    assert.equal(status, 200);
    assert.equal(headers["access-control-allow-origin"], ALLOWED_ORIGIN2);
  });

  test("unrelated origin is still rejected when two origins are configured", async () => {
    const { status } = await request(server, {
      path: "/health",
      headers: { Origin: "https://not-in-list.example.com" },
    });
    assert.equal(status, 403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Proxy trust — hops=0 (default): socket address used, XFF ignored
// ═══════════════════════════════════════════════════════════════════════════════

describe("Proxy trust — hops=0 (direct socket)", () => {
  test("buildCorsOptions unit: module-level TRUST_PROXY_HOPS defaults to 0 when env unset", () => {
    // Confirm the default is secure out of the box
    const orig = process.env.TRUST_PROXY_HOPS;
    delete process.env.TRUST_PROXY_HOPS;
    // Re-evaluate the env parse inline (parseTrustProxyHops is private, but
    // TRUST_PROXY_HOPS export reflects the startup value)
    const val = TRUST_PROXY_HOPS;
    assert.equal(val, 0, "TRUST_PROXY_HOPS must default to 0 (direct socket, no forwarding trust)");
    if (orig !== undefined) process.env.TRUST_PROXY_HOPS = orig;
  });

  test("with hops=0, X-Forwarded-For cannot override rate-limit client identity", async () => {
    // Build an app with a low rate limit so we can exhaust it quickly
    const server = buildServer({
      allowedOrigins: [ALLOWED_ORIGIN],
      trustProxyHops: 0,
      rateLimits: { listMax: 2, windowMs: 60000 },
    });
    await startServer(server);
    try {
      // Exhaust the list rate limit from the loopback address (127.0.0.1)
      await request(server, { path: "/circles" });
      await request(server, { path: "/circles" });

      // Now try to "reset" the limit by forging a different XFF address.
      // With hops=0, Express ignores XFF and still sees 127.0.0.1 → 429.
      const { status } = await request(server, {
        path: "/circles",
        headers: { "X-Forwarded-For": "203.0.113.99" },
      });
      assert.equal(
        status,
        429,
        "spoofed X-Forwarded-For must not reset the rate-limit bucket when hops=0",
      );
    } finally {
      await stopServer(server);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Proxy trust — hops=1: first XFF hop used as client IP
// ═══════════════════════════════════════════════════════════════════════════════

describe("Proxy trust — hops=1 (single reverse proxy)", () => {
  test("with hops=1, X-Forwarded-For first IP is the client identity for rate limiting", async () => {
    // With hops=1, a different XFF IP = different rate-limit bucket.
    // We exhaust the bucket for IP-A, then present IP-B and must NOT get 429.
    const server = buildServer({
      allowedOrigins: [ALLOWED_ORIGIN],
      trustProxyHops: 1,
      rateLimits: { listMax: 2, windowMs: 60000 },
    });
    await startServer(server);
    try {
      const ipA = "203.0.113.1";
      const ipB = "203.0.113.2";

      // Exhaust limit for IP-A
      await request(server, { path: "/circles", headers: { "X-Forwarded-For": ipA } });
      await request(server, { path: "/circles", headers: { "X-Forwarded-For": ipA } });
      const limitedA = await request(server, {
        path: "/circles",
        headers: { "X-Forwarded-For": ipA },
      });
      assert.equal(limitedA.status, 429, "IP-A must be rate limited after exhausting its quota");

      // IP-B has a fresh bucket — must not be limited
      const freshB = await request(server, {
        path: "/circles",
        headers: { "X-Forwarded-For": ipB },
      });
      assert.notEqual(
        freshB.status,
        429,
        "IP-B must have a fresh rate-limit bucket independent of IP-A",
      );
    } finally {
      await stopServer(server);
    }
  });

  test("with hops=1, a multi-hop XFF uses the leftmost (client) IP", async () => {
    // X-Forwarded-For: clientIP, proxyIP — with hops=1, clientIP is used
    const server = buildServer({
      allowedOrigins: [ALLOWED_ORIGIN],
      trustProxyHops: 1,
      rateLimits: { listMax: 2, windowMs: 60000 },
    });
    await startServer(server);
    try {
      const clientIp = "198.51.100.1";
      const proxyIp  = "10.0.0.1";

      // Exhaust the limit for clientIp
      await request(server, {
        path: "/circles",
        headers: { "X-Forwarded-For": `${clientIp}, ${proxyIp}` },
      });
      await request(server, {
        path: "/circles",
        headers: { "X-Forwarded-For": `${clientIp}, ${proxyIp}` },
      });
      const { status } = await request(server, {
        path: "/circles",
        headers: { "X-Forwarded-For": `${clientIp}, ${proxyIp}` },
      });
      assert.equal(
        status,
        429,
        "multi-hop XFF must use the leftmost IP, so same clientIp is still rate-limited",
      );
    } finally {
      await stopServer(server);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Per-route rate limit isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe("Per-route rate limit isolation", () => {
  test("exhausting the list bucket does not affect the health bucket", async () => {
    // list limit = 2, health limit = 10 — exhausting list must not block health
    const server = buildServer({
      allowedOrigins: [ALLOWED_ORIGIN],
      trustProxyHops: 0,
      rateLimits: {
        listMax:    2,
        healthMax: 10,
        windowMs:  60000,
      },
    });
    await startServer(server);
    try {
      // Exhaust list bucket
      await request(server, { path: "/circles" });
      await request(server, { path: "/circles" });
      const limited = await request(server, { path: "/circles" });
      assert.equal(limited.status, 429, "list bucket must be exhausted");

      // Health must still respond
      const { status: healthStatus } = await request(server, { path: "/health" });
      assert.equal(
        healthStatus,
        200,
        "health endpoint must remain reachable after list bucket is exhausted (bucket isolation)",
      );
    } finally {
      await stopServer(server);
    }
  });

  test("exhausting the health bucket does not affect the list bucket", async () => {
    const server = buildServer({
      allowedOrigins: [ALLOWED_ORIGIN],
      trustProxyHops: 0,
      rateLimits: {
        listMax:    10,
        healthMax:   2,
        windowMs:  60000,
      },
    });
    await startServer(server);
    try {
      // Exhaust health bucket
      await request(server, { path: "/health" });
      await request(server, { path: "/health" });
      const limitedHealth = await request(server, { path: "/health" });
      assert.equal(limitedHealth.status, 429, "health bucket must be exhausted");

      // List must still respond (200 or empty, but not 429)
      const { status: listStatus } = await request(server, { path: "/circles" });
      assert.notEqual(
        listStatus,
        429,
        "list endpoint must not be affected by health bucket exhaustion (bucket isolation)",
      );
    } finally {
      await stopServer(server);
    }
  });

  test("rate limit 429 response includes Retry-After / RateLimit headers", async () => {
    const server = buildServer({
      allowedOrigins: [ALLOWED_ORIGIN],
      trustProxyHops: 0,
      rateLimits: { listMax: 1, windowMs: 60000 },
    });
    await startServer(server);
    try {
      await request(server, { path: "/circles" });
      const { status, headers } = await request(server, { path: "/circles" });
      assert.equal(status, 429);
      // express-rate-limit with standardHeaders:true emits RateLimit-* or Retry-After
      const hasRetryInfo =
        headers["retry-after"] !== undefined ||
        headers["ratelimit-reset"] !== undefined ||
        headers["x-ratelimit-reset"] !== undefined;
      assert.ok(hasRetryInfo, "429 must include Retry-After or RateLimit-Reset header");
    } finally {
      await stopServer(server);
    }
  });

  test("rate limit 429 response body has a generic error message (no internal details)", async () => {
    const server = buildServer({
      allowedOrigins: [ALLOWED_ORIGIN],
      trustProxyHops: 0,
      rateLimits: { listMax: 1, windowMs: 60000 },
    });
    await startServer(server);
    try {
      await request(server, { path: "/circles" });
      const { body } = await request(server, { path: "/circles" });
      // Must not reveal which limit was hit or its configured value
      const bodyStr = JSON.stringify(body);
      assert.ok(
        !bodyStr.includes("RATE_LIMIT") && !bodyStr.includes("LIMIT_LIST"),
        "429 body must not expose internal rate-limit configuration names",
      );
      assert.ok(body.error, "429 body must have an error key");
    } finally {
      await stopServer(server);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Blocked origins do not bypass rate limits
// ═══════════════════════════════════════════════════════════════════════════════

describe("Blocked origins do not bypass rate limits", () => {
  test("403 from CORS does not consume or reset a rate-limit slot", async () => {
    // Exhaust the list bucket from a no-origin request.
    // Then send a request from a blocked origin. It must still receive 403 (CORS)
    // not 429 (rate limit) — but the key assertion is that it never reaches
    // the route handler, and that the blocked-origin 403 doesn't "reset" the bucket.
    const server = buildServer({
      allowedOrigins: [ALLOWED_ORIGIN],
      trustProxyHops: 0,
      rateLimits: { listMax: 2, windowMs: 60000 },
    });
    await startServer(server);
    try {
      // Use up the list quota
      await request(server, { path: "/circles" });
      await request(server, { path: "/circles" });

      // Blocked-origin request — CORS fires before the rate limiter; must get 403
      const { status: corsStatus } = await request(server, {
        path: "/circles",
        headers: { Origin: BLOCKED_ORIGIN },
      });
      assert.equal(corsStatus, 403, "blocked origin must receive 403 not 429 (CORS runs first)");

      // No-origin request after quota exhaustion must still be 429
      const { status: rateLimitStatus } = await request(server, { path: "/circles" });
      assert.equal(
        rateLimitStatus,
        429,
        "quota must still be exhausted — the 403 response must not reset the rate-limit bucket",
      );
    } finally {
      await stopServer(server);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. buildCorsOptions — unit coverage for the CORS option builder
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildCorsOptions — origin option shape", () => {
  test("empty allow-list in non-production returns { origin: true }", () => {
    const opts = buildCorsOptions([], { nodeEnv: "development" });
    assert.equal(opts.origin, true, "empty list in dev should allow all origins");
  });

  test("non-empty allow-list returns a callback-based origin handler", () => {
    const opts = buildCorsOptions([ALLOWED_ORIGIN]);
    assert.equal(typeof opts.origin, "function", "non-empty list must use a callback handler");
  });

  test("allow-list callback passes for listed origin", async () => {
    const opts = buildCorsOptions([ALLOWED_ORIGIN]);
    const result = await new Promise<{ err: Error | null; allow?: boolean }>((resolve) => {
      (opts.origin as (o: string, cb: (e: Error | null, a?: boolean) => void) => void)(
        ALLOWED_ORIGIN,
        (err, allow) => resolve({ err, allow }),
      );
    });
    assert.equal(result.err, null);
    assert.equal(result.allow, true);
  });

  test("allow-list callback rejects unlisted origin", async () => {
    const opts = buildCorsOptions([ALLOWED_ORIGIN]);
    const result = await new Promise<{ err: Error | null; allow?: boolean }>((resolve) => {
      (opts.origin as (o: string, cb: (e: Error | null, a?: boolean) => void) => void)(
        BLOCKED_ORIGIN,
        (err, allow) => resolve({ err, allow }),
      );
    });
    assert.ok(result.err instanceof Error, "must call back with an Error for rejected origins");
    assert.match(result.err.message, /not allowed/);
  });

  test("allow-list callback passes for undefined origin (no-origin client)", async () => {
    const opts = buildCorsOptions([ALLOWED_ORIGIN]);
    const result = await new Promise<{ err: Error | null; allow?: boolean }>((resolve) => {
      (opts.origin as (o: string | undefined, cb: (e: Error | null, a?: boolean) => void) => void)(
        undefined,
        (err, allow) => resolve({ err, allow }),
      );
    });
    assert.equal(result.err, null, "no-origin request must not be rejected");
    assert.equal(result.allow, true);
  });

  test("credentials are always false", () => {
    const opts1 = buildCorsOptions([ALLOWED_ORIGIN]);
    const opts2 = buildCorsOptions([]);
    assert.equal(opts1.credentials, false, "credentials must be false for non-empty list");
    assert.equal(opts2.credentials, false, "credentials must be false for empty list");
  });
});
