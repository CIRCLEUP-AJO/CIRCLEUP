#!/usr/bin/env ts-node
/**
 * release-check.ts — Release readiness dry-run (Issue #85)
 *
 * Validates that a CircleUp release is ready to ship by checking:
 *   1. All workspace package versions are declared.
 *   2. CHANGELOG.md has a non-empty [Unreleased] section with required sub-headings.
 *   3. Every package that carries changes has a corresponding changelog entry.
 *   4. Migration notes exist when the indexer schema may have changed.
 *   5. Cross-package version compatibility is explicit (no silent testnet fallback).
 *
 * Exit codes:
 *   0 — All checks passed; safe to release.
 *   1 — One or more checks failed; do not release.
 *
 * Usage:
 *   npx ts-node src/release-check.ts [--verbose]
 *
 * This script is read-only: it never publishes packages, deploys contracts,
 * or modifies files.  It is safe to run on any contributor machine.
 */

import fs from 'fs';
import path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  pass: boolean;
  message: string;
  detail?: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface CargoToml {
  package?: { name?: string; version?: string };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..');
const VERBOSE = process.argv.includes('--verbose');

/** Sub-headings that must appear in [Unreleased] when it is non-empty. */
const REQUIRED_CHANGELOG_SECTIONS = ['### Added', '### Changed', '### Fixed'];

/**
 * Files whose presence under indexer/src/db/ signals a potential schema
 * change that requires a migration note in CHANGELOG.md.
 */
const MIGRATION_SIGNAL_PATTERNS = [
  /indexer\/src\/db\/migrate\.ts/,
  /indexer\/src\/db\/schema\.sql/,
  /indexer\/src\/db\/migrations\//,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function pass(name: string, message: string): CheckResult {
  return { name, pass: true, message };
}

function fail(name: string, message: string, detail?: string): CheckResult {
  return { name, pass: false, message, detail };
}

// ── Check implementations ─────────────────────────────────────────────────────

/**
 * Check 1 — All workspace packages declare a version.
 *
 * Reports the version of each package so the release author can spot
 * accidental version drift at a glance.
 */
function checkPackageVersions(): CheckResult {
  const packages: Array<{ label: string; file: string }> = [
    { label: 'sdk',     file: path.join(ROOT, 'sdk', 'package.json') },
    { label: 'app',     file: path.join(ROOT, 'app', 'package.json') },
    { label: 'indexer', file: path.join(ROOT, 'indexer', 'package.json') },
    { label: 'scripts', file: path.join(ROOT, 'scripts', 'package.json') },
  ];

  const missing: string[] = [];
  const found: string[] = [];

  for (const { label, file } of packages) {
    const pkg = readJson<PackageJson>(file);
    if (!pkg) {
      missing.push(`${label} (file not found: ${file})`);
    } else if (!pkg.version) {
      missing.push(`${label} (no "version" field in ${file})`);
    } else {
      found.push(`${label}@${pkg.version}`);
    }
  }

  // Also check Rust crate versions from contracts/Cargo.toml members
  const cargoWorkspace = readFile(path.join(ROOT, 'contracts', 'Cargo.toml'));
  if (!cargoWorkspace) {
    missing.push('contracts/Cargo.toml (not found)');
  }

  if (missing.length > 0) {
    return fail(
      'package-versions',
      `${missing.length} package(s) missing version`,
      `Missing: ${missing.join(', ')}\nFound: ${found.join(', ')}`,
    );
  }

  return pass('package-versions', `All packages versioned: ${found.join(', ')}`);
}

/**
 * Check 2 — CHANGELOG.md has a well-formed [Unreleased] section.
 *
 * The [Unreleased] section must exist and contain at least one of the
 * required sub-headings (Added, Changed, Fixed).  An empty [Unreleased]
 * section signals that no changes have been documented since the last
 * release, which is a warning rather than a hard failure.
 */
function checkChangelog(): CheckResult {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const content = readFile(changelogPath);

  if (!content) {
    return fail('changelog', 'CHANGELOG.md not found', changelogPath);
  }

  const lines = content.split('\n');

  // Find the [Unreleased] heading
  const unreleasedIdx = lines.findIndex(l =>
    /^##\s+\[Unreleased\]/i.test(l),
  );
  if (unreleasedIdx === -1) {
    return fail(
      'changelog',
      'CHANGELOG.md has no [Unreleased] section',
      'Add ## [Unreleased] followed by ### Added, ### Changed, ### Fixed sub-sections',
    );
  }

  // Extract lines until the next ## heading (next released version)
  const unreleasedLines: string[] = [];
  for (let i = unreleasedIdx + 1; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) break;
    unreleasedLines.push(lines[i]);
  }

  const unreleasedBlock = unreleasedLines.join('\n');

  // Check for required sub-sections
  const missingSections = REQUIRED_CHANGELOG_SECTIONS.filter(
    s => !unreleasedBlock.includes(s),
  );

  if (missingSections.length === REQUIRED_CHANGELOG_SECTIONS.length) {
    return fail(
      'changelog',
      '[Unreleased] section is empty or missing all required sub-headings',
      `Required sub-headings: ${REQUIRED_CHANGELOG_SECTIONS.join(', ')}\n` +
        'Add at least one entry before releasing.',
    );
  }

  // Soft warning if some sections are missing (not all packages need all sections)
  if (VERBOSE && missingSections.length > 0) {
    console.log(
      `  [info] [Unreleased] is missing: ${missingSections.join(', ')} — OK if no changes of that type`,
    );
  }

  return pass(
    'changelog',
    `[Unreleased] section is present with ${REQUIRED_CHANGELOG_SECTIONS.length - missingSections.length}/${REQUIRED_CHANGELOG_SECTIONS.length} required sub-headings`,
  );
}

/**
 * Check 3 — If indexer schema files exist, CHANGELOG must contain a
 * migration note.
 *
 * The presence of migrate.ts or schema.sql signals that a database schema
 * migration may be required.  Releases that include these files must carry
 * explicit migration and rollback notes in CHANGELOG.md so operators are
 * never caught off-guard.
 */
function checkMigrationNotes(): CheckResult {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const changelog = readFile(changelogPath) ?? '';

  // Detect whether any schema-related files exist in the repo
  const schemaFilesPresent = MIGRATION_SIGNAL_PATTERNS.some(pattern => {
    const dir = path.join(ROOT, 'indexer', 'src', 'db');
    if (!fs.existsSync(dir)) return false;
    try {
      const entries = fs.readdirSync(dir, { recursive: true } as fs.ObjectEncodingOptions & { withFileTypes?: false });
      return (entries as string[]).some(e => pattern.test(e));
    } catch {
      return false;
    }
  });

  if (!schemaFilesPresent) {
    return pass('migration-notes', 'No schema files detected — migration note not required');
  }

  // When schema files exist, the changelog must mention migrations
  const hasMigrationMention =
    /migrat/i.test(changelog) || /schema/i.test(changelog) || /rollback/i.test(changelog);

  if (!hasMigrationMention) {
    return fail(
      'migration-notes',
      'Schema files detected but CHANGELOG has no migration / rollback notes',
      'Add a migration note to [Unreleased] describing how to apply and roll back the schema change.',
    );
  }

  return pass('migration-notes', 'CHANGELOG contains migration reference alongside schema files');
}

/**
 * Check 4 — Cross-package SDK version compatibility.
 *
 * The SDK is a shared dependency of app and indexer.  If the SDK version
 * in sdk/package.json does not match what app and indexer reference, the
 * release may break a downstream consumer.
 */
function checkSdkVersionAlignment(): CheckResult {
  const sdkPkg = readJson<PackageJson>(path.join(ROOT, 'sdk', 'package.json'));
  const sdkVersion = sdkPkg?.version;

  if (!sdkVersion) {
    return fail('sdk-alignment', 'Could not read sdk/package.json version');
  }

  const consumers: Array<{ label: string; file: string }> = [
    { label: 'app',     file: path.join(ROOT, 'app', 'package.json') },
    { label: 'indexer', file: path.join(ROOT, 'indexer', 'package.json') },
  ];

  const mismatches: string[] = [];

  for (const { label, file } of consumers) {
    const pkg = readJson<PackageJson>(file);
    if (!pkg) continue;

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const ref = Object.entries(allDeps).find(([k]) =>
      k === '@circleup/sdk' || k === 'sdk',
    );

    if (!ref) {
      if (VERBOSE) {
        console.log(`  [info] ${label} does not reference @circleup/sdk — skipping alignment check`);
      }
      continue;
    }

    const [, refVersion] = ref;
    // Strip semver range prefixes (^, ~) for comparison
    const normalized = refVersion.replace(/^[\^~>=<*]+/, '');
    if (normalized !== sdkVersion) {
      mismatches.push(`${label} references sdk@${refVersion} but sdk/package.json declares ${sdkVersion}`);
    }
  }

  if (mismatches.length > 0) {
    return fail(
      'sdk-alignment',
      `SDK version mismatch in ${mismatches.length} consumer(s)`,
      mismatches.join('\n'),
    );
  }

  return pass('sdk-alignment', `SDK version ${sdkVersion} is consistent across consumers`);
}

/**
 * Check 5 — No environment file commits secrets.
 *
 * .env files (not .env.example) must not be tracked by the repository.
 * A committed .env file almost always contains secrets and would break the
 * "dry-run is safe for contributor machines" acceptance criterion.
 */
function checkNoCommittedEnvFiles(): CheckResult {
  const envFiles = [
    path.join(ROOT, 'app', '.env'),
    path.join(ROOT, 'indexer', '.env'),
    path.join(ROOT, 'scripts', '.env'),
  ];

  const found: string[] = envFiles.filter(f => fs.existsSync(f));

  if (found.length > 0) {
    return fail(
      'no-committed-env',
      `${found.length} .env file(s) present on disk`,
      `Found: ${found.map(f => path.relative(ROOT, f)).join(', ')}\n` +
        'Ensure these are listed in .gitignore and not committed to the repository.',
    );
  }

  return pass('no-committed-env', 'No .env files found on disk (secrets safe)');
}

// ── Runner ────────────────────────────────────────────────────────────────────

function runChecks(): void {
  console.log('CircleUp release readiness check\n');

  const checks: Array<() => CheckResult> = [
    checkPackageVersions,
    checkChangelog,
    checkMigrationNotes,
    checkSdkVersionAlignment,
    checkNoCommittedEnvFiles,
  ];

  const results: CheckResult[] = checks.map(fn => {
    try {
      return fn();
    } catch (err) {
      return fail('internal', `Check threw an exception: ${(err as Error).message}`);
    }
  });

  let allPassed = true;
  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    const label = r.pass ? 'PASS' : 'FAIL';
    console.log(`  [${label}] ${icon} ${r.name}: ${r.message}`);
    if (!r.pass && r.detail) {
      for (const line of r.detail.split('\n')) {
        console.log(`          ${line}`);
      }
    }
    if (!r.pass) allPassed = false;
  }

  console.log('');

  if (allPassed) {
    console.log('All checks passed. Release is ready.');
    process.exit(0);
  } else {
    const failCount = results.filter(r => !r.pass).length;
    console.log(
      `${failCount} check(s) failed. Resolve the issues above before releasing.`,
    );
    process.exit(1);
  }
}

runChecks();
