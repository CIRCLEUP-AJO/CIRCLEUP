import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { redactSecrets } from "./redact";
import {
  assertAlwaysCreate,
  assertSeedNetwork,
  buildSeedPreflightReport,
  recordSeedTransaction,
  redactSeedError,
  SeedJournal,
  TESTNET_PASSPHRASE,
  writeSeedJournal,
} from "./seed-demo-policy";

function journal(): SeedJournal {
  return {
    runId: "run-1",
    status: "in_progress",
    network: "testnet",
    members: ["G_PUBLIC_MEMBER"],
    completedSteps: [],
    transactions: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("seeding requires an explicit always-create choice", () => {
  assert.throws(() => assertAlwaysCreate([]), /--always-create/);
  assert.doesNotThrow(() => assertAlwaysCreate(["--always-create"]));
});

test("seeding accepts only matching testnet network metadata", () => {
  const manifest = { network: "testnet", networkPassphrase: TESTNET_PASSPHRASE };
  assert.doesNotThrow(() => assertSeedNetwork("testnet", TESTNET_PASSPHRASE, TESTNET_PASSPHRASE, manifest));
  assert.throws(() => assertSeedNetwork("mainnet", TESTNET_PASSPHRASE, TESTNET_PASSPHRASE, manifest), /only supports testnet/);
  assert.throws(() => assertSeedNetwork("testnet", TESTNET_PASSPHRASE, "wrong RPC", manifest), /mismatch/);
  assert.throws(() => assertSeedNetwork("testnet", TESTNET_PASSPHRASE, TESTNET_PASSPHRASE, {
    network: "mainnet",
    networkPassphrase: TESTNET_PASSPHRASE,
  }), /mismatch/);
});

test("transaction journal preserves references for partial, failed, and timed-out writes", () => {
  const progress = journal();
  recordSeedTransaction(progress, "create_circle", "hash-1", "submitted");
  recordSeedTransaction(progress, "create_circle", "hash-1", "timeout");
  recordSeedTransaction(progress, "join:Alice", "hash-2", "failed");
  assert.deepEqual(progress.transactions, [
    { step: "create_circle", hash: "hash-1", status: "timeout" },
    { step: "join:Alice", hash: "hash-2", status: "failed" },
  ]);
  assert.equal(JSON.stringify(progress).includes("secret"), false);
});

test("seed journal retains earlier runs and updates only the active run", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "circleup-seed-test-"));
  const outputPath = path.join(directory, "seeded.json");
  try {
    const first = journal();
    writeSeedJournal(outputPath, first);
    writeSeedJournal(outputPath, first);
    writeSeedJournal(outputPath, { ...journal(), runId: "run-2" });

    const history = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(history.version, 1);
    assert.deepEqual(history.runs.map((run: SeedJournal) => run.runId), ["run-1", "run-2"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("seed failure output redacts Stellar secret keys but retains transaction references", () => {
  const secret = `S${"A".repeat(55)}`;
  const report = redactSecrets(`Transaction failed: hash-123 ${secret}`);
  assert.match(report, /hash-123/);
  assert.doesNotMatch(report, new RegExp(secret));
});

test("seed failure output redacts RPC URL credentials and query parameters", () => {
  const report = redactSeedError(
    "Request failed: https://rpc-user:rpc-pass@example.test/rpc?token=api-secret",
  );
  assert.doesNotMatch(report, /rpc-user|rpc-pass|api-secret/);
  assert.match(report, /https:\/\/\[REDACTED\]@example\.test\/rpc\?\[REDACTED\]/);
});

test("preflight allows circle creation on a first run with no prior state", () => {
  const report = buildSeedPreflightReport({
    network: "testnet",
    networkPassphrase: TESTNET_PASSPHRASE,
    expectedPassphrase: TESTNET_PASSPHRASE,
    manifest: { network: "testnet", networkPassphrase: TESTNET_PASSPHRASE },
    journal: undefined,
    onChainCircle: undefined,
  });
  assert.equal(report.network, "testnet");
  assert.equal(report.createCircle, true);
  assert.equal(report.unresolved, false);
  assert.deepEqual(report.steps, []);
});

test("preflight skips circle creation when a prior run confirmed it", () => {
  const prior = journal();
  prior.status = "complete";
  prior.completedSteps = ["create_circle"];
  recordSeedTransaction(prior, "create_circle", "hash-1", "confirmed");
  const report = buildSeedPreflightReport({
    network: "testnet",
    networkPassphrase: TESTNET_PASSPHRASE,
    expectedPassphrase: TESTNET_PASSPHRASE,
    manifest: { network: "testnet", networkPassphrase: TESTNET_PASSPHRASE },
    journal: prior,
    onChainCircle: { id: "circle-1", matchesDemoIdentity: true },
  });
  assert.equal(report.createCircle, false);
  assert.equal(report.unresolved, false);
  assert.deepEqual(report.steps, [{ step: "create_circle", status: "confirmed", hash: "hash-1" }]);
});

test("preflight treats a prior timeout as unresolved and skips circle creation", () => {
  const prior = journal();
  recordSeedTransaction(prior, "create_circle", "hash-1", "timeout");
  const report = buildSeedPreflightReport({
    network: "testnet",
    networkPassphrase: TESTNET_PASSPHRASE,
    expectedPassphrase: TESTNET_PASSPHRASE,
    manifest: { network: "testnet", networkPassphrase: TESTNET_PASSPHRASE },
    journal: prior,
    onChainCircle: undefined,
  });
  assert.equal(report.createCircle, false);
  assert.equal(report.unresolved, true);
  assert.deepEqual(report.steps, [{ step: "create_circle", status: "timeout", hash: "hash-1" }]);
});

test("preflight reports status per step for incomplete prior setup", () => {
  const prior = journal();
  prior.status = "in_progress";
  prior.completedSteps = ["create_circle"];
  recordSeedTransaction(prior, "create_circle", "hash-1", "confirmed");
  recordSeedTransaction(prior, "join:Alice", "hash-2", "submitted");
  recordSeedTransaction(prior, "join:Bob", "hash-3", "failed");
  const report = buildSeedPreflightReport({
    network: "testnet",
    networkPassphrase: TESTNET_PASSPHRASE,
    expectedPassphrase: TESTNET_PASSPHRASE,
    manifest: { network: "testnet", networkPassphrase: TESTNET_PASSPHRASE },
    journal: prior,
    onChainCircle: { id: "circle-1", matchesDemoIdentity: true },
  });
  assert.equal(report.createCircle, false);
  assert.equal(report.unresolved, true);
  assert.deepEqual(report.steps, [
    { step: "create_circle", status: "confirmed", hash: "hash-1" },
    { step: "join:Alice", status: "submitted", hash: "hash-2" },
    { step: "join:Bob", status: "failed", hash: "hash-3" },
  ]);
});

test("preflight refuses unsupported networks", () => {
  assert.throws(() => buildSeedPreflightReport({
    network: "mainnet",
    networkPassphrase: TESTNET_PASSPHRASE,
    expectedPassphrase: TESTNET_PASSPHRASE,
    manifest: { network: "mainnet", networkPassphrase: TESTNET_PASSPHRASE },
    journal: undefined,
    onChainCircle: undefined,
  }), /only supports testnet/);
});

test("preflight report never contains secret keys", () => {
  const secret = `S${"A".repeat(55)}`;
  const prior = journal();
  recordSeedTransaction(prior, "create_circle", "hash-1", "timeout");
  const report = buildSeedPreflightReport({
    network: "testnet",
    networkPassphrase: TESTNET_PASSPHRASE,
    expectedPassphrase: TESTNET_PASSPHRASE,
    manifest: { network: "testnet", networkPassphrase: TESTNET_PASSPHRASE },
    journal: prior,
    onChainCircle: undefined,
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /secret/i);
});