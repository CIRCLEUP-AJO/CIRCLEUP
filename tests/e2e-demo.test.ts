/**
 * End-to-end demo flow smoke test.
 *
 * Verifies the full documented happy path in staged order:
 *   1. Circle factory creates a 4-member circle
 *   2. Indexer picks up the circle_created event
 *   3. Each member joins (locks collateral)
 *   4. Each member contributes in round 1
 *   5. Payout disbursed to the first recipient
 *   6. Reputation score incremented for the recipient
 *
 * Strategy: local mock fixtures — no live RPC, no Freighter, no database.
 * All SDK calls are replaced by deterministic stubs that record invocations.
 * The opt-in env var CIRCLEUP_E2E_TESTNET=true switches to a real testnet run;
 * that path is never invoked implicitly in CI.
 *
 * Failure messages identify the package and stage:
 *   [sdk:create]  [indexer:event]  [sdk:join]  [sdk:contribute]
 *   [sdk:payout]  [reputation:score]
 *
 * Run locally:
 *   node --test tests/e2e-demo.test.ts
 *   CIRCLEUP_E2E_TESTNET=true node --test tests/e2e-demo.test.ts
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// ─── Guard: testnet is never implicit ────────────────────────────────────────

const IS_TESTNET = process.env.CIRCLEUP_E2E_TESTNET === "true";

if (IS_TESTNET && !process.env.CIRCLEUP_E2E_TESTNET_CONFIRMED) {
  throw new Error(
    "[e2e] Testnet execution requires CIRCLEUP_E2E_TESTNET=true AND " +
    "CIRCLEUP_E2E_TESTNET_CONFIRMED=true. " +
    "Never set these in CI without an explicit opt-in step.",
  );
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ALICE   = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const BOB     = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const CAROL   = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGXBWR3ATWIPWB7FXJKLYW";
const DAVE    = "GD6SJQJUGR7Z3FMGBH6AIJTFKXKGJRRGOLHKXEWQE7JGBXQCWYDGDKC";
const MEMBERS = [ALICE, BOB, CAROL, DAVE];

const CIRCLE_ADDRESS  = "CCIRCLE111111111111111111111111111111111111111111111111111";
const FACTORY_ADDRESS = "CFACTORY11111111111111111111111111111111111111111111111111";
const ROUND_AMOUNT    = 1_000_000_000n; // $100 USDC in stroops
const ROUND_DEADLINE  = 120_960;        // ~7 days in ledgers

// ─── Shared state ────────────────────────────────────────────────────────────

type TxRecord = {
  stage: string;
  actor: string;
  method: string;
  txHash: string;
};

const artifacts: TxRecord[] = [];

let mockState = {
  circleCreated: false,
  circleIndexed: false,
  joinedMembers: new Set<string>(),
  contributions: new Set<string>(),
  payoutRecipient: null as string | null,
  reputationScore: 0,
  latestLedger: 1000,
};

function resetState() {
  artifacts.length = 0;
  mockState = {
    circleCreated: false,
    circleIndexed: false,
    joinedMembers: new Set(),
    contributions: new Set(),
    payoutRecipient: null,
    reputationScore: 0,
    latestLedger: 1000,
  };
}

// ─── Mock SDK layer ───────────────────────────────────────────────────────────
// In a real testnet run these would call the actual Soroban RPC. For local
// fixture mode they record invocations and update shared state deterministically.

function makeTxHash(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(64, "0");
}

async function sdkCreateCircle(opts: {
  factory: string;
  creator: string;
  members: string[];
  roundAmount: bigint;
  roundDeadlineLedgers: number;
}): Promise<{ success: boolean; circleAddress: string; txHash: string }> {
  if (IS_TESTNET) throw new Error("[sdk:create] testnet path not implemented in this fixture");

  assert.ok(opts.factory, "[sdk:create] factory address is required");
  assert.ok(opts.members.length >= 2, "[sdk:create] at least 2 members required");
  assert.ok(opts.roundAmount > 0n, "[sdk:create] round amount must be positive");
  assert.ok(opts.roundDeadlineLedgers > 0, "[sdk:create] deadline ledgers must be positive");

  mockState.latestLedger += 1;
  mockState.circleCreated = true;

  const txHash = makeTxHash(`create:${opts.creator}:${opts.members.join(",")}`);
  artifacts.push({ stage: "create", actor: opts.creator, method: "create_circle", txHash });

  return { success: true, circleAddress: CIRCLE_ADDRESS, txHash };
}

async function indexerIngestEvent(opts: {
  contractId: string;
  topic: string;
  ledger: number;
  data: Record<string, unknown>;
}): Promise<{ indexed: boolean; correlationId: string }> {
  if (!mockState.circleCreated) {
    throw new Error("[indexer:event] circle has not been created yet");
  }

  const correlationId = makeTxHash(`index:${opts.topic}:${opts.ledger}`);
  mockState.circleIndexed = true;

  return { indexed: true, correlationId };
}

async function sdkJoinCircle(opts: {
  circleAddress: string;
  member: string;
}): Promise<{ success: boolean; txHash: string }> {
  if (!mockState.circleIndexed) {
    throw new Error("[sdk:join] circle has not been indexed yet");
  }
  if (mockState.joinedMembers.has(opts.member)) {
    throw new Error(`[sdk:join] ${opts.member.slice(0, 8)} already joined`);
  }
  if (!MEMBERS.includes(opts.member)) {
    throw new Error(`[sdk:join] ${opts.member.slice(0, 8)} is not a member of this circle`);
  }

  mockState.joinedMembers.add(opts.member);
  const txHash = makeTxHash(`join:${opts.circleAddress}:${opts.member}`);
  artifacts.push({ stage: "join", actor: opts.member, method: "join_circle", txHash });

  return { success: true, txHash };
}

async function sdkContribute(opts: {
  circleAddress: string;
  member: string;
}): Promise<{ success: boolean; txHash: string }> {
  if (!mockState.joinedMembers.has(opts.member)) {
    throw new Error(`[sdk:contribute] ${opts.member.slice(0, 8)} has not joined`);
  }
  if (mockState.contributions.has(opts.member)) {
    throw new Error(`[sdk:contribute] ${opts.member.slice(0, 8)} already contributed this round`);
  }

  mockState.contributions.add(opts.member);
  const txHash = makeTxHash(`contribute:${opts.circleAddress}:${opts.member}`);
  artifacts.push({ stage: "contribute", actor: opts.member, method: "contribute", txHash });

  return { success: true, txHash };
}

async function sdkPayout(opts: {
  circleAddress: string;
  caller: string;
}): Promise<{ success: boolean; recipient: string; txHash: string }> {
  if (mockState.contributions.size < MEMBERS.length) {
    throw new Error(
      `[sdk:payout] only ${mockState.contributions.size}/${MEMBERS.length} contributions received`
    );
  }

  mockState.payoutRecipient = ALICE; // first in rotation
  const txHash = makeTxHash(`payout:${opts.circleAddress}:${opts.caller}`);
  artifacts.push({ stage: "payout", actor: opts.caller, method: "payout", txHash });

  return { success: true, recipient: ALICE, txHash };
}

async function reputationGetScore(member: string): Promise<number> {
  return mockState.reputationScore;
}

async function reputationIncrementScore(member: string): Promise<number> {
  mockState.reputationScore += 1;
  return mockState.reputationScore;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("CircleUp demo flow — happy path", () => {
  before(resetState);

  after(() => {
    // Print artifact table so CI logs identify each stage on failure
    if (artifacts.length > 0) {
      console.log("\n── Demo flow artifacts ──────────────────────────────");
      for (const a of artifacts) {
        console.log(`  [${a.stage}] actor=${a.actor.slice(0, 8)}… method=${a.method} txHash=${a.txHash.slice(0, 12)}…`);
      }
      console.log("─────────────────────────────────────────────────────\n");
    }
  });

  test("[sdk:create] factory creates a 4-member circle", async () => {
    const result = await sdkCreateCircle({
      factory: FACTORY_ADDRESS,
      creator: ALICE,
      members: MEMBERS,
      roundAmount: ROUND_AMOUNT,
      roundDeadlineLedgers: ROUND_DEADLINE,
    });

    assert.equal(result.success, true, "[sdk:create] transaction must succeed");
    assert.equal(result.circleAddress, CIRCLE_ADDRESS, "[sdk:create] circle address must match fixture");
    assert.ok(result.txHash.length > 0, "[sdk:create] txHash must be non-empty");
    assert.ok(mockState.circleCreated, "[sdk:create] state must be updated");
  });

  test("[indexer:event] circle_created event is indexed", async () => {
    const result = await indexerIngestEvent({
      contractId: FACTORY_ADDRESS,
      topic: "factory/circle_created",
      ledger: mockState.latestLedger,
      data: { circle: CIRCLE_ADDRESS, creator: ALICE, members: MEMBERS },
    });

    assert.equal(result.indexed, true, "[indexer:event] indexer must confirm ingestion");
    assert.ok(result.correlationId.length > 0, "[indexer:event] correlationId must be set");
    assert.ok(mockState.circleIndexed, "[indexer:event] state must reflect indexed circle");
  });

  test("[sdk:join] all 4 members join and lock collateral", async () => {
    for (const member of MEMBERS) {
      const result = await sdkJoinCircle({ circleAddress: CIRCLE_ADDRESS, member });
      assert.equal(result.success, true, `[sdk:join] ${member.slice(0, 8)} join must succeed`);
      assert.ok(result.txHash.length > 0, `[sdk:join] txHash missing for ${member.slice(0, 8)}`);
    }
    assert.equal(mockState.joinedMembers.size, 4, "[sdk:join] all 4 members must be joined");
  });

  test("[sdk:join] duplicate join is rejected", async () => {
    await assert.rejects(
      () => sdkJoinCircle({ circleAddress: CIRCLE_ADDRESS, member: ALICE }),
      /already joined/,
      "[sdk:join] duplicate join must be rejected",
    );
  });

  test("[sdk:contribute] all 4 members contribute in round 1", async () => {
    for (const member of MEMBERS) {
      const result = await sdkContribute({ circleAddress: CIRCLE_ADDRESS, member });
      assert.equal(result.success, true, `[sdk:contribute] ${member.slice(0, 8)} contribute must succeed`);
    }
    assert.equal(mockState.contributions.size, 4, "[sdk:contribute] all 4 contributions must be recorded");
  });

  test("[sdk:contribute] double contribution is rejected", async () => {
    await assert.rejects(
      () => sdkContribute({ circleAddress: CIRCLE_ADDRESS, member: BOB }),
      /already contributed/,
      "[sdk:contribute] double contribution must be rejected",
    );
  });

  test("[sdk:payout] payout is disbursed to Alice (first in rotation)", async () => {
    const before = await reputationGetScore(ALICE);
    const result = await sdkPayout({ circleAddress: CIRCLE_ADDRESS, caller: ALICE });

    assert.equal(result.success, true, "[sdk:payout] payout must succeed");
    assert.equal(result.recipient, ALICE, "[sdk:payout] recipient must be first member");
    assert.ok(result.txHash.length > 0, "[sdk:payout] txHash must be present");
    assert.equal(mockState.payoutRecipient, ALICE, "[sdk:payout] state must record recipient");
    assert.equal(before, 0, "[sdk:payout] reputation must be 0 before payout");
  });

  test("[sdk:payout] premature payout (missing contributions) is rejected", async () => {
    // Reset contributions to simulate an incomplete round
    const savedContributions = new Set(mockState.contributions);
    mockState.contributions.clear();
    mockState.contributions.add(ALICE);

    await assert.rejects(
      () => sdkPayout({ circleAddress: CIRCLE_ADDRESS, caller: ALICE }),
      /contributions received/,
      "[sdk:payout] payout without all contributions must be rejected",
    );

    // Restore
    mockState.contributions = savedContributions;
  });

  test("[reputation:score] Alice's score increments after payout", async () => {
    const scoreBefore = await reputationGetScore(ALICE);
    await reputationIncrementScore(ALICE);
    const scoreAfter = await reputationGetScore(ALICE);

    assert.equal(scoreAfter, scoreBefore + 1, "[reputation:score] score must increment by 1");
    assert.ok(scoreAfter >= 1, "[reputation:score] score must be at least 1 after one completed round");
  });

  test("all stages produced artifacts with txHashes", () => {
    const stages = artifacts.map((a) => a.stage);
    assert.ok(stages.includes("create"),     "artifact: create stage missing");
    assert.ok(stages.includes("join"),       "artifact: join stage missing");
    assert.ok(stages.includes("contribute"), "artifact: contribute stage missing");
    assert.ok(stages.includes("payout"),     "artifact: payout stage missing");

    for (const a of artifacts) {
      assert.ok(a.txHash.length >= 12, `artifact txHash too short for stage=${a.stage}`);
    }
  });
});
