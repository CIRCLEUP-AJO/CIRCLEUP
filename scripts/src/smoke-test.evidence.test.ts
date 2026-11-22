/**
 * Tests for the release-evidence checks added to the smoke-test matrix (#865).
 *
 * Missing evidence must be a warning for testnet RCs and a failure for
 * mainnet RCs; regressions are always failures; the write gate never allows
 * mainnet writes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ALL_LAYERS,
  checkResourceBudgetReports,
  checkTestnetWriteGate,
  runSmokeTests,
} from "./smoke-test";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "circleup-evidence-"));
}

function writeReport(dir: string, tier: string, workflows: unknown[]): void {
  fs.writeFileSync(
    path.join(dir, `resource-report-${tier}.json`),
    JSON.stringify({ schema: "circleup.resource-report.v1", tier, workflows }),
  );
}

const CLEAN = [{ workflow: "create", exceeds_mainnet: [], baseline: "within_tolerance" }];

describe("checkResourceBudgetReports", () => {
  test("missing reports warn on testnet and fail on mainnet", () => {
    const dir = tmpDir();
    try {
      assert.equal(checkResourceBudgetReports(dir, "testnet").status, "warn");
      assert.equal(checkResourceBudgetReports(dir, "mainnet").status, "fail");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clean reports pass", () => {
    const dir = tmpDir();
    try {
      for (const t of ["min", "typical", "max"]) writeReport(dir, t, CLEAN);
      assert.equal(checkResourceBudgetReports(dir, "mainnet").status, "pass");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a regression fails regardless of environment", () => {
    const dir = tmpDir();
    try {
      writeReport(dir, "min", [{ workflow: "payout", exceeds_mainnet: [], baseline: "regressed" }]);
      writeReport(dir, "typical", CLEAN);
      writeReport(dir, "max", CLEAN);
      assert.equal(checkResourceBudgetReports(dir, "testnet").status, "fail");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mainnet-limit overrun fails for typical but only warns for max", () => {
    const dir = tmpDir();
    try {
      writeReport(dir, "min", CLEAN);
      writeReport(dir, "typical", CLEAN);
      writeReport(dir, "max", [{ workflow: "close", exceeds_mainnet: ["events_bytes"], baseline: "within_tolerance" }]);
      assert.equal(checkResourceBudgetReports(dir, "mainnet").status, "warn");

      writeReport(dir, "typical", [{ workflow: "close", exceeds_mainnet: ["write_entries"], baseline: "within_tolerance" }]);
      assert.equal(checkResourceBudgetReports(dir, "mainnet").status, "fail");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unbaselined workflows are surfaced as warnings", () => {
    const dir = tmpDir();
    try {
      for (const t of ["min", "typical", "max"]) {
        writeReport(dir, t, [{ workflow: "join", exceeds_mainnet: [], baseline: "unbaselined" }]);
      }
      assert.equal(checkResourceBudgetReports(dir, "testnet").status, "warn");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkTestnetWriteGate", () => {
  test("is skipped by default", () => {
    assert.equal(checkTestnetWriteGate("testnet", {}).status, "skip");
  });

  test("mainnet with SMOKE_TESTNET=true is a failure, never a pass", () => {
    assert.equal(checkTestnetWriteGate("mainnet", { SMOKE_TESTNET: "true" }).status, "fail");
  });
});

describe("runSmokeTests — new layers", () => {
  test("default layers include the writes pseudo-layer", () => {
    assert.deepEqual(ALL_LAYERS, ["contracts", "sdk", "indexer", "app", "writes"]);
    const report = runSmokeTests({ environment: "testnet", layers: ["writes"], env: {} });
    assert.deepEqual(report.checks.map((c) => c.name), ["testnet_write_gate"]);
  });

  test("mainnet RC with no evidence directory fails on resource reports", () => {
    const dir = tmpDir();
    try {
      const report = runSmokeTests({ environment: "mainnet", layers: ["contracts"], evidenceDir: dir });
      const c = report.checks.find((x) => x.name === "resource_budget_reports");
      assert.equal(c?.status, "fail");
      assert.equal(report.overall, "fail");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
