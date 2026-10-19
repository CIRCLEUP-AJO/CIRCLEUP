/**
 * Unit tests for the per-circle reconciliation diagnostic (Issue #688).
 *
 * Chain reads and indexed reads are both injected, so these tests run without
 * an RPC node or Postgres.  The fake source records every call to prove the
 * diagnostic never asks for a write.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StrKey } from "@stellar/stellar-sdk";
import {
  isValidCircleAddress,
  reconcileCircle,
  type ChainReadResult,
  type ChainReader,
  type IndexedCircle,
  type IndexedCircleSource,
  type IndexedMember,
  type IndexedPayout,
} from "./circleReconciliation";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CIRCLE = StrKey.encodeContract(Buffer.alloc(32, 7));
const ALICE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const BOB = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const CAROL = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
const ROUND_AMOUNT = 100_000_000n;
const POT = (ROUND_AMOUNT * 3n).toString();

interface ChainState {
  latestLedger?: number | Error;
  get_config?: ChainReadResult;
  get_status?: ChainReadResult;
  is_paused?: ChainReadResult;
  is_closed?: ChainReadResult;
  get_current_round?: ChainReadResult;
}

const ok = (value: unknown): ChainReadResult => ({ ok: true, value });

function healthyChain(overrides: ChainState = {}): ChainState {
  return {
    latestLedger: 1_000,
    get_config: ok({ members: [ALICE, BOB, CAROL], round_amount: ROUND_AMOUNT, round_deadline_ledgers: 100 }),
    get_status: ok(["Active"]),
    is_paused: ok(false),
    is_closed: ok(false),
    get_current_round: ok({ round_index: 1, recipient: BOB, contributions_received: 0, deadline_ledger: 1_100n, paid_out: false }),
    ...overrides,
  };
}

function fakeReader(state: ChainState): ChainReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async latestLedger() {
      calls.push("getLatestLedger");
      if (state.latestLedger instanceof Error) throw state.latestLedger;
      return state.latestLedger ?? 1_000;
    },
    async call(_contractId, method) {
      calls.push(method);
      const result = (state as unknown as Record<string, ChainReadResult | undefined>)[method];
      return result ?? { ok: false, failure: "contract_error", error: `${method} not found` };
    },
  };
}

interface IndexedState {
  indexedLedger?: number;
  circle?: IndexedCircle | null;
  members?: IndexedMember[];
  payouts?: IndexedPayout[];
}

function healthyIndex(overrides: IndexedState = {}): IndexedState {
  return {
    indexedLedger: 1_000,
    circle: {
      address: CIRCLE,
      status: "Active",
      current_round: 1,
      member_count: 3,
      round_amount: ROUND_AMOUNT.toString(),
      paused: false,
    },
    members: [
      { member_address: ALICE, payout_order: 0 },
      { member_address: BOB, payout_order: 1 },
      { member_address: CAROL, payout_order: 2 },
    ],
    payouts: [
      { round_index: 0, recipient: ALICE, amount: POT, is_exceptional: false, ledger: "900", tx_hash: "aa" },
    ],
    ...overrides,
  };
}

function fakeSource(state: IndexedState): IndexedCircleSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async indexedLedger() {
      calls.push("indexedLedger");
      return state.indexedLedger ?? 0;
    },
    async circle() {
      calls.push("circle");
      return state.circle ?? null;
    },
    async members(_a, limit) {
      calls.push(`members(limit=${limit})`);
      return state.members ?? [];
    },
    async payouts(_a, limit) {
      calls.push(`payouts(limit=${limit})`);
      return state.payouts ?? [];
    },
  };
}

async function run(chain: ChainState, index: IndexedState) {
  const reader = fakeReader(chain);
  const source = fakeSource(index);
  const report = await reconcileCircle(CIRCLE, { reader, source, now: () => new Date(0) });
  return { report, reader, source };
}

// ─── Address validation ──────────────────────────────────────────────────────

test("isValidCircleAddress accepts checksummed contract ids only", () => {
  assert.equal(isValidCircleAddress(CIRCLE), true);
  assert.equal(isValidCircleAddress(ALICE), false, "account (G…) is not a circle");
  assert.equal(isValidCircleAddress(`C${"A".repeat(55)}`), false, "bad checksum");
  assert.equal(isValidCircleAddress(undefined), false);
});

test("reconcileCircle rejects an invalid address before any read", async () => {
  const reader = fakeReader(healthyChain());
  const source = fakeSource(healthyIndex());
  await assert.rejects(() => reconcileCircle(ALICE, { reader, source }), /valid Soroban contract address/);
  assert.deepEqual(reader.calls, []);
  assert.deepEqual(source.calls, []);
});

// ─── Matching ────────────────────────────────────────────────────────────────

test("match: identical member order, status, round and payouts", async () => {
  const { report } = await run(healthyChain(), healthyIndex());
  assert.equal(report.outcome, "match");
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.unavailable, []);
  assert.deepEqual(report.ledgerContext, { indexedLedger: 1_000, chainLedger: 1_000, lagLedgers: 0 });
  for (const field of ["member_order", "status", "current_round", "payout_count", "payout_recipient"]) {
    assert.ok(report.checked.includes(field as never), `${field} must be checked`);
  }
});

test("match: indexer-only Closed status agrees with a closed Completed circle", async () => {
  const { report } = await run(
    healthyChain({ get_status: ok(["Completed"]), is_closed: ok(true) }),
    healthyIndex({
      circle: { ...healthyIndex().circle!, status: "Closed", current_round: 3 },
      payouts: [ALICE, BOB, CAROL].map((recipient, i) => ({
        round_index: i,
        recipient,
        amount: POT,
        is_exceptional: false,
        ledger: String(900 + i),
        tx_hash: `t${i}`,
      })),
    }),
  );
  assert.equal(report.outcome, "match", JSON.stringify(report.mismatches));
  assert.ok(!report.checked.includes("current_round"), "no current round for Completed circles");
});

test("match: exceptional payouts are not compared against the full pot", async () => {
  const { report } = await run(
    healthyChain(),
    healthyIndex({
      payouts: [{ round_index: 0, recipient: ALICE, amount: "200000000", is_exceptional: true, ledger: "900", tx_hash: "aa" }],
    }),
  );
  assert.equal(report.outcome, "match");
});

// ─── Stale vs drift ──────────────────────────────────────────────────────────

test("stale: indexer behind chain → mismatches are classified possibly_stale", async () => {
  const { report } = await run(
    healthyChain({
      latestLedger: 1_050,
      get_current_round: ok({ round_index: 2, recipient: CAROL, contributions_received: 0, deadline_ledger: 1_200n, paid_out: false }),
    }),
    healthyIndex({ indexedLedger: 1_000 }),
  );
  assert.equal(report.outcome, "mismatch");
  assert.equal(report.ledgerContext.lagLedgers, 50);
  const round = report.mismatches.find((m) => m.field === "current_round");
  assert.ok(round);
  assert.equal(round.indexed, "1");
  assert.equal(round.chain, "2");
  assert.equal(round.source, "get_current_round.round_index");
  assert.equal(round.classification, "possibly_stale");
  const count = report.mismatches.find((m) => m.field === "payout_count");
  assert.equal(count?.indexed, "1");
  assert.equal(count?.chain, "2");
});

test("drift: indexer caught up → wrong member order is classified drift with slot context", async () => {
  const { report } = await run(
    healthyChain(),
    healthyIndex({
      members: [
        { member_address: BOB, payout_order: 0 },
        { member_address: ALICE, payout_order: 1 },
        { member_address: CAROL, payout_order: 2 },
      ],
    }),
  );
  assert.equal(report.outcome, "mismatch");
  const slots = report.mismatches.filter((m) => m.field === "member_order");
  assert.deepEqual(
    slots.map((m) => [m.key, m.indexed, m.chain, m.classification]),
    [
      ["payout_order=0", BOB, ALICE, "drift"],
      ["payout_order=1", ALICE, BOB, "drift"],
    ],
  );
});

test("drift: missing member rows and a wrong payout recipient are reported with the row ledger", async () => {
  const { report } = await run(
    healthyChain(),
    healthyIndex({
      members: [],
      payouts: [{ round_index: 0, recipient: BOB, amount: "1", is_exceptional: false, ledger: "900", tx_hash: "aa" }],
    }),
  );
  assert.equal(report.outcome, "mismatch");
  assert.equal(report.mismatches.filter((m) => m.field === "member_order").length, 3);
  const recipient = report.mismatches.find((m) => m.field === "payout_recipient");
  assert.equal(recipient?.key, "round=0");
  assert.equal(recipient?.indexedRowLedger, 900);
  const amount = report.mismatches.find((m) => m.field === "payout_amount");
  assert.equal(amount?.chain, POT);
});

test("drift: status and paused differences are reported separately", async () => {
  const { report } = await run(
    healthyChain({ is_paused: ok(true) }),
    healthyIndex({ circle: { ...healthyIndex().circle!, status: "Pending" } }),
  );
  const fields = report.mismatches.map((m) => m.field).sort();
  assert.deepEqual(fields, ["paused", "status"]);
});

// ─── RPC unavailable vs incompatible contract ────────────────────────────────

test("rpc_unavailable: unreachable RPC is not reported as drift", async () => {
  const { report } = await run(
    healthyChain({ latestLedger: new Error("connect ECONNREFUSED") }),
    healthyIndex({ members: [] }),
  );
  assert.equal(report.outcome, "rpc_unavailable");
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.unavailable[0].failure, "rpc_unavailable");
  assert.equal(report.ledgerContext.chainLedger, null);
});

test("rpc_unavailable: a timed-out view read stops the comparison without mismatches", async () => {
  const { report } = await run(
    healthyChain({ get_status: { ok: false, failure: "rpc_unavailable", error: "Timed out after 5000ms" } }),
    healthyIndex({ members: [] }),
  );
  assert.equal(report.outcome, "rpc_unavailable");
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.unavailable.map((u) => u.source), ["get_status"]);
});

test("incompatible_contract: address without the circle views", async () => {
  const { report } = await run(
    {
      latestLedger: 1_000,
      get_config: { ok: false, failure: "contract_error", error: "HostError: function not found" },
      get_status: { ok: false, failure: "contract_error", error: "HostError: function not found" },
      is_paused: { ok: false, failure: "contract_error", error: "HostError: function not found" },
      is_closed: { ok: false, failure: "contract_error", error: "HostError: function not found" },
    },
    healthyIndex(),
  );
  assert.equal(report.outcome, "incompatible_contract");
  assert.deepEqual(report.mismatches, []);
  assert.ok(report.unavailable.every((u) => u.failure === "contract_error"));
});

test("incompatible_contract: views answer with unexpected shapes", async () => {
  const { report } = await run(
    healthyChain({ get_config: ok(42), get_status: ok(["Exploded"]) }),
    healthyIndex(),
  );
  assert.equal(report.outcome, "incompatible_contract");
  assert.deepEqual(report.mismatches, []);
});

// ─── Not indexed / bounds / read-only ────────────────────────────────────────

test("not_indexed: no RPC reads for a circle the indexer has never seen", async () => {
  const { report, reader } = await run(healthyChain(), healthyIndex({ circle: null }));
  assert.equal(report.outcome, "not_indexed");
  assert.deepEqual(reader.calls, []);
});

test("bounded and read-only: fixed view set, row limits passed, only reads issued", async () => {
  const { reader, source } = await run(healthyChain(), healthyIndex());
  assert.deepEqual(
    [...reader.calls].sort(),
    ["getLatestLedger", "get_config", "get_current_round", "get_status", "is_closed", "is_paused"],
  );
  assert.ok(source.calls.includes("members(limit=512)"));
  assert.ok(source.calls.includes("payouts(limit=512)"));
});
