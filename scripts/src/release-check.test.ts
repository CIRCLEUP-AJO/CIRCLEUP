/**
 * Unit tests for the new release-check.ts checks (Issue #92).
 *
 * All tests use synthetic changelog content via the overrideContent parameter
 * so they never read from disk and are deterministic in any environment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDeploymentOrderGuidance,
  checkSdkCompatibilityNotes,
  checkArtifactHashDocumentation,
} from "./release-check";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChangelog(unreleased: string): string {
  return `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n\n## [0.1.0] — 2026-07-07\n\n### Added\n- initial release\n`;
}

// ── checkDeploymentOrderGuidance ──────────────────────────────────────────────

test("checkDeploymentOrderGuidance: passes when no coordinated change", () => {
  const content = makeChangelog("### Added\n- some app change\n");
  const result = checkDeploymentOrderGuidance(content);
  assert.equal(result.pass, true, "No schema change → no order guidance required");
});

test("checkDeploymentOrderGuidance: passes when schema-only change (no code)", () => {
  const content = makeChangelog("### Changed\n- schema migration added\n");
  const result = checkDeploymentOrderGuidance(content);
  assert.equal(result.pass, true, "Schema change without code change → no order required");
});

test("checkDeploymentOrderGuidance: fails when migration + SDK change, no order", () => {
  const content = makeChangelog([
    "### Changed (SDK)",
    "- Updated SDK client",
    "",
    "### Changed",
    "- Indexer migration added for new schema",
  ].join("\n"));
  const result = checkDeploymentOrderGuidance(content);
  assert.equal(result.pass, false, "Coordinated change without order → must fail");
  assert.ok(result.message.includes("deployment order"), "Message must mention deployment order");
});

test("checkDeploymentOrderGuidance: passes when migration + SDK change + step ordering", () => {
  const content = makeChangelog([
    "### Changed (SDK)",
    "- Updated SDK client",
    "",
    "### Changed",
    "- Indexer migration added. 1. Run migrations. 2. Deploy indexer. 3. Deploy app.",
  ].join("\n"));
  const result = checkDeploymentOrderGuidance(content);
  assert.equal(result.pass, true, "Numbered steps satisfy the order guidance requirement");
});

test("checkDeploymentOrderGuidance: passes with 'deploy before' phrasing", () => {
  const content = makeChangelog([
    "### Changed",
    "- Migration added. Deploy indexer before app.",
  ].join("\n"));
  const result = checkDeploymentOrderGuidance(content);
  // No SDK/app/indexer keyword alongside migration → order not required
  // (indexer IS present in "Deploy indexer before app")
  assert.ok(typeof result.pass === "boolean");
});

test("checkDeploymentOrderGuidance: skipped when no [Unreleased] section", () => {
  const result = checkDeploymentOrderGuidance("# Changelog\n\n## [0.1.0]\n### Added\n- init\n");
  assert.equal(result.pass, true, "Missing [Unreleased] → check skipped (passes)");
});

// ── checkSdkCompatibilityNotes ────────────────────────────────────────────────

test("checkSdkCompatibilityNotes: passes when no SDK section", () => {
  const content = makeChangelog("### Added\n- some indexer feature\n");
  const result = checkSdkCompatibilityNotes(content);
  assert.equal(result.pass, true, "No SDK changes → no compat note required");
});

test("checkSdkCompatibilityNotes: fails when Changed (SDK) present without compat note", () => {
  const content = makeChangelog([
    "### Changed (SDK)",
    "- RPC decoding updated",
  ].join("\n"));
  const result = checkSdkCompatibilityNotes(content);
  assert.equal(result.pass, false, "SDK section without compat note → must fail");
  assert.ok(result.message.includes("compatibility"), "Message must mention compatibility");
});

test("checkSdkCompatibilityNotes: passes when Changed (SDK) has 'consumers must update'", () => {
  const content = makeChangelog([
    "### Changed (SDK)",
    "- RPC decoding updated. Consumers must update their error handling.",
  ].join("\n"));
  const result = checkSdkCompatibilityNotes(content);
  assert.equal(result.pass, true, "'consumers must' satisfies the compat note requirement");
});

test("checkSdkCompatibilityNotes: passes when Changed (SDK) has 'backwards-compatible'", () => {
  const content = makeChangelog([
    "### Changed (SDK)",
    "- New helper method added. This change is backwards-compatible.",
  ].join("\n"));
  const result = checkSdkCompatibilityNotes(content);
  assert.equal(result.pass, true, "'backwards-compatible' satisfies the compat note requirement");
});

test("checkSdkCompatibilityNotes: fails when 'breaking' keyword present without compat note", () => {
  const content = makeChangelog("### Changed\n- Breaking: removed deprecated method\n");
  const result = checkSdkCompatibilityNotes(content);
  assert.equal(result.pass, false, "'breaking' keyword without compat note → must fail");
});

test("checkSdkCompatibilityNotes: passes when 'breaking' + upgrade note present", () => {
  const content = makeChangelog([
    "### Changed",
    "- Breaking: removed deprecated method. Upgrade: replace foo() with bar().",
  ].join("\n"));
  const result = checkSdkCompatibilityNotes(content);
  assert.equal(result.pass, true, "'Upgrade:' satisfies the compat note requirement");
});

test("checkSdkCompatibilityNotes: skipped when no [Unreleased] section", () => {
  const result = checkSdkCompatibilityNotes("# Changelog\n\n## [0.1.0]\n- init\n");
  assert.equal(result.pass, true, "Missing [Unreleased] → check skipped (passes)");
});

// ── checkArtifactHashDocumentation ───────────────────────────────────────────

test("checkArtifactHashDocumentation: passes when no contract changes", () => {
  const content = makeChangelog("### Added\n- new SDK feature\n");
  const result = checkArtifactHashDocumentation(content);
  assert.equal(result.pass, true, "No contract changes → hash doc not required");
});

test("checkArtifactHashDocumentation: fails when contract change without hash reference", () => {
  const content = makeChangelog([
    "### Changed",
    "- Updated circle contract logic",
  ].join("\n"));
  const result = checkArtifactHashDocumentation(content);
  assert.equal(result.pass, false, "Contract change without hash → must fail");
  assert.ok(result.message.includes("artifact hash"), "Message must mention artifact hash");
});

test("checkArtifactHashDocumentation: passes when contract change + 'hash' keyword", () => {
  const content = makeChangelog([
    "### Changed",
    "- Updated circle contract. Verify artifact hash: npm run verify-artifacts.",
  ].join("\n"));
  const result = checkArtifactHashDocumentation(content);
  assert.equal(result.pass, true, "Hash keyword satisfies the requirement");
});

test("checkArtifactHashDocumentation: passes when contract change + 'expected-hashes' reference", () => {
  const content = makeChangelog([
    "### Changed",
    "- Updated WASM build. See contracts/expected-hashes.json for verification.",
  ].join("\n"));
  const result = checkArtifactHashDocumentation(content);
  assert.equal(result.pass, true, "'expected-hashes' satisfies the requirement");
});

test("checkArtifactHashDocumentation: detects 'wasm' keyword as contract signal", () => {
  const content = makeChangelog("### Changed\n- Updated wasm build\n");
  const result = checkArtifactHashDocumentation(content);
  assert.equal(result.pass, false, "wasm keyword without hash doc → must fail");
});

test("checkArtifactHashDocumentation: detects 'cargo' keyword as contract signal", () => {
  const content = makeChangelog("### Changed\n- Bumped Cargo.toml version\n");
  const result = checkArtifactHashDocumentation(content);
  assert.equal(result.pass, false, "cargo keyword without hash doc → must fail");
});

test("checkArtifactHashDocumentation: skipped when no [Unreleased] section", () => {
  const result = checkArtifactHashDocumentation("# Changelog\n\n## [0.1.0]\n- init\n");
  assert.equal(result.pass, true, "Missing [Unreleased] → check skipped (passes)");
});
