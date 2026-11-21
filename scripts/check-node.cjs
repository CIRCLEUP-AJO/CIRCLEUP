#!/usr/bin/env node
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const nodeVersion = process.versions.node;
const [nodeMajor, nodeMinor] = nodeVersion.split(".").map(Number);
const nodeSupported =
  (nodeMajor === 18 && nodeMinor >= 18) ||
  [22, 24].includes(nodeMajor);

let npmVersion = "unavailable";
try {
  // On Windows `npm` is npm.cmd (a batch script) and cannot be launched
  // directly via execFileSync; routing the version check through a shell
  // resolves it. The command string is a fixed literal (no user input), so
  // passing it as a single string — not an args array — avoids both the
  // .cmd resolution problem and Node's DEP0190 shell-args deprecation.
  // Without this, a valid Node.js 24 / npm 11 pair is rejected as
  // "npm unavailable" on Windows, breaking install from a fresh clone.
  npmVersion = execFileSync("npm --version", {
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // The actionable version message below covers a missing npm executable.
}
const npmMajor = Number(npmVersion.split(".")[0]);
const expectedNpmMajor = nodeMajor === 18 ? 9 : nodeMajor === 22 ? 10 : nodeMajor === 24 ? 11 : undefined;
const npmSupported = npmMajor === expectedNpmMajor;

if (!nodeSupported || !npmSupported) {
  console.error(
    `Unsupported toolchain: Node.js ${nodeVersion}, npm ${npmVersion}. ` +
    "Supported tuples: Node.js 18.18+ with npm 9.x, Node.js 22.x with npm 10.x, or Node.js 24.x with npm 11.x. Install a supported Node.js/npm pair.",
  );
  process.exit(1);
}

console.log(`Supported Node.js ${nodeVersion} and npm ${npmVersion}.`);

// ---------------------------------------------------------------------------
// Verification runner (verify:fast / verify:full)
//
// Invoked as `node scripts/check-node.cjs --verify <tier>` from the root
// package scripts. Each check runs sequentially via spawnSync with inherited
// stdio; the first failing child aborts the run and its exit code becomes the
// parent's exit code. Checks that cannot run locally are reported as skipped
// with the reason (missing env var, tool, or artefact) instead of being
// silently dropped. No shell pipelines and no background processes.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, "..");

function commandExists(command) {
  const probe = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return !probe.error && probe.status === 0;
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function envMissing(name) {
  return !process.env[name] || process.env[name].trim() === "";
}

// Each check: { name, command, args, skip?: () => string | null }.
// `skip` returns a human-readable reason when the check cannot run, or null.
const FAST_CHECKS = [
  { name: "toolchain", command: "node", args: ["scripts/check-node.cjs"] },
  { name: "lint", command: "npm", args: ["run", "lint"] },
  { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { name: "build:sdk", command: "npm", args: ["run", "build", "--workspace", "sdk"] },
  { name: "test:sdk", command: "npm", args: ["run", "test", "--workspace", "sdk"] },
  { name: "test:app", command: "npm", args: ["run", "test", "--workspace", "app"] },
  { name: "test:scripts", command: "npm", args: ["run", "test", "--workspace", "scripts"] },
];

const FULL_CHECKS = [
  ...FAST_CHECKS,
  { name: "build:app", command: "npm", args: ["run", "build", "--workspace", "app"] },
  { name: "build:indexer", command: "npm", args: ["run", "build", "--workspace", "indexer"] },
  { name: "test:indexer", command: "npm", args: ["run", "test", "--workspace", "indexer"] },
  {
    name: "test:contracts",
    command: "npm",
    args: ["run", "test", "--workspace", "contracts"],
    skip: () => (commandExists("cargo") ? null : "cargo (Rust toolchain) not installed"),
  },
  {
    name: "test:perf",
    command: "npm",
    args: ["run", "test", "--workspace", "performance"],
    skip: () => (fileExists("performance/fixtures") ? null : "performance fixtures not generated"),
  },
  {
    name: "test:e2e",
    command: "npm",
    args: ["run", "test:e2e"],
    skip: () => {
      if (envMissing("E2E_BASE_URL")) return "E2E_BASE_URL not set (requires a running app instance)";
      if (envMissing("E2E_SEED_SECRET")) return "E2E_SEED_SECRET not set (requires seeded test data)";
      return null;
    },
  },
];

function runVerification(tier) {
  const checks = tier === "full" ? FULL_CHECKS : FAST_CHECKS;
  const completed = [];
  const skipped = [];

  for (const check of checks) {
    const reason = check.skip ? check.skip() : null;
    if (reason) {
      skipped.push({ name: check.name, reason });
      console.log(`\n[verify:${tier}] SKIP ${check.name} — ${reason}`);
      continue;
    }

    console.log(`\n[verify:${tier}] RUN  ${check.name}: ${check.command} ${check.args.join(" ")}`);
    const result = spawnSync(check.command, check.args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    if (result.error) {
      console.error(`\n[verify:${tier}] FAIL ${check.name}: ${result.error.message}`);
      printSummary(tier, completed, skipped, check.name);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`\n[verify:${tier}] FAIL ${check.name} (exit ${result.status})`);
      printSummary(tier, completed, skipped, check.name);
      process.exit(result.status === null ? 1 : result.status);
    }
    completed.push(check.name);
  }

  printSummary(tier, completed, skipped, null);
}

function printSummary(tier, completed, skipped, failedName) {
  console.log(`\n[verify:${tier}] Summary`);
  console.log("  Completed:");
  if (completed.length === 0) console.log("    (none)");
  for (const name of completed) console.log(`    ✓ ${name}`);
  console.log("  Skipped:");
  if (skipped.length === 0) console.log("    (none)");
  for (const { name, reason } of skipped) console.log(`    - ${name}: ${reason}`);
  if (failedName) console.log(`  Failed: ${failedName}`);
}

const verifyIndex = process.argv.indexOf("--verify");
if (verifyIndex !== -1) {
  const tier = process.argv[verifyIndex + 1];
  if (tier !== "fast" && tier !== "full") {
    console.error("Usage: node scripts/check-node.cjs --verify <fast|full>");
    process.exit(1);
  }
  runVerification(tier);
}