/**
 * Tests for API input validation: address format, pagination, sorting,
 * and the circle query filter. All tests run against the in-process Express
 * app with a stubbed DB pool — no Postgres required.
 */

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// ── Stub the DB pool before importing the app ─────────────────────────────────
// pool.query is called by every route; return empty rows by default so routes
// reach the validation layer without hitting a real database.
import * as poolModule from "./db/pool";
(poolModule as any).query = async () => [];

// Stub the indexer module (imported by api.ts for `rpc` and `USDC`)
mock.module("./indexer", {
  namedExports: {
    rpc: {},
    USDC: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  },
});

// Stub health and groupRounds (not under test here)
mock.module("./health", {
  namedExports: { runAllHealthChecks: async () => ({ status: "ok" }) },
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

// ── Valid Stellar addresses used across tests ─────────────────────────────────
// Real strkey-shaped addresses (56 chars, correct prefix).
const VALID_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const VALID_G = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(
  server: http.Server,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    http.get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: {} });
        }
      });
    }).on("error", reject);
  });
}

function withServer(fn: (server: http.Server) => Promise<void>): () => Promise<void> {
  return async () => {
    const app = createApp();
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fn(server);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  };
}

// ── /circles — pagination & sort validation ───────────────────────────────────

test(
  "GET /circles: invalid page returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles?page=0");
    assert.equal(status, 400);
    assert.match(String(body.error), /page/);
  }),
);

test(
  "GET /circles: non-integer page returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles?page=abc");
    assert.equal(status, 400);
    assert.match(String(body.error), /page/);
  }),
);

test(
  "GET /circles: limit above MAX_LIMIT returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles?limit=999");
    assert.equal(status, 400);
    assert.match(String(body.error), /limit/);
  }),
);

test(
  "GET /circles: limit=0 returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles?limit=0");
    assert.equal(status, 400);
    assert.match(String(body.error), /limit/);
  }),
);

test(
  "GET /circles: unknown sort field returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles?sort=injected_col");
    assert.equal(status, 400);
    assert.match(String(body.error), /sort/);
  }),
);

test(
  "GET /circles: invalid order returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles?order=sideways");
    assert.equal(status, 400);
    assert.match(String(body.error), /order/);
  }),
);

test(
  "GET /circles: invalid status returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles?status=Hacked");
    assert.equal(status, 400);
    assert.match(String(body.error), /status/);
  }),
);

test(
  "GET /circles: multiple invalid params returns 400 with all errors",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles?page=0&sort=bad&order=up");
    assert.equal(status, 400);
    const msg = String(body.error);
    assert.match(msg, /page/);
    assert.match(msg, /sort/);
    assert.match(msg, /order/);
  }),
);

// ── /circles/:address — address format validation ─────────────────────────────

test(
  "GET /circles/:address: blank address returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles/%20");
    assert.equal(status, 400);
    assert.match(String(body.error), /address/i);
  }),
);

test(
  "GET /circles/:address: malformed address returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles/not-an-address");
    assert.equal(status, 400);
    assert.match(String(body.error), /Stellar address/i);
  }),
);

test(
  "GET /circles/:address: SQL injection attempt returns 400",
  withServer(async (s) => {
    const { status } = await request(s, "/circles/1%27%20OR%201%3D1--");
    assert.equal(status, 400);
  }),
);

// ── /circles/:address/members ─────────────────────────────────────────────────

test(
  "GET /circles/:address/members: malformed address returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles/BADADDR/members");
    assert.equal(status, 400);
    assert.match(String(body.error), /Stellar address/i);
  }),
);

// ── /circles/:address/rounds ──────────────────────────────────────────────────

test(
  "GET /circles/:address/rounds: malformed address returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/circles/BADADDR/rounds");
    assert.equal(status, 400);
    assert.match(String(body.error), /Stellar address/i);
  }),
);

// ── /members/:member/contributions ───────────────────────────────────────────

test(
  "GET /members/:member/contributions: malformed member returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/members/not-valid/contributions");
    assert.equal(status, 400);
    assert.match(String(body.error), /Stellar address/i);
  }),
);

test(
  "GET /members/:member/contributions: malformed ?circle= returns 400",
  withServer(async (s) => {
    const { status, body } = await request(
      s,
      `/members/${VALID_G}/contributions?circle=bad-addr`,
    );
    assert.equal(status, 400);
    assert.match(String(body.error), /Stellar address/i);
  }),
);

test(
  "GET /members/:member/contributions: SQL injection in ?circle= returns 400",
  withServer(async (s) => {
    const { status } = await request(
      s,
      `/members/${VALID_G}/contributions?circle=1%27%3BDROP%20TABLE%20circles--`,
    );
    assert.equal(status, 400);
  }),
);

// ── /reputation/:member ───────────────────────────────────────────────────────

test(
  "GET /reputation/:member: malformed member returns 400",
  withServer(async (s) => {
    const { status, body } = await request(s, "/reputation/not-valid");
    assert.equal(status, 400);
    assert.match(String(body.error), /Stellar address/i);
  }),
);

test(
  "GET /reputation/:member: malformed ?circle= returns 400",
  withServer(async (s) => {
    const { status, body } = await request(
      s,
      `/reputation/${VALID_G}?circle=bad-addr`,
    );
    assert.equal(status, 400);
    assert.match(String(body.error), /Stellar address/i);
  }),
);

// ── Sort allowlist — SQL injection via sort param ─────────────────────────────

test(
  "GET /circles: sort=created_ledger;DROP TABLE circles-- returns 400",
  withServer(async (s) => {
    const { status } = await request(
      s,
      "/circles?sort=created_ledger%3BDROP%20TABLE%20circles--",
    );
    assert.equal(status, 400);
  }),
);

test(
  "GET /circles: sort=1 OR 1=1 returns 400",
  withServer(async (s) => {
    const { status } = await request(s, "/circles?sort=1%20OR%201%3D1");
    assert.equal(status, 400);
  }),
);
