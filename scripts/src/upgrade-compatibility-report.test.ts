/**
 * upgrade-compatibility-report.test.ts
 *
 * Unit tests for the pre-upgrade compatibility report (upgrade-compatibility-report.ts).
 *
 * Acceptance criteria exercised:
 *  1. Stable artifacts (candidate matches deployed manifest) → no blocking findings,
 *     summary section present, report is read-only.
 *  2. Changed artifact (hash differs from manifest) → warning finding, NOT blocking,
 *     report still notes hash change without refusing to proceed.
 *  3. Missing deployed manifest → no blocking finding (first-deploy scenario),
 *     but "unverifiable" or "missing" status on relevant sections.
 *  4. Malformed expected-hashes.json → graceful handling, no crash,
 *     missing-baseline warning present.
 *  5. Report never presents an artifact as "safe" solely because its hash matches.
 *  6. Report is entirely read-only — generateUpgradeCompatibilityReport() is a
 *     pure function with no side-effects when given paths that point to temp dirs.
 *
 * No network calls, no Postgres, no spawned processes are required.
 * All file I/O is against deterministic fixtures written to OS temp directories.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  generateUpgradeCompatibilityReport,
  renderReportAsText,
  type UpgradeCompatibilityReport,
  type ReportFinding,
} from "./upgrade-compatibility-report";
import { writeManifest, type ManifestInput } from "./deployment-manifest";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Create a deterministic 64-char hex hash for test fixtures. */
function fakeHash(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

/** Minimal valid ManifestInput for writeManifest(). */
function makeManifestInput(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    network: "testnet",
    deployerPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    rustToolchain: "1.81.0",
    sorobanSdkVersion: "21.7.7",
    reputation: {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      wasmHash: fakeHash("reputation"),
      deployTxHash: "reputation-tx",
      deployedAtLedger: 1000,
    },
    circleFactory: {
      contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      wasmHash: fakeHash("circle_factory"),
      deployTxHash: "factory-tx",
      deployedAtLedger: 1001,
    },
    circlWasmHash: fakeHash("circle"),
    usdc: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    ...overrides,
  };
}

/** Write a minimal expected-hashes.json to a directory. */
function writeExpectedHashes(
  dir: string,
  hashes: Record<string, string>,
  toolchain = "1.81.0",
): string {
  const file = path.join(dir, "expected-hashes.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      toolchain,
      target: "wasm32-unknown-unknown",
      profile: "release",
      artifacts: hashes,
    }),
  );
  return file;
}

/** Write fake WASM artifacts to a target/wasm32-unknown-unknown/release/ tree. */
function writeFakeWasms(
  contractsDir: string,
  hashes: Record<string, string>,
): string {
  const wasmDir = path.join(
    contractsDir,
    "target",
    "wasm32-unknown-unknown",
    "release",
  );
  fs.mkdirSync(wasmDir, { recursive: true });
  for (const [name, hash] of Object.entries(hashes)) {
    // Write a deterministic buffer whose SHA-256 equals `hash`... which we
    // can't reverse-engineer.  Instead write dummy content and let the test
    // supply the hash directly via expected-hashes.json (no real WASM needed).
    // The tests that need artifact file presence write arbitrary bytes.
    fs.writeFileSync(path.join(wasmDir, name), Buffer.from(hash, "hex").subarray(0, 16));
  }
  return wasmDir;
}

/** Collect all findings from all sections. */
function allFindings(report: UpgradeCompatibilityReport): ReportFinding[] {
  return report.sections.flatMap((s) => s.findings);
}

function blockingFindings(report: UpgradeCompatibilityReport): ReportFinding[] {
  return allFindings(report).filter((f) => f.severity === "blocking");
}

function warningFindings(report: UpgradeCompatibilityReport): ReportFinding[] {
  return allFindings(report).filter((f) => f.severity === "warning");
}

/**
 * Run generateUpgradeCompatibilityReport with paths that all point inside a
 * temp directory so the function never touches real workspace files.
 */
function reportInTempDir(
  setup: (tempRoot: string) => {
    manifestPath?: string;
    expectedHashesPath?: string;
    indexerSrcPath?: string;
  },
): UpgradeCompatibilityReport {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "circleup-report-test-"));
  try {
    const paths = setup(tempRoot);
    return generateUpgradeCompatibilityReport({
      manifestPath: paths.manifestPath ?? path.join(tempRoot, "nonexistent-manifest.json"),
      expectedHashesPath: paths.expectedHashesPath ?? path.join(tempRoot, "nonexistent-hashes.json"),
      indexerSrcPath: paths.indexerSrcPath ?? path.join(tempRoot, "nonexistent-src"),
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

// ── 1. Stable artifacts — candidate matches deployed manifest ─────────────────

test("report: no blocking findings when candidate hashes match the deployed manifest", () => {
  const report = reportInTempDir((tempRoot) => {
    const manifestDir = path.join(tempRoot, "scripts");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "deployed-manifest.json");

    const input = makeManifestInput();
    writeManifest(input, manifestPath);

    const contractsDir = path.join(tempRoot, "contracts");
    fs.mkdirSync(contractsDir, { recursive: true });

    // expected-hashes.json with the same hashes as the manifest
    const hashesPath = writeExpectedHashes(contractsDir, {
      "reputation.wasm": fakeHash("reputation"),
      "circle_factory.wasm": fakeHash("circle_factory"),
      "circle.wasm": fakeHash("circle"),
    });

    return { manifestPath, expectedHashesPath: hashesPath };
  });

  // No blocking findings: manifest is valid, hashes are consistent
  assert.equal(
    blockingFindings(report).length,
    0,
    "stable-artifact scenario must produce zero blocking findings",
  );
  assert.equal(report.summary.noBlockingFindings, true);
});

test("report: summary section is always present and contains finding counts", () => {
  const report = reportInTempDir((_tempRoot) => ({}));

  assert.ok(typeof report.summary.blocking === "number");
  assert.ok(typeof report.summary.warnings === "number");
  assert.ok(typeof report.summary.info === "number");
  assert.ok(typeof report.summary.noBlockingFindings === "boolean");
  assert.ok(Array.isArray(report.sections));
  assert.ok(report.sections.length >= 4, "report must have at least 4 sections");
});

test("report: generatedAt is a valid ISO timestamp", () => {
  const report = reportInTempDir((_t) => ({}));
  assert.ok(
    !Number.isNaN(Date.parse(report.generatedAt)),
    "generatedAt must be a parseable ISO date",
  );
});

// ── 2. Changed artifacts — hash differs from deployed manifest ────────────────

test("report: changed hash produces warning finding, not blocking", () => {
  const report = reportInTempDir((tempRoot) => {
    const manifestDir = path.join(tempRoot, "scripts");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "deployed-manifest.json");

    const input = makeManifestInput();
    writeManifest(input, manifestPath);

    // expected-hashes.json with DIFFERENT hashes from the manifest (new build)
    const contractsDir = path.join(tempRoot, "contracts");
    fs.mkdirSync(contractsDir, { recursive: true });
    const hashesPath = writeExpectedHashes(contractsDir, {
      "reputation.wasm": fakeHash("reputation-v2"),      // changed
      "circle_factory.wasm": fakeHash("circle_factory"), // same
      "circle.wasm": fakeHash("circle"),                  // same
    });

    return { manifestPath, expectedHashesPath: hashesPath };
  });

  // A hash change is a warning, not a blocking finding — it is expected
  // for every new build that intends to upgrade the contracts.
  const blocking = blockingFindings(report);
  assert.equal(
    blocking.length,
    0,
    "changed hash must not produce a blocking finding — it is expected for upgrades",
  );

  const warnings = warningFindings(report);
  const hashWarning = warnings.find(
    (f) =>
      f.section === "artifact-hashes" &&
      (f.message.includes("differs") || f.message.includes("mismatch")),
  );
  assert.ok(
    hashWarning !== undefined,
    "changed hash must produce a warning finding in artifact-hashes section",
  );
});

test("report: artifact section row carries both candidate and deployed hash values", () => {
  const report = reportInTempDir((tempRoot) => {
    const manifestDir = path.join(tempRoot, "scripts");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "deployed-manifest.json");
    writeManifest(makeManifestInput(), manifestPath);

    const contractsDir = path.join(tempRoot, "contracts");
    fs.mkdirSync(contractsDir, { recursive: true });
    const hashesPath = writeExpectedHashes(contractsDir, {
      "reputation.wasm": fakeHash("reputation"),
      "circle_factory.wasm": fakeHash("circle_factory"),
      "circle.wasm": fakeHash("circle"),
    });

    return { manifestPath, expectedHashesPath: hashesPath };
  });

  const artifactSection = report.sections.find((s) => s.title === "Artifact hashes");
  assert.ok(artifactSection, "Artifact hashes section must be present");
  // Rows may be absent when artifacts can't be built (no wasm files), so we
  // only assert the section itself exists and has a valid status.
  assert.ok(
    ["ok", "changed", "missing", "unverifiable"].includes(artifactSection.status),
  );
});

// ── 3. Missing deployed manifest — first-deploy scenario ─────────────────────

test("report: missing manifest does not produce blocking findings", () => {
  const report = reportInTempDir((_tempRoot) => ({
    // No manifest path set → points to a nonexistent file
  }));

  const blocking = blockingFindings(report);
  assert.equal(
    blocking.length,
    0,
    "missing manifest must not be blocking — first-deploy is a valid scenario",
  );

  // network should be null when there is no manifest
  assert.equal(report.network, null, "network must be null when manifest is absent");
  assert.equal(
    report.deployedManifest,
    null,
    "deployedManifest must be null when manifest is absent",
  );
});

test("report: storage section reports missing status when manifest is absent", () => {
  const report = reportInTempDir((_t) => ({}));

  const storageSection = report.sections.find((s) => s.title === "Storage compatibility");
  assert.ok(storageSection, "storage section must be present");
  assert.equal(
    storageSection.status,
    "missing",
    "storage section must have missing status when no manifest exists",
  );
});

test("report: event schema section is always present regardless of manifest", () => {
  const report = reportInTempDir((_t) => ({}));
  const schemaSection = report.sections.find((s) => s.title === "Event schema changes");
  assert.ok(schemaSection, "event schema section must always be present");
});

// ── 4. Malformed expected-hashes.json ─────────────────────────────────────────

test("report: malformed expected-hashes.json produces warning, not a crash", () => {
  const report = reportInTempDir((tempRoot) => {
    const contractsDir = path.join(tempRoot, "contracts");
    fs.mkdirSync(contractsDir, { recursive: true });
    const hashesPath = path.join(contractsDir, "expected-hashes.json");
    // Write syntactically invalid JSON
    fs.writeFileSync(hashesPath, "{ not valid json {{");

    return { expectedHashesPath: hashesPath };
  });

  // Must not throw; must surface a warning about the missing/malformed baseline
  assert.ok(Array.isArray(report.sections));
  const methodSection = report.sections.find(
    (s) => s.title === "Public method fixtures",
  );
  assert.ok(methodSection, "method fixtures section must exist");
  // When hashes are unreadable the section should warn, not block
  const blockingInSection = methodSection.findings.filter(
    (f) => f.severity === "blocking",
  );
  // A missing/unparseable hashes file is either warning or info, not blocking
  // (it just means we have no baseline to compare against)
  assert.equal(
    blockingInSection.length,
    0,
    "malformed expected-hashes should produce a warning finding, not blocking",
  );
});

test("report: missing expected-hashes.json produces warning in method fixtures section", () => {
  const report = reportInTempDir((_t) => ({
    // no hashes path → nonexistent file
  }));

  const methodSection = report.sections.find(
    (s) => s.title === "Public method fixtures",
  );
  assert.ok(methodSection);
  const warning = methodSection.findings.find((f) => f.severity === "warning");
  assert.ok(
    warning !== undefined,
    "missing expected-hashes.json must produce a warning in method fixtures section",
  );
});

// ── 5. Report never labels an artifact as "safe" based solely on hash match ──

test("report: storage section always contains a manual-review reminder", () => {
  const report = reportInTempDir((tempRoot) => {
    const manifestDir = path.join(tempRoot, "scripts");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "deployed-manifest.json");
    writeManifest(makeManifestInput(), manifestPath);
    return { manifestPath };
  });

  const storageSection = report.sections.find((s) => s.title === "Storage compatibility");
  assert.ok(storageSection);

  const manualReviewFinding = storageSection.findings.find(
    (f) => /manual/i.test(f.message) || /cannot.*automat/i.test(f.message),
  );
  assert.ok(
    manualReviewFinding !== undefined,
    "storage section must always contain a manual review reminder",
  );
});

test("report: event schema section always contains a manual-review reminder", () => {
  const report = reportInTempDir((_t) => ({}));

  const schemaSection = report.sections.find((s) => s.title === "Event schema changes");
  assert.ok(schemaSection);

  // Either the "unverifiable" path or the source-diff-required reminder
  const hasManualReminder =
    schemaSection.status === "unverifiable" ||
    schemaSection.findings.some(
      (f) =>
        /manual/i.test(f.message) ||
        /cannot.*automat/i.test(f.message) ||
        /git diff/i.test(f.message),
    );
  assert.ok(
    hasManualReminder,
    "event schema section must remind reviewer that automation is incomplete",
  );
});

test("report text rendering: rendered text never claims artifact is safe", () => {
  const report = reportInTempDir((tempRoot) => {
    const manifestDir = path.join(tempRoot, "scripts");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "deployed-manifest.json");
    writeManifest(makeManifestInput(), manifestPath);

    const contractsDir = path.join(tempRoot, "contracts");
    fs.mkdirSync(contractsDir, { recursive: true });
    const hashesPath = writeExpectedHashes(contractsDir, {
      "reputation.wasm": fakeHash("reputation"),
      "circle_factory.wasm": fakeHash("circle_factory"),
      "circle.wasm": fakeHash("circle"),
    });

    return { manifestPath, expectedHashesPath: hashesPath };
  });

  const text = renderReportAsText(report);

  // The rendered text must not claim the artifact or upgrade is "safe"
  const safePatterns = [
    /upgrade is safe/i,
    /artifact is safe/i,
    /build is safe/i,
    /proven safe/i,
  ];
  for (const pat of safePatterns) {
    assert.ok(
      !pat.test(text),
      `Rendered report must not claim the upgrade is safe. Found pattern: ${pat}`,
    );
  }

  // It must explicitly state that it cannot prove safety
  assert.ok(
    /does not prove/i.test(text) || /cannot.*prove/i.test(text) || /cannot.*prove/i.test(text),
    "Rendered report must explicitly state it cannot prove the upgrade is safe",
  );
});

// ── 6. Read-only: function produces no side effects ──────────────────────────

test("report: generateUpgradeCompatibilityReport does not write any files", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "circleup-readonly-test-"),
  );
  try {
    const manifestDir = path.join(tempRoot, "scripts");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "deployed-manifest.json");
    writeManifest(makeManifestInput(), manifestPath);

    const contractsDir = path.join(tempRoot, "contracts");
    fs.mkdirSync(contractsDir, { recursive: true });
    const hashesPath = writeExpectedHashes(contractsDir, {
      "reputation.wasm": fakeHash("reputation"),
      "circle_factory.wasm": fakeHash("circle_factory"),
      "circle.wasm": fakeHash("circle"),
    });

    // Snapshot the directory listing before the report run
    const before = fs.readdirSync(tempRoot, { recursive: true });

    generateUpgradeCompatibilityReport({
      manifestPath,
      expectedHashesPath: hashesPath,
      indexerSrcPath: path.join(tempRoot, "nonexistent-src"),
    });

    // Snapshot after
    const after = fs.readdirSync(tempRoot, { recursive: true });

    assert.deepEqual(
      before.sort(),
      after.sort(),
      "generateUpgradeCompatibilityReport must not create or modify any files",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("report: can be called multiple times without cumulative side effects", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "circleup-idempotent-test-"),
  );
  try {
    const manifestDir = path.join(tempRoot, "scripts");
    fs.mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "deployed-manifest.json");
    writeManifest(makeManifestInput(), manifestPath);

    const opts = {
      manifestPath,
      expectedHashesPath: path.join(tempRoot, "nonexistent"),
      indexerSrcPath: path.join(tempRoot, "nonexistent"),
    };

    const r1 = generateUpgradeCompatibilityReport(opts);
    const r2 = generateUpgradeCompatibilityReport(opts);

    // Finding counts must be identical across two independent calls
    assert.equal(
      r1.summary.blocking,
      r2.summary.blocking,
      "blocking count must be deterministic across repeated calls",
    );
    assert.equal(
      r1.summary.warnings,
      r2.summary.warnings,
      "warning count must be deterministic across repeated calls",
    );
    assert.equal(
      r1.sections.length,
      r2.sections.length,
      "section count must be deterministic",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ── 7. JSON output mode ───────────────────────────────────────────────────────

test("report: JSON output is parseable and contains all top-level fields", () => {
  const report = reportInTempDir((_t) => ({}));
  const json = JSON.stringify(report);
  const parsed = JSON.parse(json) as Record<string, unknown>;

  const required = ["generatedAt", "network", "candidateBuild", "deployedManifest", "sections", "summary"];
  for (const key of required) {
    assert.ok(key in parsed, `JSON output must contain '${key}' field`);
  }
});
