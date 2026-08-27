#!/usr/bin/env ts-node
/**
 * check-artifact-hashes.ts — Contract build reproducibility check (Issue #396)
 *
 * Verifies that the compiled WASM artifacts match the expected SHA-256
 * hashes committed in contracts/expected-hashes.json.  When run with
 * --update it rebuilds the artifacts and writes fresh expected hashes.
 *
 * Usage:
 *   # Verify existing artifacts against expected hashes
 *   npx ts-node src/check-artifact-hashes.ts
 *
 *   # Rebuild contracts and update expected-hashes.json
 *   npx ts-node src/check-artifact-hashes.ts --update
 *
 *   # Print hashes without comparing (useful for first-time setup)
 *   npx ts-node src/check-artifact-hashes.ts --print
 *
 * Exit codes:
 *   0 — All hashes match (verify mode) or hashes written (update mode).
 *   1 — One or more hashes differ or artifacts are missing.
 *
 * This script never deploys contracts or submits transactions.
 * It is safe to run on any contributor machine.
 */

import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT         = path.resolve(__dirname, '..', '..');
const CONTRACTS    = path.join(ROOT, 'contracts');
const WASM_DIR     = path.join(CONTRACTS, 'target', 'wasm32-unknown-unknown', 'release');
const HASHES_FILE  = path.join(CONTRACTS, 'expected-hashes.json');
const TOOLCHAIN_FILE = path.join(CONTRACTS, 'rust-toolchain.toml');

const WASM_NAMES = ['reputation.wasm', 'circle_factory.wasm', 'circle.wasm'] as const;
type WasmName = typeof WASM_NAMES[number];

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExpectedHashes {
  _comment?: string;
  _comment2?: string;
  _comment3?: string;
  toolchain: string;
  target: string;
  profile: string;
  artifacts: Record<WasmName, string>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute SHA-256 of a file, returned as a lowercase hex string. */
function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Read rust-toolchain.toml and extract the channel (e.g. "1.81.0"). */
function readPinnedToolchain(): string {
  if (!fs.existsSync(TOOLCHAIN_FILE)) {
    return 'unknown (rust-toolchain.toml not found)';
  }
  const content = fs.readFileSync(TOOLCHAIN_FILE, 'utf8');
  const match = content.match(/channel\s*=\s*"([^"]+)"/);
  return match ? match[1] : 'unknown (channel not found)';
}

/** Run a shell command and return its trimmed stdout. */
function run(cmd: string, label: string): string {
  console.log(`\n  [build] ${label}...`);
  console.log(`    > ${cmd}`);
  const out = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return out.trim();
}

/** Resolve the active toolchain via `rustup show active-toolchain`. */
function activeToolchain(): string {
  try {
    const out = execSync('rustup show active-toolchain', { encoding: 'utf-8', stdio: 'pipe' });
    return out.trim().split(' ')[0] ?? 'unknown';
  } catch {
    return 'unknown (rustup not available)';
  }
}

// ── Build ─────────────────────────────────────────────────────────────────────

function buildContracts(): void {
  run(
    `cargo build --release --target wasm32-unknown-unknown --manifest-path ${CONTRACTS}/Cargo.toml`,
    'Building all contracts',
  );
}

// ── Compute hashes ────────────────────────────────────────────────────────────

function computeHashes(): Record<WasmName, string> {
  const result = {} as Record<WasmName, string>;
  for (const name of WASM_NAMES) {
    const p = path.join(WASM_DIR, name);
    if (!fs.existsSync(p)) {
      throw new Error(
        `Artifact not found: ${p}\n` +
        'Run with --update to build and regenerate hashes, or build manually:\n' +
        '  cargo build --release --target wasm32-unknown-unknown',
      );
    }
    result[name] = sha256File(p);
  }
  return result;
}

// ── Update mode ───────────────────────────────────────────────────────────────

function updateHashes(): void {
  console.log('CircleUp — updating expected artifact hashes (Issue #396)\n');

  const pinned = readPinnedToolchain();
  const active = activeToolchain();

  console.log(`  Pinned toolchain : ${pinned}`);
  console.log(`  Active toolchain : ${active}`);

  if (!active.includes(pinned)) {
    console.warn(
      `\n  ⚠  Active toolchain (${active}) does not match pinned (${pinned}).\n` +
      `     Run: rustup override set ${pinned}\n` +
      '     Hashes will still be written but may not be reproducible on CI.',
    );
  }

  buildContracts();

  const hashes = computeHashes();

  const out: ExpectedHashes = {
    _comment:  'Expected SHA-256 hashes of release WASM artifacts built from this commit.',
    _comment2: 'Regenerate with: npm run hash-artifacts --workspace=scripts',
    _comment3: 'Commit this file together with contracts/rust-toolchain.toml whenever contracts change.',
    toolchain: pinned,
    target:    'wasm32-unknown-unknown',
    profile:   'release',
    artifacts: hashes,
  };

  fs.writeFileSync(HASHES_FILE, JSON.stringify(out, null, 2) + '\n');

  console.log('\n  ✅ expected-hashes.json updated:');
  for (const [name, hash] of Object.entries(hashes)) {
    console.log(`     ${name}: ${hash}`);
  }
  console.log(`\n  Commit contracts/expected-hashes.json and contracts/rust-toolchain.toml.`);
}

// ── Print mode ────────────────────────────────────────────────────────────────

function printHashes(): void {
  console.log('CircleUp — artifact hash report (Issue #396)\n');
  console.log(`  Active toolchain: ${activeToolchain()}`);
  console.log(`  Pinned toolchain: ${readPinnedToolchain()}`);
  console.log(`  WASM directory  : ${WASM_DIR}\n`);

  try {
    const hashes = computeHashes();
    for (const [name, hash] of Object.entries(hashes)) {
      console.log(`  ${hash}  ${name}`);
    }
  } catch (err) {
    console.error(`  Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ── Verify mode ───────────────────────────────────────────────────────────────

function verifyHashes(): void {
  console.log('CircleUp — contract build reproducibility check (Issue #396)\n');

  // 1. Check that expected-hashes.json exists
  if (!fs.existsSync(HASHES_FILE)) {
    console.error(
      '  ✗ contracts/expected-hashes.json not found.\n' +
      '    Run: npx ts-node src/check-artifact-hashes.ts --update',
    );
    process.exit(1);
  }

  const expected: ExpectedHashes = JSON.parse(fs.readFileSync(HASHES_FILE, 'utf8'));

  // 2. Check toolchain alignment
  const pinned = readPinnedToolchain();
  const active = activeToolchain();

  console.log(`  Pinned toolchain : ${pinned}`);
  console.log(`  Active toolchain : ${active}`);

  const toolchainOk = active.includes(pinned);
  console.log(`  Toolchain match  : ${toolchainOk ? '✅' : '⚠  (mismatch — artifacts may differ)'}`);

  // 3. Verify that all expected artifacts are populated (no empty strings)
  const unpopulated = Object.entries(expected.artifacts)
    .filter(([, h]) => !h)
    .map(([n]) => n);

  if (unpopulated.length > 0) {
    console.warn(
      `\n  ⚠  The following artifacts have no expected hash in expected-hashes.json:\n` +
      `     ${unpopulated.join(', ')}\n` +
      `     Run --update after a clean build to populate them.`,
    );
    // Not a hard failure — expected when first bootstrapping the repo
  }

  // 4. Compare file hashes
  let allMatch = true;
  const populated = (Object.entries(expected.artifacts) as [WasmName, string][])
    .filter(([, h]) => !!h);

  if (populated.length === 0) {
    console.log('\n  ℹ  No populated hashes to compare — nothing to verify.');
    console.log('     Run: npx ts-node src/check-artifact-hashes.ts --update');
    process.exit(0);
  }

  console.log('\n  Artifact verification:\n');

  for (const [name, expectedHash] of populated) {
    const p = path.join(WASM_DIR, name);

    if (!fs.existsSync(p)) {
      console.log(`  ✗ ${name}: artifact missing — build first`);
      allMatch = false;
      continue;
    }

    const actual = sha256File(p);
    const match  = actual === expectedHash;

    if (match) {
      console.log(`  ✅ ${name}`);
      console.log(`     ${actual}`);
    } else {
      console.log(`  ✗  ${name}: HASH MISMATCH`);
      console.log(`     expected : ${expectedHash}`);
      console.log(`     actual   : ${actual}`);
      allMatch = false;
    }
  }

  console.log('');

  if (!allMatch) {
    console.error(
      '  One or more artifacts do not match expected hashes.\n' +
      '  Possible causes:\n' +
      '    • Toolchain version differs from contracts/rust-toolchain.toml\n' +
      '    • Contract source was modified without updating expected-hashes.json\n' +
      '    • Build environment differs (OS, linker, optimization flags)\n\n' +
      '  To update expected hashes after an intentional change:\n' +
      '    npx ts-node src/check-artifact-hashes.ts --update',
    );
    process.exit(1);
  }

  console.log('  All artifact hashes match. Build is reproducible. ✅');
  process.exit(0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--update')) {
  updateHashes();
} else if (args.includes('--print')) {
  printHashes();
} else {
  verifyHashes();
}
