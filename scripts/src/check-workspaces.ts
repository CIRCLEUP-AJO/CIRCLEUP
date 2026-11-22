import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[] | { packages?: string[]; nohoist?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface LockfilePackage {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface Lockfile {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  requires?: boolean;
  packages?: Record<string, LockfilePackage>;
}

const ROOT = resolve(__dirname, '..', '..');
const ROOT_PACKAGE_JSON = join(ROOT, 'package.json');
const ROOT_LOCKFILE = join(ROOT, 'package-lock.json');

const errors: string[] = [];
const warnings: string[] = [];

function fail(message: string): void {
  errors.push(message);
}

function warn(message: string): void {
  warnings.push(message);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function normalizeWorkspacePatterns(pkg: PackageJson): string[] {
  const ws = pkg.workspaces;
  if (!ws) return [];
  if (Array.isArray(ws)) return ws;
  return ws.packages ?? [];
}

function expandWorkspacePatterns(patterns: string[]): string[] {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const base = pattern.split('*')[0].replace(/\/$/, '');
      const baseDir = join(ROOT, base);
      if (!existsSync(baseDir)) continue;
      for (const entry of readdirSync(baseDir)) {
        const full = join(baseDir, entry);
        if (statSync(full).isDirectory() && existsSync(join(full, 'package.json'))) {
          dirs.add(full);
        }
      }
    } else {
      const full = join(ROOT, pattern);
      if (existsSync(join(full, 'package.json'))) {
        dirs.add(full);
      } else {
        fail(`Workspace pattern "${pattern}" does not resolve to a package with a package.json.`);
      }
    }
  }
  return [...dirs].sort();
}

function findNestedLockfiles(): string[] {
  const found: string[] = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache']);

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipDirs.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (
        entry === 'package-lock.json' ||
        entry === 'npm-shrinkwrap.json' ||
        entry === 'yarn.lock' ||
        entry === 'pnpm-lock.yaml'
      ) {
        if (resolve(full) !== resolve(ROOT_LOCKFILE)) {
          found.push(relative(ROOT, full));
        }
      }
    }
  }

  walk(ROOT);
  return found;
}

function compareDependencyMaps(
  label: string,
  manifestDeps: Record<string, string> | undefined,
  lockDeps: Record<string, string> | undefined,
): void {
  const m = manifestDeps ?? {};
  const l = lockDeps ?? {};
  const allKeys = new Set([...Object.keys(m), ...Object.keys(l)]);
  for (const key of allKeys) {
    if (!(key in l)) {
      fail(`${label}: dependency "${key}" is declared in package.json but missing from package-lock.json. Run "npm install" from the repository root to update the lockfile.`);
    } else if (!(key in m)) {
      fail(`${label}: dependency "${key}" is present in package-lock.json but not in package.json. Run "npm install" from the repository root to update the lockfile.`);
    } else if (m[key] !== l[key]) {
      fail(`${label}: dependency "${key}" version mismatch (package.json: "${m[key]}", package-lock.json: "${l[key]}"). Run "npm install" from the repository root to update the lockfile.`);
    }
  }
}

function main(): void {
  if (!existsSync(ROOT_PACKAGE_JSON)) {
    fail(`Root package.json not found at ${ROOT_PACKAGE_JSON}.`);
    report();
    return;
  }
  if (!existsSync(ROOT_LOCKFILE)) {
    fail(`Root package-lock.json not found at ${ROOT_LOCKFILE}. Run "npm install" from the repository root to generate it.`);
    report();
    return;
  }

  const rootPkg = readJson<PackageJson>(ROOT_PACKAGE_JSON);
  const lockfile = readJson<Lockfile>(ROOT_LOCKFILE);

  if (!lockfile.packages) {
    fail('package-lock.json is missing the "packages" section (lockfileVersion 2+ required). Regenerate with a recent npm from the repository root.');
    report();
    return;
  }

  const lockPackages = lockfile.packages;

  // Root package entry
  const rootLockEntry = lockPackages[''];
  if (!rootLockEntry) {
    fail('package-lock.json is missing the root package entry (""). Regenerate with "npm install" from the repository root.');
  } else {
    compareDependencyMaps('root package.json', rootPkg.dependencies, rootLockEntry.dependencies);
    compareDependencyMaps('root package.json (dev)', rootPkg.devDependencies, rootLockEntry.devDependencies);
    compareDependencyMaps('root package.json (optional)', rootPkg.optionalDependencies, rootLockEntry.optionalDependencies);
    compareDependencyMaps('root package.json (peer)', rootPkg.peerDependencies, rootLockEntry.peerDependencies);
  }

  // Workspaces
  const patterns = normalizeWorkspacePatterns(rootPkg);
  if (patterns.length === 0) {
    warn('No workspaces declared in root package.json; nothing to cross-check.');
  }
  const workspaceDirs = expandWorkspacePatterns(patterns);

  for (const dir of workspaceDirs) {
    const rel = relative(ROOT, dir).split('\\').join('/');
    const pkgPath = join(dir, 'package.json');
    const pkg = readJson<PackageJson>(pkgPath);
    const label = `workspace "${rel}"`;

    if (!pkg.name) {
      fail(`${label}: package.json is missing a "name" field.`);
      continue;
    }

    const lockKey = rel;
    const lockEntry = lockPackages[lockKey];
    if (!lockEntry) {
      fail(`${label}: not present in package-lock.json. Run "npm install" from the repository root to update the lockfile.`);
      continue;
    }

    if (!lockEntry.link) {
      warn(`${label}: lockfile entry is not marked as a workspace link; this may indicate a stale lockfile.`);
    }

    if (lockEntry.name && lockEntry.name !== pkg.name) {
      fail(`${label}: name mismatch (package.json: "${pkg.name}", package-lock.json: "${lockEntry.name}"). Run "npm install" from the repository root to update the lockfile.`);
    }
    if (lockEntry.version && pkg.version && lockEntry.version !== pkg.version) {
      fail(`${label}: version mismatch (package.json: "${pkg.version}", package-lock.json: "${lockEntry.version}"). Run "npm install" from the repository root to update the lockfile.`);
    }

    compareDependencyMaps(`${label} dependencies`, pkg.dependencies, lockEntry.dependencies);
    compareDependencyMaps(`${label} devDependencies`, pkg.devDependencies, lockEntry.devDependencies);
    compareDependencyMaps(`${label} optionalDependencies`, pkg.optionalDependencies, lockEntry.optionalDependencies);
    compareDependencyMaps(`${label} peerDependencies`, pkg.peerDependencies, lockEntry.peerDependencies);
  }

  // Detect workspace entries in the lockfile that no longer exist on disk
  const knownWorkspaceKeys = new Set(workspaceDirs.map((d) => relative(ROOT, d).split('\\').join('/')));
  for (const key of Object.keys(lockPackages)) {
    if (!key) continue;
    const entry = lockPackages[key];
    if (entry.link && !knownWorkspaceKeys.has(key)) {
      fail(`package-lock.json references workspace "${key}" which is not declared in root package.json workspaces. Run "npm install" from the repository root to update the lockfile.`);
    }
  }

  // Nested lockfiles
  const nested = findNestedLockfiles();
  for (const file of nested) {
    fail(`Unexpected nested lockfile detected: ${file}. Only the root package-lock.json is supported; remove nested lockfiles and install from the repository root.`);
  }

  // Verify lockfile is in sync via npm's own check (best-effort)
  try {
    execFileSync('npm', ['ls', '--package-lock-only', '--all', '--json'], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    });
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = e.stdout ? e.stdout.toString() : '';
    const stderr = e.stderr ? e.stderr.toString() : '';
    let detail = '';
    try {
      const parsed = JSON.parse(stdout) as { problems?: string[] };
      if (parsed.problems && parsed.problems.length > 0) {
        detail = parsed.problems.join('\n  ');
      }
    } catch {
      // ignore parse errors
    }
    if (detail) {
      fail(`npm reports dependency tree problems:\n  ${detail}\nRun "npm install" from the repository root to reconcile the lockfile.`);
    } else {
      warn(`npm ls reported an issue while validating the lockfile: ${stderr.trim() || stdout.trim() || 'unknown error'}`);
    }
  }

  report();
}

function report(): void {
  for (const w of warnings) {
    console.warn(`warning: ${w}`);
  }
  if (errors.length > 0) {
    console.error('');
    console.error('Workspace / lockfile consistency check failed:');
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    console.error('');
    console.error('To fix: run "npm install" from the repository root, commit the updated package-lock.json, and ensure no nested lockfiles are committed.');
    process.exit(1);
  }
  console.log('Workspace / lockfile consistency check passed.');
}

main();