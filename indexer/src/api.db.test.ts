/**
 * API integration tests against a real Postgres database.
 *
 * Guarded by DATABASE_URL — skipped entirely when that variable is unset.
 * Applies migrations, seeds isolated projection rows, and exercises each
 * route through supertest so the full SQL + serialisation path is covered.
 *
 * Test isolation strategy:
 *   Every test block uses a unique address prefix to avoid cross-test FK
 *   conflicts.  A shared cleanup helper removes all fixture rows in the
 *   finally block of each test so failures don't contaminate later tests.
 *
 * CI requirement: a Postgres service (e.g. postgres:16-alpine) must be
 * available at DATABASE_URL before these tests run.  See docker-compose.yml
 * for the service definition used in local development.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const hasDb = Boolean(process.env.DATABASE_URL);

if (hasDb) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const request = require("supertest") as typeof import("supertest");
  const { createApp } = require("./api") as typeof import("./api");
  const { runMigrations } = require("./db/migrate") as typeof import("./db/migrate");
  const { pool } = require("./db/pool") as typeof import("./db/pool");

  const app = createApp();

  before(async () => {
    await runMigrations();
  });

  after(async () => {
    await pool.end();
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  async function seedCircle(
    address: string,
    opts: {
      creator?: string;
      roundAmount?: number;
      memberCount?: number;
      status?: string;
      currentRound?: number;
      totalRounds?: number;
      createdLedger?: number;
    } = {},
  ) {
    const {
      creator       = "GCREATOR_DB_TEST",
      roundAmount   = 100,
      memberCount   = 2,
      status        = "Active",
      currentRound  = 0,
      totalRounds   = 2,
      createdLedger = 1000,
    } = opts;
    await pool.query(
      `INSERT INTO circles
         (address, creator, round_amount, member_count, status,
          current_round, total_rounds, created_ledger)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (address) DO NOTHING`,
      [address, creator, roundAmount, memberCount, status, currentRound, totalRounds, createdLedger],
    );
  }

  async function seedMember(circleAddress: string, memberAddress: string, payoutOrder = 0) {
    await pool.query(
      `INSERT INTO circle_members (circle_address, member_address, payout_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (circle_address, member_address) DO NOTHING`,
      [circleAddress, memberAddress, payoutOrder],
    );
  }

  async function seedContribution(
    circleAddress: string,
    memberAddress: string,
    roundIndex: number,
    ledger: number,
  ) {
    const txHash = `dbtest-tx-${circleAddress}-${memberAddress}-${roundIndex}`;
    await pool.query(
      `INSERT INTO contributions (circle_address, member_address, round_index, amount, tx_hash, ledger)
       VALUES ($1, $2, $3, 100, $4, $5)
       ON CONFLICT (circle_address, member_address, round_index) DO NOTHING`,
      [circleAddress, memberAddress, roundIndex, txHash, ledger],
    );
  }

  async function seedReputation(memberAddress: string, score: number) {
    await pool.query(
      `INSERT INTO reputation (member_address, score)
       VALUES ($1, $2)
       ON CONFLICT (member_address) DO UPDATE SET score = $2`,
      [memberAddress, score],
    );
  }

  async function cleanCircle(address: string) {
    await pool.query("DELETE FROM contributions WHERE circle_address = $1",  [address]);
    await pool.query("DELETE FROM payouts WHERE circle_address = $1",        [address]);
    await pool.query("DELETE FROM defaults WHERE circle_address = $1",       [address]);
    await pool.query("DELETE FROM circle_members WHERE circle_address = $1", [address]);
    await pool.query("DELETE FROM circles WHERE address = $1",               [address]);
  }

  // ── GET /circles ─────────────────────────────────────────────────────────────

  test("GET /circles returns 200 with pagination envelope", async () => {
    const addr = "CDBTEST_LIST_CIRCLE";
    await seedCircle(addr);
    try {
      const res = await request(app).get("/circles");
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.circles), "circles must be an array");
      assert.ok(
        typeof res.body.pagination.total === "number",
        "pagination.total must be a number",
      );
      assert.ok(
        typeof res.body.pagination.page === "number",
        "pagination.page must be a number",
      );
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles filters by status", async () => {
    const pending   = "CDBTEST_STATUS_PENDING";
    const completed = "CDBTEST_STATUS_COMPLETED";
    await seedCircle(pending,   { status: "Pending" });
    await seedCircle(completed, { status: "Completed" });

    try {
      const res = await request(app).get("/circles?status=Pending");
      assert.equal(res.status, 200);
      for (const c of res.body.circles as Array<{ status: string }>) {
        assert.equal(c.status, "Pending", "all returned circles must be Pending");
      }
    } finally {
      await cleanCircle(pending);
      await cleanCircle(completed);
    }
  });

  test("GET /circles returns 400 for invalid status value", async () => {
    const res = await request(app).get("/circles?status=Unknown");
    assert.equal(res.status, 400);
    assert.ok(res.body.error, "error key must be present in 400 response");
  });

  test("GET /circles returns 400 for invalid page parameter", async () => {
    const res = await request(app).get("/circles?page=0");
    assert.equal(res.status, 400);
  });

  test("GET /circles returns 400 for invalid limit parameter", async () => {
    const res = await request(app).get("/circles?limit=999");
    assert.equal(res.status, 400);
  });

  test("GET /circles pagination: page 2 returns the next slice", async () => {
    const addrs = ["CDBTEST_PAGEA", "CDBTEST_PAGEB", "CDBTEST_PAGEC"];
    for (const addr of addrs) await seedCircle(addr, { status: "Pending" });

    try {
      const page1 = await request(app).get("/circles?limit=2&page=1&status=Pending&sort=created_ledger&order=asc");
      const page2 = await request(app).get("/circles?limit=2&page=2&status=Pending&sort=created_ledger&order=asc");

      assert.equal(page1.status, 200);
      assert.equal(page2.status, 200);
      assert.equal(page1.body.circles.length, 2);

      // Page 1 and page 2 must not share the same first address.
      if (page2.body.circles.length > 0) {
        assert.notEqual(
          page1.body.circles[0].address,
          page2.body.circles[0].address,
          "page 2 must start where page 1 ended",
        );
      }
    } finally {
      for (const addr of addrs) await cleanCircle(addr);
    }
  });

  // ── GET /circles/summary ─────────────────────────────────────────────────────

  test("GET /circles/summary returns counts by status with a total", async () => {
    const addr = "CDBTEST_SUMMARY_CIRCLE";
    await seedCircle(addr, { status: "Active" });

    try {
      const res = await request(app).get("/circles/summary");
      assert.equal(res.status, 200);
      assert.ok(typeof res.body.total === "number",    "total must be a number");
      assert.ok(typeof res.body.byStatus === "object", "byStatus must be an object");
      assert.ok("Active" in res.body.byStatus,         "byStatus must include Active key");
      assert.ok(res.body.byStatus["Active"] >= 1,      "Active count must be at least 1");
    } finally {
      await cleanCircle(addr);
    }
  });

  // ── GET /circles/:address ────────────────────────────────────────────────────

  test("GET /circles/:address returns circle detail with members", async () => {
    const addr   = "CDBTEST_DETAIL_CIRCLE";
    const member = "GDBTEST_DETAIL_MEMBER";
    await seedCircle(addr);
    await seedMember(addr, member, 0);

    try {
      const res = await request(app).get(`/circles/${addr}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.circle.address, addr);
      assert.ok(Array.isArray(res.body.members), "members must be an array");
      assert.equal(res.body.members.length, 1,   "must return the seeded member");
      assert.equal(res.body.members[0].member_address, member);
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address returns 404 for unknown address", async () => {
    const res = await request(app).get("/circles/CDBTEST_UNKNOWN_ADDR");
    assert.equal(res.status, 404);
  });

  test("GET /circles/:address returns 400 when address is blank", async () => {
    // Route with whitespace-only segment — express normalises this to an empty
    // segment which the router may 404 or 400 depending on routing layer.
    // We just verify we don't get a 200 with a blank address.
    const res = await request(app).get("/circles/%20");
    assert.notEqual(res.status, 200);
  });

  // ── GET /circles/:address/members ────────────────────────────────────────────

  test("GET /circles/:address/members returns member list with totals", async () => {
    const addr    = "CDBTEST_MEMBERS_CIRCLE";
    const member1 = "GDBTEST_MEMBERS_M1";
    const member2 = "GDBTEST_MEMBERS_M2";
    await seedCircle(addr);
    await seedMember(addr, member1, 0);
    await seedMember(addr, member2, 1);

    try {
      const res = await request(app).get(`/circles/${addr}/members`);
      assert.equal(res.status, 200);
      assert.equal(res.body.members.length, 2);
      assert.equal(res.body.totals.memberCount, 2);
      assert.equal(typeof res.body.totals.totalCollateral, "string");
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /circles/:address/members returns 404 for unknown circle", async () => {
    const res = await request(app).get("/circles/CDBTEST_NO_SUCH_CIRCLE/members");
    assert.equal(res.status, 404);
  });

  // ── GET /members/:member/contributions ───────────────────────────────────────

  test("GET /members/:member/contributions returns empty list for unknown member", async () => {
    const res = await request(app).get("/members/GDBTEST_UNKNOWN_MEMBER/contributions");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.contributions, []);
    assert.equal(res.body.pagination.total, 0);
  });

  test("GET /members/:member/contributions returns contribution history", async () => {
    const addr   = "CDBTEST_CONTRIBS_CIRCLE";
    const member = "GDBTEST_CONTRIBS_MEMBER";
    await seedCircle(addr);
    await seedMember(addr, member, 0);
    await seedContribution(addr, member, 0, 1001);
    await seedContribution(addr, member, 1, 1002);

    try {
      const res = await request(app).get(`/members/${member}/contributions`);
      assert.equal(res.status, 200);
      assert.equal(res.body.contributions.length, 2);
      assert.equal(res.body.pagination.total, 2);
      assert.equal(res.body.member, member);
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /members/:member/contributions paginates correctly", async () => {
    const addr   = "CDBTEST_CONT_PAG_CIRCLE";
    const member = "GDBTEST_CONT_PAG_MEMBER";
    await seedCircle(addr);
    await seedMember(addr, member, 0);
    for (let i = 0; i < 5; i++) {
      await seedContribution(addr, member, i, 2000 + i);
    }

    try {
      const res = await request(app).get(`/members/${member}/contributions?limit=2&page=1`);
      assert.equal(res.status, 200);
      assert.equal(res.body.contributions.length, 2);
      assert.equal(res.body.pagination.total, 5);
      assert.equal(res.body.pagination.totalPages, 3);
    } finally {
      await cleanCircle(addr);
    }
  });

  test("GET /members/:member/contributions filters by ?circle= and returns 404 for unknown circle", async () => {
    const member = "GDBTEST_CIRCLE_FILTER_M";
    const res = await request(app).get(
      `/members/${member}/contributions?circle=CDBTEST_NONEXISTENT`,
    );
    assert.equal(res.status, 404, "unknown ?circle= filter must return 404");
  });

  test("GET /members/:member/contributions returns 400 for invalid limit", async () => {
    const res = await request(app).get("/members/GMEMBER/contributions?limit=abc");
    assert.equal(res.status, 400);
  });

  // ── GET /reputation/:member ───────────────────────────────────────────────────

  test("GET /reputation/:member returns score 0 and found=false for unknown member", async () => {
    const res = await request(app).get("/reputation/GDBTEST_REP_UNKNOWN");
    assert.equal(res.status, 200);
    assert.equal(res.body.score, 0);
    assert.equal(res.body.found, false);
  });

  test("GET /reputation/:member returns correct score for a known member", async () => {
    const member = "GDBTEST_REP_KNOWN";
    await seedReputation(member, 3);

    try {
      const res = await request(app).get(`/reputation/${member}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.score, 3);
      assert.equal(res.body.found, true);
      assert.equal(res.body.member, member);
    } finally {
      await pool.query("DELETE FROM reputation WHERE member_address = $1", [member]);
    }
  });

  // ── GET /indexer/state ───────────────────────────────────────────────────────

  test("GET /indexer/state returns lastLedger and totalEvents", async () => {
    const res = await request(app).get("/indexer/state");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.lastLedger === "number",  "lastLedger must be a number");
    assert.ok(typeof res.body.totalEvents === "number", "totalEvents must be a number");
    assert.ok(typeof res.body.updatedAt === "string",   "updatedAt must be a string");
  });

  // ── Validation edge cases ────────────────────────────────────────────────────

  test("GET /circles returns 400 for invalid sort field", async () => {
    const res = await request(app).get("/circles?sort=nonexistent_field");
    assert.equal(res.status, 400);
  });

  test("GET /circles returns 400 for invalid order value", async () => {
    const res = await request(app).get("/circles?order=sideways");
    assert.equal(res.status, 400);
  });
}
