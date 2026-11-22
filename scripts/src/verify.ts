#!/usr/bin/env ts-node
/**
 * Unified repository verification runner (Issue #974 / #138).
 *
 * Runs the existing package commands in a deterministic order for two tiers:
 *   - `fast`: offline checks with no external services (builds, typechecks, unit tests, format).
 *   - `full`: the fast tier plus integration/release checks (contracts, Postgres-backed
 *     indexer tests, app build + visual tests, SDK API check, artifact/release checks).
 *
 * The runner never masks failures: each child command is executed directly (no shell
 * pipelines, no `&&`/`&` chaining), child exit codes are preserved, and any check that
 * cannot run is reported explicitly as SKIP together with its prerequisite.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Tier = 'fast' | 'full';

export interface Prerequisite {
  description: string;
  isAvailable: () => boolean;
}

export interface VerifyCheck {
  id: string;
  label: string;
  tier: Tier;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  prerequisite?: Prerequisite;
}

export type CheckStatus = 'pass' | 'fail' | 'skip' | 'not-run';

export interface CheckOutcome {
  id: string;
  label: string;
  status: CheckStatus;
  exitCode?: number;
  durationMs: number;
  skipReason?: string;
}

export interface RunOptions {
  exec?: (command: string, args: string[], options: { cwd?: string; env?: Record<string, string> }) => number;
  log?: (message: string) => void;
}

export interface RunResult {
  outcomes: CheckOutcome[];
  exitCode: number;
}

const repoRoot = join(__dirname, '..', '..');

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasPlaywrightBrowsers(): boolean {
  if (process.env.VERIFY_VISUAL === '1') {
    return true;
  }
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  return existsSync(cacheDir);
}

const rustToolchain: Prerequisite = {
  description: 'Rust toolchain (cargo on PATH; see rust-toolchain.toml)',
  isAvailable: () => hasCommand('cargo'),
};

const databaseUrl: Prerequisite = {
  description: 'DATABASE_URL pointing at a running Postgres instance',
  isAvailable: () => Boolean(process.env.DATABASE_URL),
};

const playwrightBrowsers: Prerequisite = {
  description: 'Playwright browsers installed (`npx playwright install`) or VERIFY_VISUAL=1',
  isAvailable: hasPlaywrightBrowsers,
};

const network: Prerequisite = {
  description: 'network access (npm registry)',
  isAvailable: () => process.env.VERIFY_OFFLINE !== '1',
};

const fastChecks: VerifyCheck[] = [
  { id: 'sdk:build', label: 'SDK build', tier: 'fast', command: 'npm', args: ['run', 'build', '--workspace=sdk'] },
  { id: 'sdk:test', label: 'SDK tests', tier: 'fast', command: 'npm', args: ['test', '--workspace=sdk'] },
  { id: 'indexer:typecheck', label: 'Indexer typecheck', tier: 'fast', command: 'npm', args: ['run', 'typecheck', '--workspace=indexer'] },
  { id: 'indexer:test', label: 'Indexer unit tests', tier: 'fast', command: 'npm', args: ['test', '--workspace=indexer'] },
  { id: 'app:typecheck', label: 'App typecheck', tier: 'fast', command: 'npm', args: ['run', 'typecheck', '--workspace=app'] },
  { id: 'app:test', label: 'App unit tests', tier: 'fast', command: 'npm', args: ['test', '--workspace=app'] },
  { id: 'scripts:typecheck', label: 'Scripts typecheck', tier: 'fast', command: 'npm', args: ['run', 'typecheck', '--workspace=scripts'] },
  { id: 'scripts:test', label: 'Scripts tests', tier: 'fast', command: 'npm', args: ['test', '--workspace=scripts'] },
  { id: 'format:check', label: 'Repository format check', tier: 'fast', command: 'npm', args: ['run', 'format:check'] },
];

const fullOnlyChecks: VerifyCheck[] = [
  {
    id: 'contracts:test',
    label: 'Contracts cargo tests',
    tier: 'full',
    command: 'cargo',
    args: ['test', '--workspace'],
    cwd: join(repoRoot, 'contracts'),
    prerequisite: rustToolchain,
  },
  { id: 'indexer:build', label: 'Indexer build', tier: 'full', command: 'npm', args: ['run', 'build', '--workspace=indexer'] },
  {
    id: 'indexer:test:integration',
    label: 'Indexer integration tests (Postgres)',
    tier: 'full',
    command: 'npm',
    args: ['test', '--workspace=indexer'],
    prerequisite: databaseUrl,
  },
  { id: 'app:build', label: 'App build', tier: 'full', command: 'npm', args: ['run', 'build', '--workspace=app'] },
  {
    id: 'app:test:visual',
    label: 'App visual tests (Playwright)',
    tier: 'full',
    command: 'npm',
    args: ['run', 'test:visual', '--workspace=app'],
    prerequisite: playwrightBrowsers,
  },
  { id: 'sdk:check:api', label: 'SDK public API check', tier: 'full', command: 'npm', args: ['run', 'check:api', '--workspace=sdk'] },
  { id: 'verify-artifacts', label: 'Verify build artifacts', tier: 'full', command: 'npm', args: ['run', 'verify-artifacts'] },
  { id: 'release-check', label: 'Release readiness check', tier: 'full', command: 'npm', args: ['run', 'release-check'] },
  { id: 'check:toolchain', label: 'Toolchain check', tier: 'full', command: 'npm', args: ['run', 'check:toolchain'], prerequisite: network },
];

export const CHECKS: VerifyCheck[] = [...fastChecks, ...fullOnlyChecks];

export function checksForTier(tier: Tier): VerifyCheck[] {
  return tier === 'fast' ? fastChecks : CHECKS;
}

export function parseTier(argv: string[]): Tier {
  const flag = argv.find((arg) => arg.startsWith('--tier='));
  if (!flag) {
    return 'fast';
  }
  const value = flag.slice('--tier='.length);
  if (value === 'fast' || value === 'full') {
    return value;
  }
  throw new Error(`Unknown verification tier "${value}". Expected "fast" or "full".`);
}

function defaultExec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> },
): number {
  try {
    execFileSync(command, args, {
      stdio: 'inherit',
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    return typeof status === 'number' ? status : 1;
  }
}

export function runVerification(tier: Tier, options: RunOptions = {}): RunResult {
  const exec = options.exec ?? defaultExec;
  const log = options.log ?? ((message: string) => console.log(message));
  const checks = checksForTier(tier);
  const outcomes: CheckOutcome[] = [];
  let failed = false;

  log(`CircleUp verification (tier: ${tier})`);
  log(`Running ${checks.length} check(s) in deterministic order.`);

  for (const check of checks) {
    if (failed) {
      outcomes.push({ id: check.id, label: check.label, status: 'not-run', durationMs: 0 });
      continue;
    }

    if (check.prerequisite && !check.prerequisite.isAvailable()) {
      const skipReason = `prerequisite not met: ${check.prerequisite.description}`;
      log(`[SKIP] ${check.label} — ${skipReason}`);
      outcomes.push({ id: check.id, label: check.label, status: 'skip', durationMs: 0, skipReason });
      continue;
    }

    log(`[RUN ] ${check.label} (${check.command} ${check.args.join(' ')})`);
    const startedAt = Date.now();
    const exitCode = exec(check.command, check.args, { cwd: check.cwd, env: check.env });
    const durationMs = Date.now() - startedAt;

    if (exitCode === 0) {
      log(`[PASS] ${check.label} (${durationMs}ms)`);
      outcomes.push({ id: check.id, label: check.label, status: 'pass', exitCode, durationMs });
    } else {
      log(`[FAIL] ${check.label} (exit ${exitCode}, ${durationMs}ms)`);
      outcomes.push({ id: check.id, label: check.label, status: 'fail', exitCode, durationMs });
      failed = true;
    }
  }

  const passed = outcomes.filter((o) => o.status === 'pass');
  const failedChecks = outcomes.filter((o) => o.status === 'fail');
  const skipped = outcomes.filter((o) => o.status === 'skip');
  const notRun = outcomes.filter((o) => o.status === 'not-run');

  log('');
  log('Verification summary');
  log(`  completed: ${passed.length}`);
  for (const outcome of passed) {
    log(`    [PASS] ${outcome.label}`);
  }
  log(`  failed: ${failedChecks.length}`);
  for (const outcome of failedChecks) {
    log(`    [FAIL] ${outcome.label} (exit ${outcome.exitCode})`);
  }
  log(`  skipped: ${skipped.length}`);
  for (const outcome of skipped) {
    log(`    [SKIP] ${outcome.label} — ${outcome.skipReason}`);
  }
  if (notRun.length > 0) {
    log(`  not run (stopped after failure): ${notRun.length}`);
    for (const outcome of notRun) {
      log(`    [NOT RUN] ${outcome.label}`);
    }
  }

  return { outcomes, exitCode: failedChecks.length > 0 ? 1 : 0 };
}

function main(): void {
  let tier: Tier;
  try {
    tier = parseTier(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  const { exitCode } = runVerification(tier);
  process.exit(exitCode);
}

if (require.main === module) {
  main();
}
