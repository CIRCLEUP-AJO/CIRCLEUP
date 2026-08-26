/**
 * Replay fixture tests — verify that sanitized ordered event payloads produce
 * the correct projections when run through the operational replay path.
 *
 * Split into two groups:
 *
 *   Unit tests  — pure fixture structure: key uniqueness, ledger ordering,
 *                 and partition completeness.  No Postgres required.
 *
 *   Integration — require DATABASE_URL.  Runs every event type through
 *                 processLedger and asserts final projection rows, checkpoint
 *                 records, and second-run idempotency.
 *
 * No real keys or secrets appear here — all addresses use the synthetic
 * FIXTURE_* namespace which is recognisable and easily grepable in the DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventHandler } from "../indexer";
import type { PoolClient } from "pg";

// ─── Sanitized fixture addresses (no real keys or secrets) ───────────────────

const FACTORY_ADDR   = "CFIXTURE_FACTORY";
const CIRCLE_ADDR    = "CFIXTURE_CIRCLE_001";
const CREATOR_ADDR   = "GFIXTURE_CREATOR";
const MEMBER1_ADDR   = "GFIXTURE_MEMBER1";
const MEMBER2_ADDR   = "GFIXTURE_MEMBER2";

// High ledger range — avoids collisions with ordering / replay integration tests.
const L = {
  CIRCLE_CREATED : 60_001,
  JOINED         : 60_002,
  ACTIVE         : 60_003,
  CONTRIBUTED    : 60_004,
  PAYOUT         : 60_005,
  DEFAULT        : 60_006,
  COMPLETED      : 60_007,
  REPUTATION     : 60_008,
} as const;

// ─── Minimal SdkEvent stub ────────────────────────────────────────────────────
//
// Matches the MinimalEvent pattern used in indexer.ordering.test.ts: the value
// is a void mock so createEventKey works without real XDR, and topics are void
// mocks because the handler closures below carry their own pre-parsed data.

type FixtureEvent = {
  id: string;
  ledger: number;
  txHash: string;
  contractId: string;
  topic: unknown[];
  value: unknown;
  pagingToken: string;
  type: string;
  ledgerClosedAt: string;
  inSuccessfulContractCall: boolean;
};

function makeEvent(
  ledger: number,
  suffix: string,
  contractId: string = FACTORY_ADDR,
): FixtureEvent {
  return {
    id: `${String(ledger).padStart(10, "0")}-0000000001-${suffix}`,
    ledger,
    txHash: `fixture-tx-${suffix}`,
    contractId,
    topic: [],
    value: { switch: () => ({ name: "scvVoid" }), str: () => "" },
    pagingToken: `pg-${ledger}-${suffix}`,
    type: "contract",
    ledgerClosedAt: new Date().toISOString(),
    inSuccessfulContractCall: true,
  };
}

// ─── Fixture event definitions ────────────────────────────────────────────────
//
// Each fixture pairs a minimal SdkEvent stub (for dedup-key generation and
// checkpoint attribution) with a handler closure that writes the expected
// projection row(s).  The handlers mirror the actual indexer handlers from
// indexer.ts; the separation lets us test the replay path without depending
// on XDR-encoded event data.

function buildFixtures(): EventHandler[] {
  // factory/circle_created — inserts the circles row.
  const circleCreatedEvent = makeEvent(L.CIRCLE_CREATED, "circle-created", FACTORY_ADDR);
  const circleCreatedHandler: EventHandler = {
    event: circleCreatedEvent as any,
    handler: async (client: PoolClient) => {
      await client.query(
        `INSERT INTO circles
           (address, creator, round_amount, member_count, total_rounds,
            status, current_round, created_ledger)
         VALUES ($1, $2, 100, 2, 2, 'Pending', 0, $3)
         ON CONFLICT (address) DO NOTHING`,
        [CIRCLE_ADDR, CREATOR_ADDR, L.CIRCLE_CREATED],
      );
    },
  };

  // circle/joined — updates joined_at for MEMBER1 (row pre-seeded by the test setup).
  const joinedEvent = makeEvent(L.JOINED, "joined", CIRCLE_ADDR);
  const joinedHandler: EventHandler = {
    event: joinedEvent as any,
    handler: async (client: PoolClient) => {
      await client.query(
        `UPDATE circle_members SET joined_at = NOW()
         WHERE circle_address = $1 AND member_address = $2`,
        [CIRCLE_ADDR, MEMBER1_ADDR],
      );
    },
  };

  // circle/active — transitions circle to Active.
  const activeEvent = makeEvent(L.ACTIVE, "active", CIRCLE_ADDR);
  const activeHandler: EventHandler = {
    event: activeEvent as any,
    handler: async (client: PoolClient) => {
      await client.query(
        `UPDATE circles SET status = 'Active', updated_at = NOW()
         WHERE address = $1`,
        [CIRCLE_ADDR],
      );
    },
  };

  // circle/contributed — MEMBER1 contributes in round 0.
  const contributedEvent = makeEvent(L.CONTRIBUTED, "contributed", CIRCLE_ADDR);
  const contributedHandler: EventHandler = {
    event: contributedEvent as any,
    handler: async (client: PoolClient) => {
      await client.query(
        `INSERT INTO contributions
           (circle_address, member_address, round_index, amount, tx_hash, ledger)
         VALUES ($1, $2, 0, 100, $3, $4)
         ON CONFLICT (circle_address, member_address, round_index) DO NOTHING`,
        [CIRCLE_ADDR, MEMBER1_ADDR, `fixture-tx-contributed`, L.CONTRIBUTED],
      );
    },
  };

  // circle/payout — MEMBER1 receives the pot for round 0.
  const payoutEvent = makeEvent(L.PAYOUT, "payout", CIRCLE_ADDR);
  const payoutHandler: EventHandler = {
    event: payoutEvent as any,
    handler: async (client: PoolClient) => {
      await client.query(
        `INSERT INTO payouts
           (circle_address, recipient, round_index, amount, tx_hash, ledger)
         VALUES ($1, $2, 0, 200, $3, $4)
         ON CONFLICT (circle_address, round_index) DO NOTHING`,
        [CIRCLE_ADDR, MEMBER1_ADDR, `fixture-tx-payout`, L.PAYOUT],
      );
      await client.query(
        `UPDATE circles SET current_round = 1, updated_at = NOW() WHERE address = $1`,
        [CIRCLE_ADDR],
      );
    },
  };

  // circle/default — MEMBER2 defaults in round 1.
  const defaultEvent = makeEvent(L.DEFAULT, "default", CIRCLE_ADDR);
  const defaultHandler: EventHandler = {
    event: defaultEvent as any,
    handler: async (client: PoolClient) => {
      await client.query(
        `INSERT INTO defaults
           (circle_address, member_address, round_index, penalty, tx_hash, ledger)
         VALUES ($1, $2, 1, 50, $3, $4)`,
        [CIRCLE_ADDR, MEMBER2_ADDR, `fixture-tx-default`, L.DEFAULT],
      );
      await client.query(
        `UPDATE circle_members SET defaults = defaults + 1
         WHERE circle_address = $1 AND member_address = $2`,
        [CIRCLE_ADDR, MEMBER2_ADDR],
      );
    },
  };

  // circle/completed — final status transition.
  const completedEvent = makeEvent(L.COMPLETED, "completed", CIRCLE_ADDR);
  const completedHandler: EventHandler = {
    event: completedEvent as any,
    handler: async (client: PoolClient) => {
      await client.query(
        `UPDATE circles SET status = 'Completed', updated_at = NOW()
         WHERE address = $1`,
        [CIRCLE_ADDR],
      );
    },
  };

  // reputation/score_updated — MEMBER1 earns 1 point.
  const reputationEvent = makeEvent(L.REPUTATION, "reputation", FACTORY_ADDR);
  const reputationHandler: EventHandler = {
    event: reputationEvent as any,
    handler: async (client: PoolClient) => {
      await client.query(
        `INSERT INTO reputation (member_address, score, updated_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (member_address) DO UPDATE SET score = 1, updated_at = NOW()`,
        [MEMBER1_ADDR],
      );
    },
  };

  return [
    circleCreatedHandler,
    joinedHandler,
    activeHandler,
    contributedHandler,
    payoutHandler,
    defaultHandler,
    completedHandler,
    reputationHandler,
  ];
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

test("fixtures: all event types have distinct txHash values (no key collisions)", () => {
  const fixtures = buildFixtures();
  const hashes = fixtures.map((f) => (f.event as any).txHash as string);
  const unique = new Set(hashes);
  assert.equal(
    unique.size,
    hashes.length,
    "every fixture event must have a unique txHash so processLedger produces distinct event keys",
  );
});

test("fixtures: ledger numbers span all expected event types in ascending order", () => {
  const fixtures = buildFixtures();
  const ledgers = fixtures.map((f) => (f.event as any).ledger as number);
  const sorted = [...ledgers].sort((a, b) => a - b);
  assert.deepEqual(
    ledgers,
    sorted,
    "fixture events must be ordered by ledger ASC (replay order)",
  );

  const expected = Object.values(L).sort((a, b) => a - b);
  assert.deepEqual(
    ledgers,
    expected,
    "fixture ledger list must cover every defined event-type ledger",
  );
});

test("fixtures: eight event types are defined (creation, join, active, contribution, payout, default, close, reputation)", () => {
  const fixtures = buildFixtures();
  assert.equal(
    fixtures.length,
    8,
    "there must be exactly one fixture per event type",
  );
});

test("fixtures: each fixture event is assigned to a distinct ledger", () => {
  const fixtures = buildFixtures();
  const ledgers = fixtures.map((f) => (f.event as any).ledger as number);
  const unique = new Set(ledgers);
  assert.equal(
    unique.size,
    ledgers.length,
    "each event type must be at a distinct ledger so checkpoints are unambiguous",
  );
});

test("fixtures: each fixture has a non-null handler function", () => {
  const fixtures = buildFixtures();
  for (const f of fixtures) {
    assert.equal(typeof f.handler, "function", "every fixture must have a handler");
  }
});

// ─── Integration tests (require live Postgres) ────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);

if (hasDb) {
  const { processLedger } =
    require("../indexer") as typeof import("../indexer");
  const { runMigrations } =
    require("./migrate") as typeof import("./migrate");
  const { pool } =
    require("./pool") as typeof import("./pool");

  // ── Helpers ──────────────────────────────────────────────────────────────────

  async function seedMembers() {
    await pool.query(
      `INSERT INTO circle_members
         (circle_address, member_address, payout_order, collateral)
       VALUES
         ($1, $2, 0, 0),
         ($1, $3, 1, 0)
       ON CONFLICT (circle_address, member_address) DO NOTHING`,
      [CIRCLE_ADDR, MEMBER1_ADDR, MEMBER2_ADDR],
    );
  }

  async function cleanupFixtures() {
    await pool.query(
      "DELETE FROM ingested_events WHERE tx_hash LIKE 'fixture-tx-%'",
    );
    await pool.query(
      `DELETE FROM ledger_checkpoints WHERE ledger BETWEEN $1 AND $2`,
      [L.CIRCLE_CREATED, L.REPUTATION],
    );
    await pool.query("DELETE FROM defaults WHERE circle_address = $1",          [CIRCLE_ADDR]);
    await pool.query("DELETE FROM payouts WHERE circle_address = $1",           [CIRCLE_ADDR]);
    await pool.query("DELETE FROM contributions WHERE circle_address = $1",     [CIRCLE_ADDR]);
    await pool.query("DELETE FROM circle_members WHERE circle_address = $1",    [CIRCLE_ADDR]);
    await pool.query("DELETE FROM reputation WHERE member_address IN ($1, $2)", [MEMBER1_ADDR, MEMBER2_ADDR]);
    await pool.query("DELETE FROM circles WHERE address = $1",                  [CIRCLE_ADDR]);
  }

  // ── Fixture replay ───────────────────────────────────────────────────────────

  test("fixture replay: all eight event types project correct rows into the database", async () => {
    await runMigrations();
    await cleanupFixtures();

    // circle/joined needs the circle_members rows to exist first.
    // In a real replay the circle contract initialization populates them;
    // here we seed them directly.
    await pool.query(
      `INSERT INTO circles
         (address, creator, round_amount, member_count, total_rounds,
          status, current_round, created_ledger)
       VALUES ($1, $2, 100, 2, 2, 'Pending', 0, $3)
       ON CONFLICT (address) DO NOTHING`,
      [CIRCLE_ADDR, CREATOR_ADDR, L.CIRCLE_CREATED - 1],
    );
    await seedMembers();

    try {
      const fixtures = buildFixtures();

      // Group fixtures by ledger (one event per ledger in this suite).
      for (const fixture of fixtures) {
        const ledger = (fixture.event as any).ledger as number;
        await processLedger(ledger, [fixture]);
      }

      // ── Assert projections ────────────────────────────────────────────────

      const { rows: circleRows } = await pool.query<{ status: string; current_round: number }>(
        "SELECT status, current_round FROM circles WHERE address = $1",
        [CIRCLE_ADDR],
      );
      assert.equal(circleRows.length, 1, "circles must have exactly one row for the fixture circle");
      assert.equal(circleRows[0].status, "Completed", "circle status must be Completed after all events");
      assert.equal(circleRows[0].current_round, 1, "current_round must be 1 after the payout event");

      const { rows: memberRows } = await pool.query<{ member_address: string; joined_at: string | null; defaults: number }>(
        "SELECT member_address, joined_at, defaults FROM circle_members WHERE circle_address = $1 ORDER BY payout_order",
        [CIRCLE_ADDR],
      );
      assert.equal(memberRows.length, 2, "circle_members must have two rows");
      assert.notEqual(memberRows[0].joined_at, null, "MEMBER1 joined_at must be set after the joined event");
      assert.equal(memberRows[1].defaults, 1, "MEMBER2 defaults must be 1 after the default event");

      const { rows: contribRows } = await pool.query(
        "SELECT * FROM contributions WHERE circle_address = $1",
        [CIRCLE_ADDR],
      );
      assert.equal(contribRows.length, 1, "contributions must have one row after the contributed event");

      const { rows: payoutRows } = await pool.query(
        "SELECT * FROM payouts WHERE circle_address = $1",
        [CIRCLE_ADDR],
      );
      assert.equal(payoutRows.length, 1, "payouts must have one row after the payout event");

      const { rows: defaultRows } = await pool.query(
        "SELECT * FROM defaults WHERE circle_address = $1",
        [CIRCLE_ADDR],
      );
      assert.equal(defaultRows.length, 1, "defaults must have one row after the default event");

      const { rows: repRows } = await pool.query<{ score: number }>(
        "SELECT score FROM reputation WHERE member_address = $1",
        [MEMBER1_ADDR],
      );
      assert.equal(repRows.length, 1, "reputation must have one row for MEMBER1");
      assert.equal(repRows[0].score, 1, "MEMBER1 reputation score must be 1");

      // ── Assert checkpoints ────────────────────────────────────────────────

      const { rows: checkRows } = await pool.query<{ ledger: string; events_count: number }>(
        `SELECT ledger, events_count FROM ledger_checkpoints
         WHERE ledger BETWEEN $1 AND $2
         ORDER BY ledger`,
        [L.CIRCLE_CREATED, L.REPUTATION],
      );
      assert.equal(checkRows.length, 8, "ledger_checkpoints must have one row per fixture ledger");
      for (const row of checkRows) {
        assert.equal(row.events_count, 1, `ledger ${row.ledger} must report exactly 1 processed event`);
      }
    } finally {
      await cleanupFixtures();
    }
  });

  test("fixture replay: second run is fully idempotent — all processLedger calls return processed=0", async () => {
    await runMigrations();
    await cleanupFixtures();

    await pool.query(
      `INSERT INTO circles
         (address, creator, round_amount, member_count, total_rounds,
          status, current_round, created_ledger)
       VALUES ($1, $2, 100, 2, 2, 'Pending', 0, $3)
       ON CONFLICT (address) DO NOTHING`,
      [CIRCLE_ADDR, CREATOR_ADDR, L.CIRCLE_CREATED - 1],
    );
    await seedMembers();

    try {
      const fixtures = buildFixtures();

      // First pass — all events must be processed.
      for (const fixture of fixtures) {
        const ledger = (fixture.event as any).ledger as number;
        const r = await processLedger(ledger, [fixture]);
        assert.equal(r.processed, 1, `first pass: ledger ${ledger} must process 1 event`);
      }

      // Second pass — every event is already in ingested_events; none must be re-processed.
      for (const fixture of fixtures) {
        const ledger = (fixture.event as any).ledger as number;
        const r = await processLedger(ledger, [fixture]);
        assert.equal(
          r.processed,
          0,
          `second pass: ledger ${ledger} must report 0 processed events (dedup)`,
        );
        assert.equal(r.failed, 0, `second pass: ledger ${ledger} must report 0 failures`);
      }
    } finally {
      await cleanupFixtures();
    }
  });

  test("fixture replay: projection output is deterministic — re-running produces identical rows", async () => {
    await runMigrations();
    await cleanupFixtures();

    await pool.query(
      `INSERT INTO circles
         (address, creator, round_amount, member_count, total_rounds,
          status, current_round, created_ledger)
       VALUES ($1, $2, 100, 2, 2, 'Pending', 0, $3)
       ON CONFLICT (address) DO NOTHING`,
      [CIRCLE_ADDR, CREATOR_ADDR, L.CIRCLE_CREATED - 1],
    );
    await seedMembers();

    try {
      const fixtures = buildFixtures();
      for (const f of fixtures) {
        await processLedger((f.event as any).ledger, [f]);
      }

      // Capture state after first run.
      const snap1 = {
        circle: (await pool.query("SELECT status, current_round FROM circles WHERE address = $1", [CIRCLE_ADDR])).rows[0],
        contribs: (await pool.query("SELECT count(*) as n FROM contributions WHERE circle_address = $1", [CIRCLE_ADDR])).rows[0].n,
        payouts: (await pool.query("SELECT count(*) as n FROM payouts WHERE circle_address = $1", [CIRCLE_ADDR])).rows[0].n,
        defaults: (await pool.query("SELECT count(*) as n FROM defaults WHERE circle_address = $1", [CIRCLE_ADDR])).rows[0].n,
        repScore: (await pool.query("SELECT score FROM reputation WHERE member_address = $1", [MEMBER1_ADDR])).rows[0]?.score,
      };

      // Run again — the dedup layer must prevent any mutation.
      for (const f of fixtures) {
        await processLedger((f.event as any).ledger, [f]);
      }

      const snap2 = {
        circle: (await pool.query("SELECT status, current_round FROM circles WHERE address = $1", [CIRCLE_ADDR])).rows[0],
        contribs: (await pool.query("SELECT count(*) as n FROM contributions WHERE circle_address = $1", [CIRCLE_ADDR])).rows[0].n,
        payouts: (await pool.query("SELECT count(*) as n FROM payouts WHERE circle_address = $1", [CIRCLE_ADDR])).rows[0].n,
        defaults: (await pool.query("SELECT count(*) as n FROM defaults WHERE circle_address = $1", [CIRCLE_ADDR])).rows[0].n,
        repScore: (await pool.query("SELECT score FROM reputation WHERE member_address = $1", [MEMBER1_ADDR])).rows[0]?.score,
      };

      assert.deepEqual(snap1.circle, snap2.circle, "circle row must be identical after second run");
      assert.equal(snap1.contribs, snap2.contribs, "contribution count must not change on second run");
      assert.equal(snap1.payouts,  snap2.payouts,  "payout count must not change on second run");
      assert.equal(snap1.defaults, snap2.defaults,  "default count must not change on second run");
      assert.equal(snap1.repScore, snap2.repScore,  "reputation score must not change on second run");
    } finally {
      await cleanupFixtures();
    }
  });

  test.after(async () => {
    await pool.end();
  });
}
