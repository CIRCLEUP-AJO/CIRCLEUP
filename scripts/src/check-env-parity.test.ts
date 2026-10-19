/**
 * Unit tests for check-env-parity.ts
 *
 * Uses synthetic temp files so tests are independent of the actual project
 * source tree.  No live env values are read or asserted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanEnvReads, parseEnvExample, compareEnvParity } from "./check-env-parity";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "circleup-env-parity-test-"));
}

function writeFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ── scanEnvReads ──────────────────────────────────────────────────────────────

test("scanEnvReads: detects process.env.VAR_NAME dot notation", () => {
  const dir = makeTmpDir();
  writeFile(dir, "config.ts", [
    `export const DB_URL = process.env.DATABASE_URL!;`,
    `export const PORT = parseInt(process.env.PORT || "3000", 10);`,
  ].join("\n"));

  const reads = scanEnvReads(dir);

  assert.ok(reads.has("DATABASE_URL"), "DATABASE_URL must be detected");
  assert.ok(reads.has("PORT"), "PORT must be detected");

  fs.rmSync(dir, { recursive: true });
});

test("scanEnvReads: detects process.env[\"VAR_NAME\"] bracket notation", () => {
  const dir = makeTmpDir();
  writeFile(dir, "util.ts", `const val = process.env["SECRET_KEY"] ?? "";`);

  const reads = scanEnvReads(dir);

  assert.ok(reads.has("SECRET_KEY"), "SECRET_KEY must be detected via bracket notation");

  fs.rmSync(dir, { recursive: true });
});

test("scanEnvReads: ignores dynamic bracket access process.env[key]", () => {
  const dir = makeTmpDir();
  writeFile(dir, "dynamic.ts", [
    `for (const key of keys) { const v = process.env[key]; }`,
  ].join("\n"));

  const reads = scanEnvReads(dir);

  assert.equal(reads.size, 0, "Dynamic access must not produce false positives");

  fs.rmSync(dir, { recursive: true });
});

test("scanEnvReads: skips node_modules and dist directories", () => {
  const dir = makeTmpDir();
  const nmDir = path.join(dir, "node_modules", "some-pkg");
  const distDir = path.join(dir, "dist");
  fs.mkdirSync(nmDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  writeFile(nmDir, "index.js", `process.env.NPM_SECRET;`);
  writeFile(distDir, "index.js", `process.env.DIST_SECRET;`);
  writeFile(dir, "src.ts", `process.env.REAL_VAR;`);

  const reads = scanEnvReads(dir);

  assert.ok(reads.has("REAL_VAR"), "REAL_VAR from src must be detected");
  assert.ok(!reads.has("NPM_SECRET"), "node_modules must be excluded");
  assert.ok(!reads.has("DIST_SECRET"), "dist must be excluded");

  fs.rmSync(dir, { recursive: true });
});

test("scanEnvReads: walks subdirectories recursively", () => {
  const dir = makeTmpDir();
  const sub = path.join(dir, "lib");
  fs.mkdirSync(sub, { recursive: true });
  writeFile(sub, "nested.ts", `const u = process.env.NESTED_VAR;`);

  const reads = scanEnvReads(dir);

  assert.ok(reads.has("NESTED_VAR"), "Variables in subdirectories must be detected");

  fs.rmSync(dir, { recursive: true });
});

test("scanEnvReads: returns empty set for non-existent directory", () => {
  const reads = scanEnvReads("/nonexistent/path/xyz");
  assert.equal(reads.size, 0, "Non-existent directory must yield empty set");
});

// ── parseEnvExample ───────────────────────────────────────────────────────────

test("parseEnvExample: extracts variable names from KEY=VALUE lines", () => {
  const dir = makeTmpDir();
  const file = writeFile(dir, ".env.example", [
    "DATABASE_URL=postgresql://localhost/db",
    "PORT=3001",
    "SECRET_KEY=",
  ].join("\n"));

  const vars = parseEnvExample(file);

  assert.ok(vars.has("DATABASE_URL"));
  assert.ok(vars.has("PORT"));
  assert.ok(vars.has("SECRET_KEY"));

  fs.rmSync(dir, { recursive: true });
});

test("parseEnvExample: ignores comment lines and blank lines", () => {
  const dir = makeTmpDir();
  const file = writeFile(dir, ".env.example", [
    "# This is a comment",
    "",
    "# Another comment",
    "REAL_VAR=value",
    "  ",
    "# COMMENTED_OUT_VAR=x",
  ].join("\n"));

  const vars = parseEnvExample(file);

  assert.ok(vars.has("REAL_VAR"), "REAL_VAR must be parsed");
  assert.equal(vars.size, 1, "Only REAL_VAR should be in the set");

  fs.rmSync(dir, { recursive: true });
});

test("parseEnvExample: never exposes values — only names", () => {
  const dir = makeTmpDir();
  const file = writeFile(dir, ".env.example", [
    "API_KEY=super-secret-value-12345",
    "DB_PASS=should-not-appear",
  ].join("\n"));

  const vars = parseEnvExample(file);

  // The returned Set contains only the key names
  const entries = [...vars];
  for (const entry of entries) {
    assert.ok(
      !entry.includes("super-secret") && !entry.includes("should-not-appear"),
      `Value must not appear in parsed result, got: ${entry}`,
    );
  }

  assert.ok(vars.has("API_KEY"), "API_KEY name must be in result");
  assert.ok(vars.has("DB_PASS"), "DB_PASS name must be in result");

  fs.rmSync(dir, { recursive: true });
});

test("parseEnvExample: returns empty set for missing file", () => {
  const vars = parseEnvExample("/nonexistent/.env.example");
  assert.equal(vars.size, 0, "Missing file must yield empty set");
});

// ── compareEnvParity ──────────────────────────────────────────────────────────

test("compareEnvParity: reports undocumented reads", () => {
  const reads = new Set(["DATABASE_URL", "PORT", "UNDOCUMENTED_VAR"]);
  const examples = new Set(["DATABASE_URL", "PORT"]);
  const allowlist = new Set<string>();

  const { undocumented, stale } = compareEnvParity(reads, examples, allowlist);

  assert.deepEqual(undocumented, ["UNDOCUMENTED_VAR"]);
  assert.deepEqual(stale, []);
});

test("compareEnvParity: reports stale .env.example entries", () => {
  const reads = new Set(["DATABASE_URL"]);
  const examples = new Set(["DATABASE_URL", "STALE_VAR", "ANOTHER_STALE"]);
  const allowlist = new Set<string>();

  const { undocumented, stale } = compareEnvParity(reads, examples, allowlist);

  assert.deepEqual(undocumented, []);
  assert.deepEqual(stale.sort(), ["ANOTHER_STALE", "STALE_VAR"]);
});

test("compareEnvParity: allowlisted variables are excluded from both checks", () => {
  const reads = new Set(["DATABASE_URL", "NODE_ENV", "CI"]);
  const examples = new Set(["DATABASE_URL", "DEPLOY_ARTIFACT"]);
  const allowlist = new Set(["NODE_ENV", "CI", "DEPLOY_ARTIFACT"]);

  const { undocumented, stale } = compareEnvParity(reads, examples, allowlist);

  assert.deepEqual(undocumented, [], "Allowlisted reads must not appear as undocumented");
  assert.deepEqual(stale, [], "Allowlisted examples must not appear as stale");
});

test("compareEnvParity: clean result when reads and examples match exactly", () => {
  const vars = new Set(["DATABASE_URL", "PORT", "SECRET_KEY"]);
  const { undocumented, stale } = compareEnvParity(vars, vars, new Set());

  assert.deepEqual(undocumented, []);
  assert.deepEqual(stale, []);
});

test("compareEnvParity: results are sorted alphabetically", () => {
  const reads = new Set(["Z_VAR", "A_VAR", "M_VAR"]);
  const examples = new Set<string>();
  const { undocumented } = compareEnvParity(reads, examples, new Set());

  assert.deepEqual(undocumented, ["A_VAR", "M_VAR", "Z_VAR"]);
});

test("compareEnvParity: never surfaces env values — only name comparison", () => {
  // This test documents that compareEnvParity receives Sets of NAMES only;
  // no value information flows through this function.
  const reads = new Set(["SECRET_TOKEN"]);
  const examples = new Set(["SECRET_TOKEN"]);
  const { undocumented, stale } = compareEnvParity(reads, examples, new Set());

  assert.deepEqual(undocumented, []);
  assert.deepEqual(stale, []);
  // If this function ever started returning values, these assertions about
  // array contents would still pass — the contract is in the type signature
  // (Set<string> of names, not values).
});
