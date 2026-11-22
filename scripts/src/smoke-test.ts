#!/usr/bin/env ts-node
/**
 * smoke-test.ts — Release smoke-test matrix (Issue #release-smoke)
 *
 * Defines release readiness checks by environment and package layer:
 *
 *   Layer 1 — contracts : artifact hash verification + provenance record
 *   Layer 2 — sdk       : public API type consistency + package build integrity
 *   Layer 3 — indexer   : migration health validation (schema state + pending)
 *   Layer 4 — app       : production build manifest existence + env parity
 *
 * Guiding principles:
 *   - NON-MUTATING: no contract deployment, no database migration, no
 *     transaction submission. Every check reads from disk or a manifest file.
 *   - BOUNDED: each check has a defined scope (no network calls, no RPC).
 *   - SAFE FOR MAINNET RC: no wallet keys, no secrets, no on-chain writes.
 *   - TESTNET WRITE ISOLATION: any scenario that would touch testnet state
 *     must be explicitly gated behind SMOKE_TESTNET=true and a funded account.
 *
 * The command consumes a deployment manifest (written by deployment-manifest.ts)
 * and reports missing evidence as a failure so the smoke test fails fast when
 * a layer was not actually built/deployed.
 *
 * Exit codes:
 *   0 — All checks for the requested environment passed or warned.
 *   1 — One or more checks failed (missing evidence, hash mismatch, etc.).
 *
 * Usage:
 *   ts-node src/smoke-test.ts [--env=testnet|mainnet] [--manifest=<path>]
 *                              [--layers=contracts,sdk,indexer,app]
 *                              [--json]
 *
 * Flags:
 *   --env=<name>       Target environment: "testnet" (default) or "mainnet".
 *   --manifest=<path>  Path to the deployment manifest JSON (from deployment-manifest.ts).
 *                      Required for layers that need contract addresses.
 *   --layers=<list>    Comma-separated subset of layers to check
 *                      (default: contracts,sdk,indexer,app,writes).
 *   --evidence-dir=<p> Directory with CI evidence such as
 *                      resource-report-<tier>.json (default: artifacts/).
 *   --json             Emit machine-readable JSON report to stdout.
 *
 * Missing evidence is a WARNING for testnet release candidates and a FAILURE
 * for mainnet release candidates. The full matrix and sign-off rules are in
 * docs/RELEASE_SMOKE_TEST_MATRIX.md.
 */

import fs from "fs";
import path from "path";
import { evaluateWriteGate } from "./smoke-write-gate";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SmokeStatus = "pass" | "warn" | "fail" | "skip";

export interface SmokeCheck {
  layer: string;
  name: string;
  status: SmokeStatus;
  message: string;
  detail?: string;
  evidence?: string;
}

export interface SmokeReport {
  generatedAt: string;
  environment: string;
  layers: string[];
  overall: "pass" | "warn" | "fail";
  checks: SmokeCheck[];
  summary: string;
}

/**
 * `writes` is a pseudo-layer that reports the disposable-testnet write gate
 * (smoke-write-gate.ts). It never submits anything itself.
 */
export type LayerName = "contracts" | "sdk" | "indexer" | "app" | "writes";

export const ALL_LAYERS: LayerName[] = ["contracts", "sdk", "indexer", "app", "writes"];

/** Default directory holding CI-produced release evidence (resource reports…). */
export const DEFAULT_EVIDENCE_DIR = "artifacts";

/** Missing evidence is a warning for testnet RCs and a failure for mainnet RCs. */
function missingEvidence(
  environment: string,
  layer: string,
  name: string,
  message: string,
  detail?: string,
): SmokeCheck {
  return environment === "mainnet"
    ? smokeFail(layer, name, message, detail)
    : smokeWarn(layer, name, message, detail);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..", "..");

// ── Helpers ───────────────────────────────────────────────────────────────────

function smokePass(layer: string, name: string, message: string, evidence?: string): SmokeCheck {
  return { layer, name, status: "pass", message, ...(evidence ? { evidence } : {}) };
}

function smokeWarn(layer: string, name: string, message: string, detail?: string): SmokeCheck {
  return { layer, name, status: "warn", message, ...(detail ? { detail } : {}) };
}

function smokeFail(layer: string, name: string, message: string, detail?: string): SmokeCheck {
  return { layer, name, status: "fail", message, ...(detail ? { detail } : {}) };
}

function smokeSkip(layer: string, name: string, message: string): SmokeCheck {
  return { layer, name, status: "skip", message };
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// ── Layer 1 — Contracts ───────────────────────────────────────────────────────

interface ExpectedHashes {
  toolchain?: string;
  target?: string;
  profile?: string;
  artifacts?: Record<string, string>;
}

interface ProvenanceMetadata {
  schemaVersion?: string;
  timestamp?: string;
  git?: { commit?: string; branch?: string; isDirty?: boolean };
  artifacts?: Record<string, { sha256?: string; sizeBytes?: number }>;
}

/**
 * Check 1a — Artifact hashes file exists and is fully populated.
 *
 * contracts/expected-hashes.json must exist and every artifact entry must
 * have a non-empty SHA-256 hash. An absent or partially-populated file means
 * the contract build was not completed for this release candidate.
 */
function checkContractHashes(): SmokeCheck {
  const hashesPath = path.join(ROOT, "contracts", "expected-hashes.json");

  if (!fileExists(hashesPath)) {
    return smokeFail(
      "contracts",
      "artifact_hashes",
      "contracts/expected-hashes.json is missing.",
      "Run: npm run hash-artifacts --workspace=scripts",
    );
  }

  const hashes = readJson<ExpectedHashes>(hashesPath);
  if (!hashes?.artifacts) {
    return smokeFail(
      "contracts",
      "artifact_hashes",
      "contracts/expected-hashes.json has no artifacts map.",
    );
  }

  const unpopulated = Object.entries(hashes.artifacts)
    .filter(([, hash]) => !hash || hash.trim() === "")
    .map(([name]) => name);

  if (unpopulated.length > 0) {
    return smokeFail(
      "contracts",
      "artifact_hashes",
      `${unpopulated.length} artifact(s) have empty hash entries: ${unpopulated.join(", ")}.`,
      "Run: npm run hash-artifacts --workspace=scripts to regenerate.",
    );
  }

  const count = Object.keys(hashes.artifacts).length;
  return smokePass(
    "contracts",
    "artifact_hashes",
    `${count} artifact hash(es) present in expected-hashes.json.`,
    hashesPath,
  );
}

/**
 * Check 1b — Provenance record exists and is recent.
 *
 * contracts/provenance.json must exist. A stale or absent provenance record
 * means the build was not regenerated for this release candidate.
 */
function checkContractProvenance(): SmokeCheck {
  const provenancePath = path.join(ROOT, "contracts", "provenance.json");

  if (!fileExists(provenancePath)) {
    return smokeFail(
      "contracts",
      "artifact_provenance",
      "contracts/provenance.json is missing.",
      "Run: npm run hash-artifacts --workspace=scripts to generate provenance.",
    );
  }

  const provenance = readJson<ProvenanceMetadata>(provenancePath);
  if (!provenance?.timestamp) {
    return smokeWarn(
      "contracts",
      "artifact_provenance",
      "contracts/provenance.json exists but has no timestamp field.",
    );
  }

  const ageMs = Date.now() - Date.parse(provenance.timestamp);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays > 30) {
    return smokeWarn(
      "contracts",
      "artifact_provenance",
      `Provenance record is ${Math.round(ageDays)} days old — regenerate for this release.`,
      `Last generated: ${provenance.timestamp}`,
    );
  }

  const gitNote = provenance.git?.commit
    ? ` (git: ${provenance.git.commit.slice(0, 8)}${provenance.git.isDirty ? " dirty" : ""})`
    : "";

  return smokePass(
    "contracts",
    "artifact_provenance",
    `Provenance record present, generated ${Math.round(ageDays)} day(s) ago${gitNote}.`,
    provenancePath,
  );
}

/** Check 1c — Manifest contract hashes match expected-hashes.json (when manifest provided). */
function checkManifestContractAlignment(manifestPath: string | null): SmokeCheck {
  if (!manifestPath) {
    return smokeSkip(
      "contracts",
      "manifest_hash_alignment",
      "No manifest provided — skipping manifest ↔ expected-hashes alignment check.",
    );
  }

  const hashesPath = path.join(ROOT, "contracts", "expected-hashes.json");
  const hashes = readJson<ExpectedHashes>(hashesPath);
  if (!hashes?.artifacts) {
    return smokeFail(
      "contracts",
      "manifest_hash_alignment",
      "Cannot verify manifest alignment — expected-hashes.json is missing or malformed.",
    );
  }

  type ManifestShape = {
    contracts?: {
      reputation?: { wasmHash?: string };
      circleFactory?: { wasmHash?: string };
      circlWasmHash?: string;
    };
  };
  const manifest = readJson<ManifestShape>(manifestPath);
  if (!manifest?.contracts) {
    return smokeFail(
      "contracts",
      "manifest_hash_alignment",
      "Manifest is missing or has no contracts field.",
    );
  }

  const mismatches: string[] = [];
  const reputationHash = manifest.contracts.reputation?.wasmHash;
  const factoryHash    = manifest.contracts.circleFactory?.wasmHash;
  const circleHash     = manifest.contracts.circlWasmHash;

  if (reputationHash && hashes.artifacts["reputation.wasm"] &&
      reputationHash !== hashes.artifacts["reputation.wasm"]) {
    mismatches.push(`reputation.wasm: manifest=${reputationHash.slice(0,8)} expected=${String(hashes.artifacts["reputation.wasm"]).slice(0,8)}`);
  }
  if (factoryHash && hashes.artifacts["circle_factory.wasm"] &&
      factoryHash !== hashes.artifacts["circle_factory.wasm"]) {
    mismatches.push(`circle_factory.wasm: manifest=${factoryHash.slice(0,8)} expected=${String(hashes.artifacts["circle_factory.wasm"]).slice(0,8)}`);
  }
  if (circleHash && hashes.artifacts["circle.wasm"] &&
      circleHash !== hashes.artifacts["circle.wasm"]) {
    mismatches.push(`circle.wasm: manifest=${circleHash.slice(0,8)} expected=${String(hashes.artifacts["circle.wasm"]).slice(0,8)}`);
  }

  if (mismatches.length > 0) {
    return smokeFail(
      "contracts",
      "manifest_hash_alignment",
      `${mismatches.length} manifest/expected-hashes mismatch(es): ${mismatches.join("; ")}.`,
      "The deployment manifest references different WASM hashes than expected-hashes.json. " +
        "Ensure the same build was used for both.",
    );
  }

  return smokePass(
    "contracts",
    "manifest_hash_alignment",
    "Manifest WASM hashes align with expected-hashes.json.",
  );
}

// ── Layer 2 — SDK ─────────────────────────────────────────────────────────────

interface SdkPackageJson {
  name?: string;
  version?: string;
  main?: string;
  types?: string;
  exports?: unknown;
}

/**
 * Check 2a — SDK dist/ directory exists (package was built).
 *
 * sdk/dist/ must exist and contain index.js and index.d.ts. Absent dist files
 * mean the SDK was not compiled for this release candidate, so the app package
 * reference resolution will fail at build time.
 */
function checkSdkBuild(): SmokeCheck {
  const distDir     = path.join(ROOT, "sdk", "dist");
  const indexJs     = path.join(distDir, "index.js");
  const indexDts    = path.join(distDir, "index.d.ts");

  if (!fileExists(distDir)) {
    return smokeFail(
      "sdk",
      "sdk_build",
      "sdk/dist/ directory is missing — SDK was not built.",
      "Run: npm run build --workspace=sdk",
    );
  }

  const missing: string[] = [];
  if (!fileExists(indexJs))  missing.push("dist/index.js");
  if (!fileExists(indexDts)) missing.push("dist/index.d.ts");

  if (missing.length > 0) {
    return smokeFail(
      "sdk",
      "sdk_build",
      `SDK dist is missing: ${missing.join(", ")}.`,
      "Run: npm run build --workspace=sdk",
    );
  }

  return smokePass(
    "sdk",
    "sdk_build",
    "SDK dist/index.js and dist/index.d.ts are present.",
    distDir,
  );
}

/**
 * Check 2b — SDK package.json has consistent main/types/exports fields.
 *
 * Verifies that the SDK package.json main and types fields point at files that
 * exist on disk, so consumers resolve the package correctly.
 */
function checkSdkPackageIntegrity(): SmokeCheck {
  const pkgPath = path.join(ROOT, "sdk", "package.json");
  const pkg = readJson<SdkPackageJson>(pkgPath);

  if (!pkg) {
    return smokeFail("sdk", "sdk_package_integrity", "sdk/package.json not found.");
  }

  const issues: string[] = [];
  if (!pkg.version) issues.push("missing version field");

  if (pkg.main) {
    const mainPath = path.join(ROOT, "sdk", pkg.main);
    if (!fileExists(mainPath)) {
      issues.push(`main "${pkg.main}" does not exist on disk`);
    }
  }

  if (pkg.types) {
    const typesPath = path.join(ROOT, "sdk", pkg.types);
    if (!fileExists(typesPath)) {
      issues.push(`types "${pkg.types}" does not exist on disk`);
    }
  }

  if (issues.length > 0) {
    return smokeFail(
      "sdk",
      "sdk_package_integrity",
      `SDK package.json has ${issues.length} issue(s): ${issues.join("; ")}.`,
    );
  }

  return smokePass(
    "sdk",
    "sdk_package_integrity",
    `SDK package.json v${pkg.version} — main and types fields resolve on disk.`,
  );
}

// ── Layer 3 — Indexer ─────────────────────────────────────────────────────────

/**
 * Check 3a — Migration files exist and are named correctly.
 *
 * Verifies that indexer/src/db/migrations/ is non-empty and all files follow
 * the NNN_name.sql naming convention. A missing or empty migrations directory
 * on a release that includes schema changes is a sign of an incomplete build.
 */
function checkIndexerMigrations(): SmokeCheck {
  const migrationsDir = path.join(ROOT, "indexer", "src", "db", "migrations");

  if (!fileExists(migrationsDir)) {
    return smokeWarn(
      "indexer",
      "indexer_migrations",
      "indexer/src/db/migrations/ does not exist — no additive migrations present.",
      "This is acceptable if the schema is entirely in schema.sql and no migrations have been added.",
    );
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    return smokeWarn(
      "indexer",
      "indexer_migrations",
      "migrations/ directory exists but contains no .sql files.",
    );
  }

  // Check naming convention: NNN_name.sql
  const malformed = files.filter((f) => !/^\d{3}_/.test(f));
  if (malformed.length > 0) {
    return smokeWarn(
      "indexer",
      "indexer_migrations",
      `${malformed.length} migration file(s) do not follow NNN_name.sql convention: ${malformed.join(", ")}.`,
    );
  }

  return smokePass(
    "indexer",
    "indexer_migrations",
    `${files.length} migration file(s) present and correctly named. Latest: ${files[files.length - 1]}.`,
    migrationsDir,
  );
}

/**
 * Check 3b — schema.sql exists.
 *
 * The base schema file must always be present. Its absence means the indexer
 * cannot initialise a fresh database.
 */
function checkIndexerSchema(): SmokeCheck {
  const schemaPath = path.join(ROOT, "indexer", "src", "db", "schema.sql");

  if (!fileExists(schemaPath)) {
    return smokeFail(
      "indexer",
      "indexer_schema",
      "indexer/src/db/schema.sql is missing.",
      "The base schema file is required for fresh database initialisation.",
    );
  }

  const size = fs.statSync(schemaPath).size;
  return smokePass(
    "indexer",
    "indexer_schema",
    `schema.sql present (${(size / 1024).toFixed(1)} KB).`,
    schemaPath,
  );
}

/**
 * Check 3c — Indexer package.json has a migrate:check script.
 *
 * The migrate:check script is the non-mutating migration health command used
 * in CI and by the restore-verify command. Its absence means there is no
 * programmatic way to verify schema state before deployment.
 */
function checkIndexerMigrateScript(): SmokeCheck {
  const pkgPath = path.join(ROOT, "indexer", "package.json");
  const pkg = readJson<{ scripts?: Record<string, string> }>(pkgPath);

  if (!pkg?.scripts?.["migrate:check"]) {
    return smokeFail(
      "indexer",
      "indexer_migrate_script",
      'indexer/package.json is missing the "migrate:check" script.',
      "Add: \"migrate:check\": \"ts-node src/db/migrate.ts --check\"",
    );
  }

  return smokePass(
    "indexer",
    "indexer_migrate_script",
    '"migrate:check" script present in indexer/package.json.',
  );
}

// ── Layer 4 — App ─────────────────────────────────────────────────────────────

/**
 * Check 4a — .env.example files exist for all workspaces.
 *
 * Each workspace must document its required environment variables in a
 * .env.example file so operators can configure a deployment from scratch.
 */
function checkEnvExamples(): SmokeCheck {
  const examples = [
    { label: "app",     file: path.join(ROOT, "app",     ".env.example") },
    { label: "indexer", file: path.join(ROOT, "indexer", ".env.example") },
    { label: "scripts", file: path.join(ROOT, "scripts", ".env.example") },
  ];

  const missing = examples.filter((e) => !fileExists(e.file)).map((e) => e.label);

  if (missing.length > 0) {
    return smokeFail(
      "app",
      "env_examples",
      `${missing.length} workspace(s) missing .env.example: ${missing.join(", ")}.`,
      "Each workspace must document its required environment variables.",
    );
  }

  return smokePass(
    "app",
    "env_examples",
    `.env.example present in all ${examples.length} workspace(s).`,
  );
}

/**
 * Check 4b — Deployment manifest is valid (when provided).
 *
 * If a manifest path is provided, validate it using validateManifest().
 * A missing or invalid manifest for a mainnet release candidate is a
 * hard failure.
 */
function checkDeploymentManifest(manifestPath: string | null, environment: string): SmokeCheck {
  if (!manifestPath) {
    if (environment === "mainnet") {
      return smokeFail(
        "app",
        "deployment_manifest",
        "No deployment manifest provided for a mainnet release candidate.",
        "Pass --manifest=<path> pointing at the manifest written by deployment-manifest.ts.",
      );
    }
    return smokeSkip(
      "app",
      "deployment_manifest",
      "No manifest path provided — deployment manifest check skipped.",
    );
  }

  if (!fileExists(manifestPath)) {
    return smokeFail(
      "app",
      "deployment_manifest",
      `Deployment manifest not found at: ${manifestPath}`,
    );
  }

  // Validate using the existing validateManifest helper
  try {
    const { validateManifest } = require("./deployment-manifest") as typeof import("./deployment-manifest");
    const result = validateManifest(manifestPath, environment);

    if (!result.ok) {
      return smokeFail(
        "app",
        "deployment_manifest",
        `Deployment manifest validation failed: ${result.errors.length} error(s).`,
        result.errors.join("\n"),
      );
    }

    const m = result.manifest!;
    return smokePass(
      "app",
      "deployment_manifest",
      `Deployment manifest valid: network=${m.network}, deployed=${m.deployedAt}.`,
      manifestPath,
    );
  } catch (err) {
    return smokeFail(
      "app",
      "deployment_manifest",
      `Failed to validate deployment manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Check 4c — No .env files are committed (secrets safety).
 *
 * .env files (not .env.example) must not exist at the workspace roots.
 * A present .env file almost always contains secrets that must not be in the
 * release artefacts.
 */
function checkNoCommittedSecrets(): SmokeCheck {
  const envFiles = [
    path.join(ROOT, "app",     ".env"),
    path.join(ROOT, "indexer", ".env"),
    path.join(ROOT, "scripts", ".env"),
  ];

  const found = envFiles.filter((f) => fileExists(f)).map((f) => path.relative(ROOT, f));

  if (found.length > 0) {
    return smokeFail(
      "app",
      "no_committed_secrets",
      `${found.length} .env file(s) found at workspace roots: ${found.join(", ")}.`,
      "Ensure .env files are in .gitignore and not committed.",
    );
  }

  return smokePass(
    "app",
    "no_committed_secrets",
    "No .env files found at workspace roots.",
  );
}

// ── Additional evidence checks (#865, #867, #868) ────────────────────────────

const RESOURCE_TIERS = ["min", "typical", "max"] as const;

interface ResourceReport {
  schema?: string;
  tier?: string;
  toolchain?: { rust?: string; soroban_sdk?: string };
  workflows?: Array<{ workflow?: string; exceeds_mainnet?: string[]; baseline?: string }>;
}

/**
 * Check 1d — Soroban resource budget reports (#868).
 *
 * Reads `resource-report-<tier>.json` files produced by
 * `contracts/circle/tests/resource_budget_tests.rs` in CI. Regressions or
 * mainnet-limit violations in the min/typical tiers fail; the max tier's
 * mainnet overruns are reported as warnings (see docs/RESOURCE_BUDGETS.md).
 */
export function checkResourceBudgetReports(evidenceDir: string, environment: string): SmokeCheck {
  const missing: string[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];

  for (const tier of RESOURCE_TIERS) {
    const file = path.join(evidenceDir, `resource-report-${tier}.json`);
    const report = readJson<ResourceReport>(file);
    if (!report) {
      missing.push(path.relative(ROOT, file) || file);
      continue;
    }
    if (report.schema !== "circleup.resource-report.v1") {
      problems.push(`${tier}: unexpected schema "${report.schema ?? "none"}"`);
      continue;
    }
    for (const wf of report.workflows ?? []) {
      if (wf.baseline === "regressed") problems.push(`${tier}/${wf.workflow}: regressed beyond tolerance`);
      if (wf.baseline === "unbaselined") warnings.push(`${tier}/${wf.workflow}: no recorded baseline`);
      if ((wf.exceeds_mainnet ?? []).length > 0) {
        const msg = `${tier}/${wf.workflow}: exceeds mainnet limits (${(wf.exceeds_mainnet ?? []).join(", ")})`;
        if (tier === "max") warnings.push(msg);
        else problems.push(msg);
      }
    }
  }

  if (missing.length > 0) {
    return missingEvidence(
      environment,
      "contracts",
      "resource_budget_reports",
      `${missing.length} resource budget report(s) missing.`,
      `Expected: ${missing.join(", ")}\nProduce them with CIRCLEUP_RESOURCE_REPORT_DIR=<dir> cargo test -p circle --test resource_budget_tests.`,
    );
  }
  if (problems.length > 0) {
    return smokeFail("contracts", "resource_budget_reports", `${problems.length} resource budget problem(s).`, problems.join("\n"));
  }
  if (warnings.length > 0) {
    return smokeWarn("contracts", "resource_budget_reports", `${warnings.length} resource budget warning(s).`, warnings.join("\n"));
  }
  return smokePass("contracts", "resource_budget_reports", "All tiers within baseline tolerance and mainnet limits.", evidenceDir);
}

/**
 * Check 1e — Historical storage fixtures for upgrade compatibility (#867).
 */
export function checkStorageCompatibilityFixtures(environment: string): SmokeCheck {
  const dir = path.join(ROOT, "contracts", "fixtures", "storage");
  const required = ["circle", "circle_factory", "reputation"];
  if (!fileExists(dir)) {
    return missingEvidence(environment, "contracts", "storage_compat_fixtures", "contracts/fixtures/storage is missing.");
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const absent = required.filter((c) => !files.some((f) => f.startsWith(`${c}.`)));
  if (absent.length > 0) {
    return missingEvidence(
      environment,
      "contracts",
      "storage_compat_fixtures",
      `No storage fixtures for: ${absent.join(", ")}.`,
    );
  }
  return smokePass("contracts", "storage_compat_fixtures", `${files.length} storage fixture file(s) present.`, path.relative(ROOT, dir));
}

/**
 * Check 2c — SDK transaction/RPC fixtures exist (public API regression evidence).
 */
export function checkSdkTransactionFixtures(environment: string): SmokeCheck {
  const fixture = path.join(ROOT, "sdk", "src", "fixtures", "versionedRpcFixtures.ts");
  if (!fileExists(fixture)) {
    return missingEvidence(environment, "sdk", "sdk_transaction_fixtures", "SDK versioned RPC fixtures are missing.");
  }
  return smokePass("sdk", "sdk_transaction_fixtures", "SDK versioned RPC fixtures present.", path.relative(ROOT, fixture));
}

/**
 * Check 4d — App production build output exists (`next build` → .next/BUILD_ID).
 */
export function checkAppProductionBuild(environment: string): SmokeCheck {
  const buildId = path.join(ROOT, "app", ".next", "BUILD_ID");
  if (!fileExists(buildId)) {
    return missingEvidence(
      environment,
      "app",
      "app_production_build",
      "No app production build found (app/.next/BUILD_ID).",
      "Run the App CI job (npm run build --workspace=app) for this commit before sign-off.",
    );
  }
  const id = fs.readFileSync(buildId, "utf-8").trim();
  return smokePass("app", "app_production_build", `App production build present (BUILD_ID ${id}).`, path.relative(ROOT, buildId));
}

/**
 * Check 5a — Write-based smoke gate (report only; never submits).
 */
export function checkTestnetWriteGate(environment: string, env: Record<string, string | undefined> = process.env): SmokeCheck {
  const decision = evaluateWriteGate(environment, env);
  if (decision.allowed) {
    return smokePass(
      "writes",
      "testnet_write_gate",
      "Disposable testnet write scenarios are permitted (funding is verified before each run).",
      decision.checks.join(", "),
    );
  }
  return decision.status === "fail"
    ? smokeFail("writes", "testnet_write_gate", decision.reason)
    : smokeSkip("writes", "testnet_write_gate", decision.reason);
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

export interface SmokeOptions {
  environment?: string;
  manifestPath?: string | null;
  layers?: LayerName[];
  /** Directory with CI evidence (resource reports). Defaults to `<root>/artifacts`. */
  evidenceDir?: string;
  /** Environment used for the write gate (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * Run the smoke-test matrix for the specified environment and layers.
 *
 * Non-mutating: reads only from disk (expected-hashes.json, provenance.json,
 * package.json files, migrations directory). Never deploys, migrates, or
 * submits transactions.
 */
export function runSmokeTests(options: SmokeOptions = {}): SmokeReport {
  const environment  = options.environment  ?? "testnet";
  const manifestPath = options.manifestPath ?? null;
  const layers       = options.layers       ?? ALL_LAYERS;
  const evidenceDir  = options.evidenceDir  ?? path.join(ROOT, DEFAULT_EVIDENCE_DIR);

  const checks: SmokeCheck[] = [];

  if (layers.includes("contracts")) {
    checks.push(checkContractHashes());
    checks.push(checkContractProvenance());
    checks.push(checkManifestContractAlignment(manifestPath));
    checks.push(checkResourceBudgetReports(evidenceDir, environment));
    checks.push(checkStorageCompatibilityFixtures(environment));
  }

  if (layers.includes("sdk")) {
    checks.push(checkSdkBuild());
    checks.push(checkSdkPackageIntegrity());
    checks.push(checkSdkTransactionFixtures(environment));
  }

  if (layers.includes("indexer")) {
    checks.push(checkIndexerMigrations());
    checks.push(checkIndexerSchema());
    checks.push(checkIndexerMigrateScript());
  }

  if (layers.includes("app")) {
    checks.push(checkEnvExamples());
    checks.push(checkDeploymentManifest(manifestPath, environment));
    checks.push(checkNoCommittedSecrets());
    checks.push(checkAppProductionBuild(environment));
  }

  if (layers.includes("writes")) {
    checks.push(checkTestnetWriteGate(environment, options.env ?? process.env));
  }

  const failures = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");
  const passes   = checks.filter((c) => c.status === "pass");

  const overall: SmokeReport["overall"] =
    failures.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass";

  const summary =
    overall === "pass"
      ? `Smoke test passed: ${passes.length} check(s) passed across ${layers.length} layer(s).`
      : overall === "warn"
      ? `Smoke test has warnings: ${passes.length} passed, ${warnings.length} warned, ${failures.length} failed.`
      : `Smoke test FAILED: ${failures.length} check(s) failed, ${warnings.length} warned, ${passes.length} passed.`;

  return {
    generatedAt: new Date().toISOString(),
    environment,
    layers,
    overall,
    checks,
    summary,
  };
}

// ── Pretty printer ─────────────────────────────────────────────────────────────

export function printSmokeReport(report: SmokeReport): void {
  const icon: Record<SmokeStatus, string> = {
    pass: "✅",
    warn: "⚠️ ",
    fail: "❌",
    skip: "⏭ ",
  };

  console.log("\n[smoke-test] Release smoke-test matrix");
  console.log(`  Environment  : ${report.environment}`);
  console.log(`  Generated at : ${report.generatedAt}`);
  console.log(`  Layers       : ${report.layers.join(", ")}`);
  console.log(`  Overall      : ${icon[report.overall]} ${report.overall.toUpperCase()}`);
  console.log("─".repeat(64));

  let currentLayer = "";
  for (const c of report.checks) {
    if (c.layer !== currentLayer) {
      currentLayer = c.layer;
      console.log(`\n  [${c.layer.toUpperCase()}]`);
    }
    console.log(`    ${icon[c.status]} ${c.name}: ${c.message}`);
    if (c.detail) {
      for (const line of c.detail.split("\n")) {
        console.log(`          ${line}`);
      }
    }
    if (c.evidence) {
      console.log(`          evidence: ${c.evidence}`);
    }
  }

  console.log("\n" + "─".repeat(64));
  console.log(`  ${report.summary}`);

  if (report.overall === "fail") {
    console.log("\n  ⚠  This release candidate has failing checks.");
    console.log("     Resolve the issues above before releasing.");
  }
}

// ── CLI entry point ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  const envArg      = args.find((a) => a.startsWith("--env="));
  const manifestArg = args.find((a) => a.startsWith("--manifest="));
  const layersArg   = args.find((a) => a.startsWith("--layers="));
  const evidenceArg = args.find((a) => a.startsWith("--evidence-dir="));
  const printJson   = args.includes("--json");

  const environment  = envArg      ? envArg.replace("--env=", "")      : "testnet";
  const manifestPath = manifestArg ? manifestArg.replace("--manifest=", "") : null;
  const evidenceDir  = evidenceArg ? path.resolve(evidenceArg.replace("--evidence-dir=", "")) : undefined;
  const layers = layersArg
    ? (layersArg.replace("--layers=", "").split(",") as LayerName[])
    : ALL_LAYERS;

  // This command is non-mutating for every environment: it never deploys,
  // migrates or submits transactions. Mainnet write scenarios do not exist
  // and cannot be enabled (see smoke-write-gate.ts — no override flag).
  if (environment === "mainnet") {
    console.error("[smoke-test] Mainnet release candidate: read-only checks only. No transactions will be submitted.");
  }

  const report = runSmokeTests({ environment, manifestPath, layers, evidenceDir });

  if (printJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSmokeReport(report);
  }

  process.exit(report.overall === "fail" ? 1 : 0);
}
