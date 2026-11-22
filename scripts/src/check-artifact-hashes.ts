#!/usr/bin/env ts-node
/**
 * check-artifact-hashes.ts — Contract build reproducibility and provenance check (Issues #396, #705)
 *
 * Verifies that the compiled WASM artifacts match the expected SHA-256
 * hashes committed in contracts/expected-hashes.json. Also records and verifies
 * build provenance metadata (git revision, compiler version, toolchain, and artifact sizes)
 * to guard against supply-chain and toolchain drift.
 *
 * Usage:
 *   # Verify existing artifacts against expected hashes
 *   npx ts-node src/check-artifact-hashes.ts
 *
 *   # Rebuild contracts and update expected-hashes.json
 *   npx ts-node src/check-artifact-hashes.ts --update
 *
 *   # Generate provenance metadata file (contracts/provenance.json)
 *   npx ts-node src/check-artifact-hashes.ts --provenance
 *
 *   # Print hashes and provenance info without comparing
 *   npx ts-node src/check-artifact-hashes.ts --print
 *
 * Exit codes:
 *   0 — All hashes match (verify mode) or hashes/provenance written.
 *   1 — One or more hashes differ, artifacts are missing, or drift detected.
 *
 * This script never deploys contracts or submits transactions.
 * It is safe to run on any contributor machine.
 */

import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Directory Resolution (Compatible with both ESM and CJS) ───────────────────

function resolveScriptDir(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

const SCRIPT_DIR    = resolveScriptDir();
const ROOT          = path.resolve(SCRIPT_DIR, '..', '..');
const CONTRACTS     = path.join(ROOT, 'contracts');
const WASM_DIR      = path.join(CONTRACTS, 'target', 'wasm32-unknown-unknown', 'release');
const HASHES_FILE   = path.join(CONTRACTS, 'expected-hashes.json');
const PROVENANCE_FILE = path.join(CONTRACTS, 'provenance.json');
const TOOLCHAIN_FILE = path.join(CONTRACTS, 'rust-toolchain.toml');
const CARGO_TOML    = path.join(CONTRACTS, 'Cargo.toml');

/** Build flags used for every reproducible WASM artifact build. */
export const BUILD_TARGET = 'wasm32-unknown-unknown';
export const BUILD_PROFILE = 'release';
export const BUILD_FLAGS = [
  '--release',
  '--target wasm32-unknown-unknown',
  '--locked',
] as const;

export const WASM_NAMES = ['reputation.wasm', 'circle_factory.wasm', 'circle.wasm'] as const;
export type WasmName = typeof WASM_NAMES[number];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExpectedHashes {
  _comment?: string;
  _comment2?: string;
  _comment3?: string;
  toolchain: string;
  target: string;
  profile: string;
  /** Exact compiler version the hashes were generated with (e.g. "rustc 1.81.0 ..."). */
  rustc?: string;
  /** Soroban SDK version resolved from contracts/Cargo.toml. */
  sdk?: string;
  /** Build flags used to produce the artifacts. */
  buildFlags?: string[];
  artifacts: Record<WasmName, string>;
}

export interface ArtifactProvenance {
  sha256: string;
  sizeBytes: number;
}

export interface ProvenanceMetadata {
  schemaVersion: string;
  timestamp: string;
  git: {
    commit: string;
    branch: string;
    isDirty: boolean;
    tag?: string;
  };
  toolchain: {
    pinned: string;
    active: string;
    rustc: string;
    cargo: string;
    target: string;
    profile: string;
    sdk: string;
    buildFlags: string[];
  };
  artifacts: Record<WasmName, ArtifactProvenance>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute SHA-256 of a file, returned as a lowercase hex string. */
export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Get file size in bytes. */
export function getFileSize(filePath: string): number {
  const stat = fs.statSync(filePath);
  return stat.size;
}

/** Read rust-toolchain.toml and extract the channel (e.g. "1.81.0"). */
export function readPinnedToolchain(): string {
  if (!fs.existsSync(TOOLCHAIN_FILE)) {
    return 'unknown (rust-toolchain.toml not found)';
  }
  const content = fs.readFileSync(TOOLCHAIN_FILE, 'utf8');
  const match = content.match(/channel\s*=\s*"([^"]+)"/);
  return match ? match[1] : 'unknown (channel not found)';
}

/** Read the Soroban SDK version declared in contracts/Cargo.toml. */
export function readSdkVersion(): string {
  if (!fs.existsSync(CARGO_TOML)) {
    return 'unknown (contracts/Cargo.toml not found)';
  }
  const content = fs.readFileSync(CARGO_TOML, 'utf8');
  // Match `soroban-sdk = "..."`, `soroban-sdk = { version = "..." }`, etc.
  const match = content.match(/soroban-sdk\s*=\s*(?:\{[^}]*version\s*=\s*"([^"]+)"|"([^"]+)")/);
  if (!match) {
    return 'unknown (soroban-sdk not found)';
  }
  return match[1] ?? match[2] ?? 'unknown';
}

/** Run a shell command safely, returning trimmed stdout or fallback on error. */
function safeExec(cmd: string, fallback: string = 'unknown'): string {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return fallback;
  }
}

/** Resolve the active toolchain via `rustup show active-toolchain`. */
export function activeToolchain(): string {
  const out = safeExec('rustup show active-toolchain', 'unknown');
  return out.split(' ')[0] ?? 'unknown';
}

/** Resolve the installed rustc version string. */
export function rustcVersion(): string {
  return safeExec('rustc --version', 'unknown');
}

/** Resolve the installed cargo version string. */
export function cargoVersion(): string {
  return safeExec('cargo --version', 'unknown');
}

/** Get Git repository revision details. */
export function getGitProvenance(): { commit: string; branch: string; isDirty: boolean; tag?: string } {
  const commit = safeExec('git rev-parse HEAD', 'unknown');
  const branch = safeExec('git rev-parse --abbrev-ref HEAD', 'unknown');
  const status = safeExec('git status --porcelain', '');
  const isDirty = status.length > 0;
  const tagOutput = safeExec('git describe --tags --exact-match 2>/dev/null', '');
  const tag = tagOutput.length > 0 ? tagOutput : undefined;

  return { commit, branch, isDirty, ...(tag ? { tag } : {}) };
}

/** Run a shell command and return its trimmed stdout. */
function run(cmd: string, label: string): string {
  console.log(`\n  [build] ${label}...`);
  console.log(`    > ${cmd}`);
  const out = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return out.trim();
}

// ── Build ─────────────────────────────────────────────────────────────────────

export function buildContracts(): void {
  run(
    `cargo build ${BUILD_FLAGS.join(' ')} --manifest-path ${CONTRACTS}/Cargo.toml`,
    'Building all contracts',
  );
}

// ── Compute hashes & Provenance ───────────────────────────────────────────────

export function computeHashes(): Record<WasmName, string> {
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

export function generateProvenance(): ProvenanceMetadata {
  const hashes = computeHashes();
  const artifacts = {} as Record<WasmName, ArtifactProvenance>;

  for (const name of WASM_NAMES) {
    const p = path.join(WASM_DIR, name);
    artifacts[name] = {
      sha256: hashes[name],
      sizeBytes: getFileSize(p),
    };
  }

  return {
    schemaVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    git: getGitProvenance(),
    toolchain: {
      pinned: readPinnedToolchain(),
      active: activeToolchain(),
      rustc: rustcVersion(),
      cargo: cargoVersion(),
      target: BUILD_TARGET,
      profile: BUILD_PROFILE,
      sdk: readSdkVersion(),
      buildFlags: [...BUILD_FLAGS],
    },
    artifacts,
  };
}

// ── Update mode ───────────────────────────────────────────────────────────────

export function updateHashes(): void {
  console.log('CircleUp — updating expected artifact hashes and provenance (Issues #396, #705)\n');

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
    target:    BUILD_TARGET,
    profile:   BUILD_PROFILE,
    rustc:     rustcVersion(),
    sdk:       readSdkVersion(),
    buildFlags: [...BUILD_FLAGS],
    artifacts: hashes,
  };

  fs.writeFileSync(HASHES_FILE, JSON.stringify(out, null, 2) + '\n');

  console.log('\n  ✅ expected-hashes.json updated:');
  for (const [name, hash] of Object.entries(hashes)) {
    console.log(`     ${name}: ${hash}`);
  }

  // Also write provenance record
  const provenance = generateProvenance();
  fs.writeFileSync(PROVENANCE_FILE, JSON.stringify(provenance, null, 2) + '\n');
  console.log(`  ✅ contracts/provenance.json written (commit: ${provenance.git.commit.substring(0, 8)})`);
  console.log(`\n  Commit contracts/expected-hashes.json and contracts/rust-toolchain.toml.`);
}

// ── Provenance mode ───────────────────────────────────────────────────────────

export function writeProvenance(outputPath?: string): void {
  console.log('CircleUp — recording contract artifact provenance (Issue #705)\n');

  const targetPath = outputPath ?? PROVENANCE_FILE;
  const provenance = generateProvenance();

  fs.writeFileSync(targetPath, JSON.stringify(provenance, null, 2) + '\n');

  console.log(`  WASM directory   : ${WASM_DIR}`);
  console.log(`  Target output    : ${targetPath}`);
  console.log(`  Git commit       : ${provenance.git.commit} (${provenance.git.branch}${provenance.git.isDirty ? ' [dirty]' : ''})`);
  console.log(`  Rust toolchain   : ${provenance.toolchain.pinned} (active: ${provenance.toolchain.active})`);
  console.log(`  Compiler version : ${provenance.toolchain.rustc}`);
  console.log(`  Cargo version    : ${provenance.toolchain.cargo}`);
  console.log(`  Soroban SDK      : ${provenance.toolchain.sdk}`);
  console.log(`  Target / profile : ${provenance.toolchain.target} / ${provenance.toolchain.profile}`);
  console.log(`  Build flags      : ${provenance.toolchain.buildFlags.join(' ')}`);
  console.log('\n  Artifacts provenance:');
  for (const [name, data] of Object.entries(provenance.artifacts)) {
    console.log(`    ${name.padEnd(22)}: ${data.sha256} (${data.sizeBytes} bytes)`);
  }
  console.log(`\n  ✅ Provenance successfully written to ${targetPath}`);
}

// ── Print mode ────────────────────────────────────────────────────────────────

export function printHashes(): void {
  console.log('CircleUp — artifact hash & provenance report (Issues #396, #705)\n');
  console.log(`  Active toolchain : ${activeToolchain()}`);
  console.log(`  Pinned toolchain : ${readPinnedToolchain()}`);
  console.log(`  Rustc version    : ${rustcVersion()}`);
  console.log(`  Cargo version    : ${cargoVersion()}`);
  console.log(`  Soroban SDK      : ${readSdkVersion()}`);
  console.log(`  Target / profile : ${BUILD_TARGET} / ${BUILD_PROFILE}`);
  console.log(`  Build flags      : ${BUILD_FLAGS.join(' ')}`);
  console.log(`  WASM directory   : ${WASM_DIR}\n`);

  try {
    const provenance = generateProvenance();
    console.log(`  Git Commit       : ${provenance.git.commit}`);
    console.log(`  Git Branch       : ${provenance.git.branch} (dirty: ${provenance.git.isDirty})\n`);
    for (const [name, data] of Object.entries(provenance.artifacts)) {
      console.log(`  ${data.sha256}  ${name} (${data.sizeBytes} bytes)`);
    }
  } catch (err) {
    console.error(`  Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ── Verify mode ───────────────────────────────────────────────────────────────

export function verifyHashes(): void {
  console.log('CircleUp — contract build reproducibility check (Issues #396, #705)\n');

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
  console.log(`  Toolchain match  : ${toolchainOk ? '✅' : '✗  (mismatch — artifacts will differ)'}`);

  // 2b. Fail hard when the active toolchain does not match the pinned toolchain.
  if (!toolchainOk) {
    console.error(
      `\n  ✗ Active toolchain (${active}) does not match pinned toolchain (${pinned}).\n` +
      `     Run: rustup override set ${pinned}\n` +
      '     Refusing to verify hashes with an unpinned toolchain.',
    );
    process.exit(1);
  }

  // 2c. Verify recorded compiler / SDK / target / flags match the current environment.
  const currentRustc = rustcVersion();
  const currentSdk = readSdkVersion();
  const currentFlags = [...BUILD_FLAGS];

  const drift: string[] = [];

  if (expected.rustc && expected.rustc !== currentRustc) {
    drift.push(`rustc: expected "${expected.rustc}" but active is "${currentRustc}"`);
  }
  if (expected.sdk && expected.sdk !== currentSdk) {
    drift.push(`soroban-sdk: expected "${expected.sdk}" but resolved "${currentSdk}"`);
  }
  if (expected.target && expected.target !== BUILD_TARGET) {
    drift.push(`target: expected "${expected.target}" but build uses "${BUILD_TARGET}"`);
  }
  if (expected.profile && expected.profile !== BUILD_PROFILE) {
    drift.push(`profile: expected "${expected.profile}" but build uses "${BUILD_PROFILE}"`);
  }
  if (expected.buildFlags && expected.buildFlags.join(' ') !== currentFlags.join(' ')) {
    drift.push(
      `build flags: expected "${expected.buildFlags.join(' ')}" but build uses "${currentFlags.join(' ')}"`,
    );
  }

  if (drift.length > 0) {
    console.error(
      '\n  ✗ Toolchain / SDK / build-flag drift detected against expected-hashes.json:\n' +
      drift.map((d) => `     • ${d}`).join('\n') + '\n\n' +
      '  A compiler, SDK, target, or build-flag change must be reviewed together with\n' +
      '  the expected artifact hash changes. If the change is intentional, regenerate:\n' +
      '    npx ts-node src/check-artifact-hashes.ts --update\n' +
      '  and commit contracts/expected-hashes.json, contracts/provenance.json, and\n' +
      '  contracts/rust-toolchain.toml in the same reviewed change.',
    );
    process.exit(1);
  }

  // 3. Verify that all expected artifacts are populated (no empty strings)
  const unpopulated = Object.entries(expected.artifacts)
    .filter(([, h]) => !h)
    .map(([n]) => n);

  if (unpopulated.length > 0) {
    console.error(
      `\n  ✗ The following artifacts have no expected hash in expected-hashes.json:\n` +
      `     ${unpopulated.join(', ')}\n` +
      `     CI requires expected hashes to be populated. Run --update to populate them.`,
    );
    process.exit(1);
  }

  // 4. Compare file hashes
  let allMatch = true;
  const populated = (Object.entries(expected.artifacts) as [WasmName, string][])
    .filter(([, h]) => !!h);

  console.log('\n  Artifact verification:\n');

  for (const [name, expectedHash] of populated) {
    const p = path.join(WASM_DIR, name);

    if (!fs.existsSync(p)) {
      console.log(`  ✗ ${name}: artifact missing — build first`);
      allMatch = false;
      continue;
    }

    const actual = sha256File(p);
    const size = getFileSize(p);
    const match  = actual === expectedHash;

    if (match) {
      console.log(`  ✅ ${name} (${size} bytes)`);
      console.log(`     ${actual}`);
    } else {
      console.log(`  ✗  ${name}: HASH MISMATCH`);
      console.log(`     expected : ${expectedHash}`);
      console.log(`     actual   : ${actual} (${size} bytes)`);
      allMatch = false;
    }
  }

  console.log('');

  if (!allMatch) {
    console.error(
      '  One or more artifacts do not match expected hashes.\n' +
      '  Possible causes:\n' +
      '    • Toolchain version differs from contracts/rust-toolchain.toml\n' +
      '    • Soroban SDK version changed in contracts/Cargo.toml\n' +
      '    • Contract source was modified without updating expected-hashes.json\n' +
      '    • Build environment differs (OS, linker, optimization flags)\n\n' +
      '  To update expected hashes after an intentional change:\n' +
      '    npx ts-node src/check-artifact-hashes.ts --update\n' +
      '  and commit the updated hashes, provenance, and toolchain together.',
    );
    process.exit(1);
  }

  console.log('  All artifact hashes match. Build is reproducible and provenance verified. ✅');
  process.exit(0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--update')) {
  updateHashes();
} else if (args.includes('--provenance')) {
  const outIdx = args.indexOf('--output');
  const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : undefined;
  writeProvenance(outFile);
} else if (args.includes('--print')) {
  printHashes();
} else {
  verifyHashes();
}
