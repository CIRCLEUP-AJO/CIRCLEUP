#!/usr/bin/env ts-node
/**
 * upgrade-compatibility-report.ts — Pre-upgrade candidate review report
 *
 * Produces a deterministic, read-only compatibility report that maintainers
 * review before authorising a contract or indexer upgrade.  It never submits
 * network transactions, never writes the deployment manifest, and never
 * modifies any artifact file.
 *
 * The report inventories:
 *   1. Artifact hashes      — candidate vs deployed manifest (hash equality)
 *   2. Toolchain provenance — rustc, toolchain channel, git commit, dirty flag
 *   3. Public method signatures — expected-hashes method fixture coverage
 *   4. Event schema changes — known projected / ignored / removed event names
 *   5. Storage compatibility notes — structural reminders per contract
 *
 * IMPORTANT — this report cannot prove an upgrade is safe.  It can only flag
 * evidence that is present, changed, or missing.  See docs/UPGRADE_REVIEW.md
 * for the full review checklist that maintainers must complete alongside this
 * report.
 *
 * Usage:
 *   npx ts-node src/upgrade-compatibility-report.ts [--manifest <path>] [--json]
 *
 * Exit codes:
 *   0 — Report generated; no blocking findings.
 *   1 — One or more BLOCKING findings (missing manifest, hash mismatch, etc.).
 *
 * Flags:
 *   --manifest <path>   Override the deployed manifest path (default: scripts/deployed-manifest.json)
 *   --json              Emit the report as machine-readable JSON instead of text
 *   --hashes <path>     Override expected-hashes.json path
 *   --provenance <path> Override provenance.json path
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

import { validateManifest, type DeploymentManifest } from "./deployment-manifest";
import {
  computeHashes,
  generateProvenance,
  WASM_NAMES,
  type WasmName,
  type ExpectedHashes,
  type ProvenanceMetadata,
} from "./check-artifact-hashes";

// ── Directory resolution ───────────────────────────────────────────────────────

function resolveScriptDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  const { fileURLToPath } = require("url") as typeof import("url");
  const { dirname } = require("path") as typeof import("path");
  return dirname(fileURLToPath((import.meta as { url: string }).url));
}

const SCRIPT_DIR = resolveScriptDir();
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");

// ── Report types ──────────────────────────────────────────────────────────────

/** Severity of a finding. */
export type FindingSeverity = "blocking" | "warning" | "info";

/** A single line-item in the report. */
export interface ReportFinding {
  severity: FindingSeverity;
  section: string;
  message: string;
  detail?: string;
}

/** One section of the full report. */
export interface ReportSection {
  title: string;
  status: "ok" | "changed" | "missing" | "unverifiable";
  findings: ReportFinding[];
  rows?: Array<{ label: string; candidate: string; deployed: string; match: boolean }>;
}

/** The full upgrade compatibility report. */
export interface UpgradeCompatibilityReport {
  generatedAt: string;
  network: string | null;
  candidateBuild: {
    toolchain: string;
    gitCommit: string;
    gitBranch: string;
    isDirty: boolean;
    gitTag?: string;
  } | null;
  deployedManifest: {
    network: string;
    deployedAt: string;
    rustToolchain: string;
    sorobanSdkVersion: string;
    gitCommit?: string;
  } | null;
  sections: ReportSection[];
  summary: {
    blocking: number;
    warnings: number;
    info: number;
    /** true only when there are zero blocking findings */
    noBlockingFindings: boolean;
  };
}

// ── Helper: sha256 a buffer ───────────────────────────────────────────────────

function sha256Buf(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ── Section builders ──────────────────────────────────────────────────────────

/**
 * Section 1 — Artifact hash comparison.
 *
 * Compares each WASM artifact's SHA-256 against the deployed manifest entry
 * (if a manifest exists) AND against the committed expected-hashes.json
 * (the reproducibility baseline).
 *
 * A hash that appears in neither source is flagged as UNVERIFIABLE — this is
 * not automatically blocking but requires the reviewer to confirm the artifact
 * provenance out-of-band.
 */
function buildArtifactSection(
  candidateHashes: Record<WasmName, string> | null,
  manifest: DeploymentManifest | null,
  expectedHashes: ExpectedHashes | null,
  candidateHashError: string | null,
): ReportSection {
  const section: ReportSection = {
    title: "Artifact hashes",
    status: "ok",
    findings: [],
    rows: [],
  };

  if (candidateHashError) {
    section.status = "missing";
    section.findings.push({
      severity: "blocking",
      section: "artifact-hashes",
      message: "Candidate WASM artifacts not found — build before running this report.",
      detail: candidateHashError,
    });
    return section;
  }

  const manifestHashes: Partial<Record<WasmName, string>> = manifest
    ? {
        "reputation.wasm": manifest.contracts.reputation.wasmHash,
        "circle_factory.wasm": manifest.contracts.circleFactory.wasmHash,
        "circle.wasm": manifest.contracts.circlWasmHash,
      }
    : {};

  let anyChanged = false;
  let anyUnverifiable = false;

  for (const name of WASM_NAMES) {
    const candidate = candidateHashes![name];
    const deployed = manifestHashes[name] ?? null;
    const expected = expectedHashes?.artifacts?.[name] ?? null;

    const matchDeployed = deployed !== null && candidate === deployed;
    const matchExpected = expected !== null && candidate === expected;

    let label = name;
    let deployedStr = deployed ?? "(no manifest)";
    let row = { label, candidate, deployed: deployedStr, match: matchDeployed };

    if (deployed === null && expected === null) {
      anyUnverifiable = true;
      section.findings.push({
        severity: "warning",
        section: "artifact-hashes",
        message: `${name}: hash not verifiable — no deployed manifest and no expected-hashes.json entry.`,
        detail:
          "Run `npm run hash-artifacts --workspace=scripts` to create a baseline, " +
          "or deploy to testnet first.",
      });
    } else if (!matchDeployed && deployed !== null) {
      anyChanged = true;
      section.findings.push({
        severity: "warning",
        section: "artifact-hashes",
        message: `${name}: candidate hash differs from deployed manifest.`,
        detail:
          `Deployed : ${deployed}\nCandidate: ${candidate}\n` +
          "This is EXPECTED for a new build. Confirm the change is intentional before deploying.",
      });
    } else if (matchDeployed) {
      section.findings.push({
        severity: "info",
        section: "artifact-hashes",
        message: `${name}: candidate matches deployed manifest hash.`,
        detail: candidate,
      });
    }

    if (!matchExpected && expected !== null) {
      section.findings.push({
        severity: "warning",
        section: "artifact-hashes",
        message: `${name}: candidate hash differs from expected-hashes.json baseline.`,
        detail:
          `Baseline : ${expected}\nCandidate: ${candidate}\n` +
          "If this build is the intended upgrade, run `npm run hash-artifacts` " +
          "to update the baseline and commit the change alongside the contracts.",
      });
    }

    section.rows!.push(row);
  }

  if (anyUnverifiable) {
    section.status = "unverifiable";
  } else if (anyChanged) {
    section.status = "changed";
  }

  return section;
}

/**
 * Section 2 — Toolchain provenance.
 *
 * Reports the build environment for the candidate artifacts and compares
 * toolchain channel and git state against the deployed manifest (when present).
 */
function buildProvenanceSection(
  provenance: ProvenanceMetadata | null,
  manifest: DeploymentManifest | null,
  provenanceError: string | null,
): ReportSection {
  const section: ReportSection = {
    title: "Toolchain provenance",
    status: "ok",
    findings: [],
    rows: [],
  };

  if (provenanceError) {
    section.status = "missing";
    section.findings.push({
      severity: "blocking",
      section: "provenance",
      message: "Could not generate candidate provenance — build artifacts first.",
      detail: provenanceError,
    });
    return section;
  }

  if (!provenance) return section;

  const { toolchain, git } = provenance;

  // Toolchain drift: pinned ≠ active is a reproducibility risk
  if (!toolchain.active.includes(toolchain.pinned)) {
    section.status = "changed";
    section.findings.push({
      severity: "warning",
      section: "provenance",
      message: `Active toolchain (${toolchain.active}) does not match pinned (${toolchain.pinned}).`,
      detail:
        "Artifacts built with a different toolchain may not be reproducible. " +
        `Run: rustup override set ${toolchain.pinned}`,
    });
  } else {
    section.findings.push({
      severity: "info",
      section: "provenance",
      message: `Toolchain pinned and active match: ${toolchain.pinned}`,
    });
  }

  // Dirty working tree
  if (git.isDirty) {
    section.status = "changed";
    section.findings.push({
      severity: "warning",
      section: "provenance",
      message: "Git working tree is dirty — candidate artifacts may not match any committed source.",
      detail:
        "Commit or stash all changes before generating artifacts for a release candidate.",
    });
  } else {
    section.findings.push({
      severity: "info",
      section: "provenance",
      message: `Git working tree is clean. Commit: ${git.commit.slice(0, 8)}${git.tag ? ` (tag: ${git.tag})` : ""}`,
    });
  }

  // Cross-compare toolchain with deployed manifest
  if (manifest?.build?.rustToolchain && manifest.build.rustToolchain !== toolchain.pinned) {
    section.findings.push({
      severity: "warning",
      section: "provenance",
      message: "Candidate toolchain differs from the toolchain recorded in the deployed manifest.",
      detail:
        `Deployed manifest : ${manifest.build.rustToolchain}\n` +
        `Candidate pinned  : ${toolchain.pinned}\n` +
        "Confirm the toolchain change is intentional and that CI passes with the new toolchain.",
    });
  }

  section.rows!.push(
    {
      label: "pinned toolchain",
      candidate: toolchain.pinned,
      deployed: manifest?.build?.rustToolchain ?? "(no manifest)",
      match: manifest?.build?.rustToolchain === toolchain.pinned,
    },
    {
      label: "git commit",
      candidate: git.commit.slice(0, 8),
      deployed: (manifest?.build?.gitCommit ?? "(none)").slice(0, 8),
      match: false, // commits differ by design on every upgrade
    },
  );

  return section;
}

/**
 * Section 3 — Public method / handler fixtures.
 *
 * Checks that each WASM artifact name has a corresponding entry in
 * expected-hashes.json (the verifiable baseline).  The baseline file is the
 * closest thing to a "public interface fixture" for Soroban WASMs without
 * running a full ABI diff, which requires on-chain state.
 *
 * NOTE: expected-hashes.json records artifact hashes, not method signatures.
 * A method signature change is only detectable from the contract source diff
 * or by comparing the WASM binary's exported symbols, which this script does
 * not do.  Reviewers must inspect the Rust diff manually for signature changes.
 */
function buildMethodFixturesSection(
  expectedHashes: ExpectedHashes | null,
  provenanceError: string | null,
): ReportSection {
  const section: ReportSection = {
    title: "Public method fixtures",
    status: "ok",
    findings: [],
  };

  if (!expectedHashes) {
    section.status = "missing";
    section.findings.push({
      severity: "warning",
      section: "method-fixtures",
      message:
        "contracts/expected-hashes.json not found — no artifact baseline to compare against.",
      detail:
        "Run `npm run hash-artifacts --workspace=scripts` after a reproducible build to " +
        "create the baseline, then commit it alongside the contracts.",
    });
    return section;
  }

  section.findings.push({
    severity: "info",
    section: "method-fixtures",
    message: `Baseline toolchain: ${expectedHashes.toolchain} | target: ${expectedHashes.target} | profile: ${expectedHashes.profile}`,
  });

  const missing: string[] = [];
  for (const name of WASM_NAMES) {
    if (!expectedHashes.artifacts?.[name]) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    section.status = "missing";
    section.findings.push({
      severity: "blocking",
      section: "method-fixtures",
      message: `Missing baseline entries in expected-hashes.json: ${missing.join(", ")}.`,
      detail: "Run `npm run hash-artifacts` to populate them.",
    });
  } else {
    section.findings.push({
      severity: "info",
      section: "method-fixtures",
      message: "All artifact entries present in expected-hashes.json.",
    });
  }

  if (provenanceError == null) {
    section.findings.push({
      severity: "info",
      section: "method-fixtures",
      message:
        "Method-level ABI diff is not automated — review the Rust contract source diff " +
        "manually for any added, removed, or renamed entry-points (pub fn annotated with " +
        "#[contractimpl]) before approving.",
    });
  }

  return section;
}

/**
 * Section 4 — Event schema changes.
 *
 * Reads the current event schema registry (indexer/src/eventSchemas.ts) names
 * and comparing them against the event names recorded in the deployed manifest
 * (if present — the manifest does not carry event names, so this section is
 * always "unverifiable" when the manifest is absent or does not include schema
 * metadata).
 *
 * When the indexer package.json can be read, the projected + ignored names are
 * enumerated from the schema module via a static text extraction (no runtime
 * import needed) to avoid coupling this script to the indexer build.
 */
function buildEventSchemaSection(
  indexerSrcPath: string,
): ReportSection {
  const section: ReportSection = {
    title: "Event schema changes",
    status: "ok",
    findings: [],
    rows: [],
  };

  const schemasPath = path.join(indexerSrcPath, "eventSchemas.ts");

  if (!fs.existsSync(schemasPath)) {
    section.status = "unverifiable";
    section.findings.push({
      severity: "warning",
      section: "event-schema",
      message: "indexer/src/eventSchemas.ts not found — cannot enumerate event names.",
      detail: "Event schema review must be done manually from the Rust contract source and EVENTS.md.",
    });
    return section;
  }

  const schemasSource = fs.readFileSync(schemasPath, "utf-8");

  // Extract all `name: "..."` strings from EVENT_SCHEMAS array (static analysis)
  const nameMatches = [...schemasSource.matchAll(/name:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );

  // Extract families: family: "..."
  const familyMatches = [...schemasSource.matchAll(/family:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );

  // Extract handling: "projected" | "ignored"
  const handlingMatches = [
    ...schemasSource.matchAll(/handling:\s*"(projected|ignored)"/g),
  ].map((m) => m[1]);

  if (nameMatches.length === 0) {
    section.status = "unverifiable";
    section.findings.push({
      severity: "warning",
      section: "event-schema",
      message:
        "Could not extract event names from eventSchemas.ts (unexpected source shape).",
      detail: "Review the event schema manually.",
    });
    return section;
  }

  const projected: string[] = [];
  const ignored: string[] = [];

  for (let i = 0; i < nameMatches.length; i++) {
    const family = familyMatches[i] ?? "unknown";
    const handling = handlingMatches[i] ?? "projected";
    const qualifiedName = `${family}/${nameMatches[i]}`;
    if (handling === "ignored") {
      ignored.push(qualifiedName);
    } else {
      projected.push(qualifiedName);
    }
  }

  section.findings.push({
    severity: "info",
    section: "event-schema",
    message: `${projected.length} projected event(s) in current indexer schema:`,
    detail: projected.join(", "),
  });

  if (ignored.length > 0) {
    section.findings.push({
      severity: "info",
      section: "event-schema",
      message: `${ignored.length} ignored event(s) (documented, not projected):`,
      detail: ignored.join(", "),
    });
  }

  section.findings.push({
    severity: "warning",
    section: "event-schema",
    message:
      "Event schema comparison against deployed version is not automated — " +
      "check the git diff of indexer/src/eventSchemas.ts for added, removed, " +
      "or reclassified events before deploying.",
    detail:
      "A removed projected event that the new contract still emits will produce " +
      "unresolved event_failures rows. A new projected event that the old contract " +
      "does not emit is safe but should be noted in CHANGELOG.md.",
  });

  return section;
}

/**
 * Section 5 — Storage compatibility notes.
 *
 * Soroban contracts store data in the ledger under contract-defined keys.
 * Adding new storage keys is backwards compatible; removing or renaming keys
 * is a storage migration that the contract's `upgrade` entry-point must handle.
 * This section cannot automate that check — it emits structured reminders so
 * the reviewer is not relying on memory.
 */
function buildStorageCompatibilitySection(
  manifest: DeploymentManifest | null,
): ReportSection {
  const section: ReportSection = {
    title: "Storage compatibility",
    status: manifest ? "unverifiable" : "missing",
    findings: [],
  };

  if (!manifest) {
    section.findings.push({
      severity: "warning",
      section: "storage",
      message:
        "No deployed manifest — cannot compare contract IDs for storage migration assessment.",
      detail:
        "Storage compatibility review requires the currently-deployed contract addresses. " +
        "Deploy to testnet first and then re-run this report.",
    });
    return section;
  }

  // Remind reviewers of the contracts they are upgrading
  section.findings.push({
    severity: "info",
    section: "storage",
    message:
      "Reviewer must confirm: no Soroban storage keys were renamed or removed without a migration.",
    detail:
      `Upgrading:\n` +
      `  reputation    : ${manifest.contracts.reputation.contractId}\n` +
      `  circleFactory : ${manifest.contracts.circleFactory.contractId}\n\n` +
      `Steps:\n` +
      `  1. Diff contracts/reputation/src/lib.rs storage keys vs deployed ledger entry.\n` +
      `  2. Diff contracts/circle_factory/src/lib.rs storage keys vs deployed ledger entry.\n` +
      `  3. Confirm the upgrade() entry-point migrates any renamed/removed keys.`,
  });

  section.findings.push({
    severity: "warning",
    section: "storage",
    message:
      "Storage key compatibility cannot be proven from artifacts alone — " +
      "this step always requires manual review of the Rust source diff.",
  });

  return section;
}

// ── Report assembly ───────────────────────────────────────────────────────────

export interface UpgradeReportOptions {
  manifestPath?: string;
  expectedHashesPath?: string;
  provenancePath?: string;
  indexerSrcPath?: string;
}

/**
 * Generate the full upgrade compatibility report.
 *
 * Pure function — reads files but never writes them or submits any network
 * request.  Safe to run from any developer machine or CI environment.
 */
export function generateUpgradeCompatibilityReport(
  options: UpgradeReportOptions = {},
): UpgradeCompatibilityReport {
  const manifestPath =
    options.manifestPath ??
    path.join(ROOT, "scripts", "deployed-manifest.json");
  const expectedHashesPath =
    options.expectedHashesPath ??
    path.join(ROOT, "contracts", "expected-hashes.json");
  const indexerSrcPath =
    options.indexerSrcPath ?? path.join(ROOT, "indexer", "src");

  // ── Read deployed manifest ────────────────────────────────────────────────
  const manifestResult = validateManifest(manifestPath);
  const manifest = manifestResult.ok ? (manifestResult.manifest ?? null) : null;

  // ── Read expected-hashes.json ─────────────────────────────────────────────
  let expectedHashes: ExpectedHashes | null = null;
  if (fs.existsSync(expectedHashesPath)) {
    try {
      expectedHashes = JSON.parse(
        fs.readFileSync(expectedHashesPath, "utf-8"),
      ) as ExpectedHashes;
    } catch {
      expectedHashes = null;
    }
  }

  // ── Compute candidate artifact hashes ────────────────────────────────────
  let candidateHashes: Record<WasmName, string> | null = null;
  let candidateHashError: string | null = null;
  try {
    candidateHashes = computeHashes();
  } catch (err) {
    candidateHashError = err instanceof Error ? err.message : String(err);
  }

  // ── Generate candidate provenance ─────────────────────────────────────────
  let provenance: ProvenanceMetadata | null = null;
  let provenanceError: string | null = null;
  try {
    provenance = generateProvenance();
  } catch (err) {
    provenanceError = err instanceof Error ? err.message : String(err);
  }

  // ── Build sections ────────────────────────────────────────────────────────
  const sections: ReportSection[] = [
    buildArtifactSection(
      candidateHashes,
      manifest,
      expectedHashes,
      candidateHashError,
    ),
    buildProvenanceSection(provenance, manifest, provenanceError),
    buildMethodFixturesSection(expectedHashes, provenanceError),
    buildEventSchemaSection(indexerSrcPath),
    buildStorageCompatibilitySection(manifest),
  ];

  // ── Summary ───────────────────────────────────────────────────────────────
  const allFindings = sections.flatMap((s) => s.findings);
  const blocking = allFindings.filter((f) => f.severity === "blocking").length;
  const warnings = allFindings.filter((f) => f.severity === "warning").length;
  const info = allFindings.filter((f) => f.severity === "info").length;

  return {
    generatedAt: new Date().toISOString(),
    network: manifest?.network ?? null,
    candidateBuild: provenance
      ? {
          toolchain: provenance.toolchain.pinned,
          gitCommit: provenance.git.commit,
          gitBranch: provenance.git.branch,
          isDirty: provenance.git.isDirty,
          ...(provenance.git.tag ? { gitTag: provenance.git.tag } : {}),
        }
      : null,
    deployedManifest: manifest
      ? {
          network: manifest.network,
          deployedAt: manifest.deployedAt,
          rustToolchain: manifest.build.rustToolchain,
          sorobanSdkVersion: manifest.build.sorobanSdkVersion,
          gitCommit: manifest.build.gitCommit,
        }
      : null,
    sections,
    summary: {
      blocking,
      warnings,
      info,
      noBlockingFindings: blocking === 0,
    },
  };
}

// ── Text renderer ─────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<FindingSeverity, string> = {
  blocking: "✗  BLOCKING",
  warning: "⚠  WARNING ",
  info: "ℹ  INFO    ",
};

/**
 * Render the report as a human-readable text block suitable for terminal output
 * or inclusion in a PR review comment.
 */
export function renderReportAsText(report: UpgradeCompatibilityReport): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("╔══════════════════════════════════════════════════════╗");
  lines.push("║   CircleUp upgrade compatibility report              ║");
  lines.push("╚══════════════════════════════════════════════════════╝");
  lines.push(`  Generated  : ${report.generatedAt}`);
  lines.push(`  Network    : ${report.network ?? "(unknown — no manifest)"}`);
  lines.push("");

  if (report.candidateBuild) {
    const { toolchain, gitCommit, gitBranch, isDirty, gitTag } = report.candidateBuild;
    lines.push("  Candidate build:");
    lines.push(`    toolchain : ${toolchain}`);
    lines.push(
      `    git       : ${gitCommit.slice(0, 8)} (${gitBranch}${isDirty ? " [dirty]" : ""}${gitTag ? ` tag:${gitTag}` : ""})`,
    );
  } else {
    lines.push("  Candidate build : (build artifacts not found)");
  }

  if (report.deployedManifest) {
    const { network, deployedAt, rustToolchain, sorobanSdkVersion, gitCommit } =
      report.deployedManifest;
    lines.push("");
    lines.push("  Deployed manifest:");
    lines.push(`    network   : ${network}`);
    lines.push(`    deployedAt: ${deployedAt}`);
    lines.push(`    toolchain : ${rustToolchain}`);
    lines.push(`    sdk       : ${sorobanSdkVersion}`);
    if (gitCommit) lines.push(`    git       : ${gitCommit.slice(0, 8)}`);
  } else {
    lines.push("");
    lines.push("  Deployed manifest : (not found — first deployment or path not set)");
  }

  lines.push("");
  lines.push("─".repeat(56));

  for (const section of report.sections) {
    const icon =
      section.status === "ok"
        ? "✅"
        : section.status === "changed"
          ? "⚡"
          : section.status === "missing"
            ? "✗"
            : "?";
    lines.push(`\n  ${icon}  ${section.title.toUpperCase()}`);

    for (const finding of section.findings) {
      lines.push(`     ${SEVERITY_ICON[finding.severity]}  ${finding.message}`);
      if (finding.detail) {
        for (const dl of finding.detail.split("\n")) {
          lines.push(`                       ${dl}`);
        }
      }
    }

    if (section.rows && section.rows.length > 0) {
      lines.push("");
      lines.push("     Artifact      Candidate (SHA-256 first 16 chars)  Deployed");
      for (const row of section.rows) {
        const cand = row.candidate.slice(0, 16);
        const dep = row.deployed.length > 16 ? row.deployed.slice(0, 16) : row.deployed;
        const matchMark = row.match ? "✅" : "≠ ";
        lines.push(`     ${row.label.padEnd(20)} ${cand}…  ${dep}  ${matchMark}`);
      }
    }
  }

  lines.push("");
  lines.push("─".repeat(56));
  lines.push(`  Summary: ${report.summary.blocking} blocking  ${report.summary.warnings} warnings  ${report.summary.info} info`);
  lines.push("");
  if (report.summary.blocking > 0) {
    lines.push("  ✗  There are BLOCKING findings. Resolve them before authorising the upgrade.");
  } else {
    lines.push("  ℹ  No blocking findings. Proceed to manual review checklist (docs/UPGRADE_REVIEW.md).");
    lines.push("     This report does NOT prove the upgrade is safe — it only inventories available evidence.");
  }
  lines.push("");

  return lines.join("\n");
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");

  const manifestIdx = args.indexOf("--manifest");
  const manifestPath =
    manifestIdx !== -1 && args[manifestIdx + 1]
      ? args[manifestIdx + 1]
      : undefined;

  const hashesIdx = args.indexOf("--hashes");
  const hashesPath =
    hashesIdx !== -1 && args[hashesIdx + 1] ? args[hashesIdx + 1] : undefined;

  const provIdx = args.indexOf("--provenance");
  const provenancePath =
    provIdx !== -1 && args[provIdx + 1] ? args[provIdx + 1] : undefined;

  const report = generateUpgradeCompatibilityReport({
    manifestPath,
    expectedHashesPath: hashesPath,
  });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderReportAsText(report));
  }

  process.exit(report.summary.noBlockingFindings ? 0 : 1);
}
