#!/usr/bin/env ts-node
/**
 * check-env-parity.ts — Environment variable documentation parity check (Issue #93)
 *
 * Verifies that every process.env.VARNAME read by app, indexer, and scripts is
 * documented in the corresponding .env.example file, and that no .env.example
 * entry is stale (present but never read by code).
 *
 * Design principles:
 *  - Reports variable NAMES only — never values, never live env contents.
 *  - Required variables must appear in both code and .env.example.
 *  - Allowlisted variables (optional or externally injected) are excluded from
 *    the undocumented and stale checks.
 *  - Safe to run on any contributor machine or in CI.
 *
 * Usage:
 *   npx ts-node src/check-env-parity.ts [--component app|indexer|scripts|all]
 *
 * Exit codes:
 *   0 — Parity is clean; all reads documented, no stale entries found.
 *   1 — Parity violations detected; output lists names only (never values).
 */

import fs from 'fs';
import path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Variables that are set by the runtime, OS, or CI and are intentionally not
 * documented in any .env.example file (they are externally injected, not
 * user-configured).  Never reported as undocumented reads.
 */
const GLOBAL_ALLOWLIST = new Set([
  'NODE_ENV', // set by Node.js / Next.js build system
  'CI',       // set by GitHub Actions / CI runners
]);

/**
 * Per-component allowlists for variables that appear in .env.example as
 * documentation for values produced or consumed by external tooling — not
 * read directly via process.env in TypeScript source.
 *
 * Add entries here with a comment explaining WHY they are exempt so the
 * reason stays reviewable in code.
 */
const COMPONENT_EXAMPLE_ALLOWLISTS: Record<string, Set<string>> = {
  scripts: new Set([
    // deploy.ts outputs these to stdout for operators to copy, it does not
    // read them from process.env.  They appear in .env.example as deployment
    // documentation rather than as configurable inputs.
    'CIRCLE_FACTORY_ADDRESS',
    'REPUTATION_ADDRESS',
  ]),
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParityResult {
  component: string;
  /** Variables read in code but missing from .env.example (and not allowlisted). */
  undocumented: string[];
  /** Variables in .env.example but never read by code (and not allowlisted). */
  stale: string[];
}

export interface ParityReport {
  results: ParityResult[];
  /** true when every component has zero undocumented reads and zero stale entries. */
  clean: boolean;
}

// ── Source scanning ───────────────────────────────────────────────────────────

/**
 * Walk a source tree and return every variable name referenced via
 * process.env.VARNAME or process.env["VARNAME"].
 *
 * Only static patterns are matched; dynamic accesses (process.env[key])
 * cannot be enumerated statically and are intentionally skipped.
 * node_modules, dist, and .next are excluded from the walk.
 */
export function scanEnvReads(sourceDir: string): Set<string> {
  const found = new Set<string>();
  if (!fs.existsSync(sourceDir)) return found;

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.next'].includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');

        // process.env.VAR_NAME
        const dotRe = /process\.env\.([A-Z][A-Z0-9_]*)/g;
        let m: RegExpExecArray | null;
        while ((m = dotRe.exec(content)) !== null) {
          found.add(m[1]);
        }

        // process.env["VAR_NAME"] or process.env['VAR_NAME']
        const bracketRe = /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;
        while ((m = bracketRe.exec(content)) !== null) {
          found.add(m[1]);
        }
      }
    }
  }

  walk(sourceDir);
  return found;
}

/**
 * Parse a .env.example file and return the Set of documented variable names.
 * Comment lines (starting with #) and blank lines are ignored.
 * Values are never read or returned — only the KEY names.
 */
export function parseEnvExample(filePath: string): Set<string> {
  const found = new Set<string>();
  if (!fs.existsSync(filePath)) return found;

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
      found.add(key);
    }
  }
  return found;
}

/**
 * Compare the set of variables read in code against those documented in
 * .env.example, respecting the provided allowlist.
 *
 * Returns:
 *   undocumented — variables in `reads` absent from `examples` and not allowlisted
 *   stale        — variables in `examples` absent from `reads` and not allowlisted
 */
export function compareEnvParity(
  reads: Set<string>,
  examples: Set<string>,
  allowlist: Set<string>,
): { undocumented: string[]; stale: string[] } {
  const undocumented: string[] = [];
  for (const name of reads) {
    if (!examples.has(name) && !allowlist.has(name)) {
      undocumented.push(name);
    }
  }

  const stale: string[] = [];
  for (const name of examples) {
    if (!reads.has(name) && !allowlist.has(name)) {
      stale.push(name);
    }
  }

  return {
    undocumented: undocumented.sort(),
    stale: stale.sort(),
  };
}

// ── Per-component check ───────────────────────────────────────────────────────

export function checkComponentParity(
  component: 'app' | 'indexer' | 'scripts',
): ParityResult {
  const componentDir = path.join(ROOT, component);
  const srcDir = path.join(componentDir, 'src');
  const exampleFile = path.join(componentDir, '.env.example');

  const reads = scanEnvReads(srcDir);
  const examples = parseEnvExample(exampleFile);

  const allowlist = new Set([
    ...GLOBAL_ALLOWLIST,
    ...(COMPONENT_EXAMPLE_ALLOWLISTS[component] ?? new Set<string>()),
  ]);

  const { undocumented, stale } = compareEnvParity(reads, examples, allowlist);
  return { component, undocumented, stale };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runParityCheck(
  components: Array<'app' | 'indexer' | 'scripts'>,
): ParityReport {
  const results: ParityResult[] = components.map(checkComponentParity);
  const clean = results.every(r => r.undocumented.length === 0 && r.stale.length === 0);
  return { results, clean };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--component');
  const componentArg = idx !== -1 ? args[idx + 1] : 'all';
  const valid = ['app', 'indexer', 'scripts', 'all'];

  if (!valid.includes(componentArg ?? '')) {
    console.error(`Error: --component must be one of: ${valid.join(', ')}`);
    process.exit(1);
  }

  const components: Array<'app' | 'indexer' | 'scripts'> =
    componentArg === 'all'
      ? ['app', 'indexer', 'scripts']
      : [componentArg as 'app' | 'indexer' | 'scripts'];

  console.log('CircleUp environment variable parity check\n');

  const report = runParityCheck(components);

  for (const r of report.results) {
    console.log(`── ${r.component} ──`);
    if (r.undocumented.length === 0 && r.stale.length === 0) {
      console.log('  ✓ Clean — all reads documented, no stale entries');
    }
    if (r.undocumented.length > 0) {
      console.log(`  ✗ Undocumented reads (add to .env.example): ${r.undocumented.join(', ')}`);
    }
    if (r.stale.length > 0) {
      console.log(`  ✗ Stale .env.example entries (not read in code): ${r.stale.join(', ')}`);
    }
    console.log('');
  }

  if (report.clean) {
    console.log('All components have clean environment variable parity.');
    process.exit(0);
  } else {
    console.log('Parity violations found. Update .env.example or extend the allowlist with justification.');
    process.exit(1);
  }
}
