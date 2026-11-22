/**
 * Dependency audit policy checker (Issue #977).
 *
 * Classifies dependency audit findings as actionable vs. documented exception,
 * validates that exceptions are time-bounded, and diffs the current license
 * inventory against the committed baseline.
 *
 * This module is read-only: it never writes to lockfiles, package.json, the
 * advisory registry, or any registry. It never auto-accepts findings.
 */
import * as fs from 'fs';
import * as path from 'path';

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

export interface AuditPolicy {
  version: number;
  cadence: { cron: string; description?: string };
  severityThresholds: Record<string, { failAt: Severity; warnAt: Severity }>;
  exceptionOwner: string;
  artifactRetentionDays: number;
  licenseBaseline: string;
  exceptions: {
    advisoryRegistry: string;
    licenseExceptionsDoc?: string;
    maxReviewIntervalDays: number;
  };
  behavior: {
    failOnNewFindings: boolean;
    failOnExpiredExceptions: boolean;
    autoAccept: boolean;
    modifyDependencies: boolean;
  };
}

export interface AdvisoryException {
  package: string;
  advisory: string;
  severity?: string;
  reason?: string;
  owner?: string;
  added?: string;
  reviewBy?: string;
  scope?: string;
}

export interface AdvisoryRegistry {
  schemaVersion?: number;
  reviewIntervalDays?: number;
  advisories?: AdvisoryException[];
  resolved?: unknown[];
}

export interface Finding {
  ecosystem: 'npm' | 'cargo';
  package: string;
  advisory: string;
  severity: string;
}

export interface ExceptionValidation {
  valid: AdvisoryException[];
  expired: AdvisoryException[];
  malformed: Array<{ entry: unknown; problems: string[] }>;
}

export interface LicenseEntry {
  workspace: string;
  package: string;
  version: string;
  license: string;
}

export interface LicenseDiff {
  added: LicenseEntry[];
  removed: LicenseEntry[];
  changed: Array<{ before: LicenseEntry; after: LicenseEntry }>;
}

export interface PolicyEvaluation {
  exitCode: 0 | 1 | 2;
  report: {
    generatedAt: string;
    actionable: Finding[];
    excepted: Array<{ finding: Finding; exception: AdvisoryException }>;
    expiredExceptions: AdvisoryException[];
    malformedExceptions: Array<{ entry: unknown; problems: string[] }>;
    licenseDiff: LicenseDiff | null;
    summary: string;
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[dependency-audit] ${message}`);
}

export function loadPolicy(policyPath: string): AuditPolicy {
  const raw = fs.readFileSync(policyPath, 'utf8');
  return JSON.parse(raw) as AuditPolicy;
}

export function loadAdvisoryRegistry(registryPath: string): AdvisoryRegistry {
  if (!fs.existsSync(registryPath)) {
    return { advisories: [] };
  }
  return JSON.parse(fs.readFileSync(registryPath, 'utf8')) as AdvisoryRegistry;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Validate advisory exceptions. An exception is malformed when required fields
 * are missing or dates are not YYYY-MM-DD. An exception is expired when its
 * reviewBy date is in the past, or when it exceeds the maximum review interval.
 */
export function validateAdvisoryExceptions(
  registry: AdvisoryRegistry,
  now: Date,
  maxReviewIntervalDays = 90,
): ExceptionValidation {
  const valid: AdvisoryException[] = [];
  const expired: AdvisoryException[] = [];
  const malformed: Array<{ entry: unknown; problems: string[] }> = [];

  const entries = Array.isArray(registry.advisories) ? registry.advisories : [];

  for (const entry of entries) {
    const problems: string[] = [];
    const candidate = entry as Partial<AdvisoryException>;

    if (!candidate || typeof candidate !== 'object') {
      malformed.push({ entry, problems: ['entry is not an object'] });
      continue;
    }
    if (!candidate.package) problems.push('missing package');
    if (!candidate.advisory) problems.push('missing advisory');
    if (!candidate.owner) problems.push('missing owner');
    if (!candidate.reason) problems.push('missing reason');
    if (!candidate.added || !DATE_RE.test(candidate.added)) {
      problems.push('missing or invalid added date (YYYY-MM-DD)');
    }
    if (!candidate.reviewBy || !DATE_RE.test(candidate.reviewBy)) {
      problems.push('missing or invalid reviewBy date (YYYY-MM-DD)');
    }

    if (problems.length > 0) {
      malformed.push({ entry, problems });
      continue;
    }

    const reviewBy = new Date(`${candidate.reviewBy}T00:00:00Z`);
    const added = new Date(`${candidate.added}T00:00:00Z`);
    const isPast = reviewBy.getTime() < now.getTime();
    const tooLong = daysBetween(added, reviewBy) > maxReviewIntervalDays;

    if (isPast || tooLong) {
      expired.push(candidate as AdvisoryException);
    } else {
      valid.push(candidate as AdvisoryException);
    }
  }

  return { valid, expired, malformed };
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function matches(finding: Finding, exception: AdvisoryException): boolean {
  if (normalize(finding.package) !== normalize(exception.package)) return false;
  if (normalize(finding.advisory) !== normalize(exception.advisory)) return false;
  if (exception.scope && normalize(exception.scope) !== normalize(finding.ecosystem)) {
    return false;
  }
  return true;
}

/**
 * Split findings into actionable (no matching valid exception) and excepted.
 * Does not mutate the registry or the findings.
 */
export function classifyFindings(
  findings: Finding[],
  registry: AdvisoryRegistry,
  policy: AuditPolicy,
  now: Date = new Date(),
): { actionable: Finding[]; excepted: Array<{ finding: Finding; exception: AdvisoryException }> } {
  const { valid } = validateAdvisoryExceptions(
    registry,
    now,
    policy.exceptions?.maxReviewIntervalDays ?? 90,
  );

  const actionable: Finding[] = [];
  const excepted: Array<{ finding: Finding; exception: AdvisoryException }> = [];

  for (const finding of findings) {
    const exception = valid.find((entry) => matches(finding, entry));
    if (exception) {
      excepted.push({ finding, exception });
    } else {
      actionable.push(finding);
    }
  }

  return { actionable, excepted };
}

function licenseKey(entry: LicenseEntry): string {
  return `${entry.workspace}\u0000${entry.package}\u0000${entry.version}`;
}

/**
 * Diff the current license inventory against the committed baseline.
 */
export function diffLicenseInventory(
  baseline: LicenseEntry[],
  current: LicenseEntry[],
): LicenseDiff {
  const baselineMap = new Map<string, LicenseEntry>();
  for (const entry of baseline) baselineMap.set(licenseKey(entry), entry);

  const currentMap = new Map<string, LicenseEntry>();
  for (const entry of current) currentMap.set(licenseKey(entry), entry);

  const added: LicenseEntry[] = [];
  const removed: LicenseEntry[] = [];
  const changed: Array<{ before: LicenseEntry; after: LicenseEntry }> = [];

  for (const [key, entry] of currentMap) {
    const before = baselineMap.get(key);
    if (!before) {
      added.push(entry);
    } else if (normalize(before.license) !== normalize(entry.license)) {
      changed.push({ before, after: entry });
    }
  }

  for (const [key, entry] of baselineMap) {
    if (!currentMap.has(key)) removed.push(entry);
  }

  return { added, removed, changed };
}

/**
 * Evaluate the full policy and produce an exit code plus a reviewable report.
 * 0 = clean, 1 = actionable findings or expired/malformed exceptions,
 * 2 = missing input/tooling.
 */
export function evaluatePolicy(input: {
  findings: Finding[];
  registry: AdvisoryRegistry;
  policy: AuditPolicy;
  now?: Date;
  licenseDiff?: LicenseDiff | null;
  inputError?: string;
}): PolicyEvaluation {
  const now = input.now ?? new Date();
  const { findings, registry, policy } = input;

  if (input.inputError) {
    return {
      exitCode: 2,
      report: {
        generatedAt: now.toISOString(),
        actionable: [],
        excepted: [],
        expiredExceptions: [],
        malformedExceptions: [],
        licenseDiff: input.licenseDiff ?? null,
        summary: `Input error: ${input.inputError}`,
      },
    };
  }

  const validation = validateAdvisoryExceptions(
    registry,
    now,
    policy.exceptions?.maxReviewIntervalDays ?? 90,
  );
  const { actionable, excepted } = classifyFindings(findings, registry, policy, now);

  const failOnNew = policy.behavior?.failOnNewFindings !== false;
  const failOnExpired = policy.behavior?.failOnExpiredExceptions !== false;

  const failing =
    (failOnNew && actionable.length > 0) ||
    (failOnExpired && (validation.expired.length > 0 || validation.malformed.length > 0));

  const parts: string[] = [];
  parts.push(`${actionable.length} actionable finding(s)`);
  parts.push(`${excepted.length} documented exception(s)`);
  parts.push(`${validation.expired.length} expired exception(s)`);
  parts.push(`${validation.malformed.length} malformed exception(s)`);
  if (input.licenseDiff) {
    parts.push(
      `license inventory: ${input.licenseDiff.added.length} added, ` +
        `${input.licenseDiff.removed.length} removed, ${input.licenseDiff.changed.length} changed`,
    );
  }

  return {
    exitCode: failing ? 1 : 0,
    report: {
      generatedAt: now.toISOString(),
      actionable,
      excepted,
      expiredExceptions: validation.expired,
      malformedExceptions: validation.malformed,
      licenseDiff: input.licenseDiff ?? null,
      summary: parts.join('; '),
    },
  };
}

/** Parse `npm audit --json` output into findings. Defensive: returns [] on unknown shape. */
export function parseNpmAudit(json: unknown): Finding[] {
  const findings: Finding[] = [];
  const vulnerabilities = (json as { vulnerabilities?: Record<string, unknown> })?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') return findings;

  for (const [name, raw] of Object.entries(vulnerabilities)) {
    const vuln = raw as { severity?: string; via?: unknown[] };
    const severity = vuln.severity ?? 'unknown';
    const via = Array.isArray(vuln.via) ? vuln.via : [];
    const advisories = via.filter(
      (item): item is { source?: number; url?: string; title?: string } =>
        typeof item === 'object' && item !== null,
    );
    if (advisories.length === 0) {
      findings.push({ ecosystem: 'npm', package: name, advisory: name, severity });
      continue;
    }
    for (const advisory of advisories) {
      const id =
        (advisory.url && advisory.url.match(/GHSA-[\w-]+/)?.[0]) ??
        (advisory.source !== undefined ? `npm-${advisory.source}` : name);
      findings.push({ ecosystem: 'npm', package: name, advisory: id, severity });
    }
  }
  return findings;
}

/** Parse `cargo audit --json` output into findings. Defensive: returns [] on unknown shape. */
export function parseCargoAudit(json: unknown): Finding[] {
  const findings: Finding[] = [];
  const vulnerabilities = (json as { vulnerabilities?: { list?: unknown[] } })?.vulnerabilities;
  const list = Array.isArray(vulnerabilities?.list) ? vulnerabilities!.list : [];

  for (const raw of list) {
    const item = raw as {
      advisory?: { id?: string; severity?: string };
      package?: { name?: string };
    };
    const pkg = item.package?.name;
    const advisory = item.advisory?.id;
    if (!pkg || !advisory) continue;
    findings.push({
      ecosystem: 'cargo',
      package: pkg,
      advisory,
      severity: item.advisory?.severity ?? 'unknown',
    });
  }
  return findings;
}

export function severityAtOrAbove(severity: string, threshold: Severity): boolean {
  return (SEVERITY_RANK[normalize(severity)] ?? 0) >= (SEVERITY_RANK[threshold] ?? 0);
}

function readJsonIfExists(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readLicenseInventory(dir: string): LicenseEntry[] | null {
  const inventoryPath = path.join(dir, 'licenses-inventory.json');
  const parsed = readJsonIfExists(inventoryPath);
  if (!Array.isArray(parsed)) return null;
  return parsed as LicenseEntry[];
}

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const policyPath = argValue(argv, '--policy') ?? '.github/dependency-audit-policy.json';
  const npmAuditPath = argValue(argv, '--npm-audit');
  const cargoAuditPath = argValue(argv, '--cargo-audit');
  const licensesDir = argValue(argv, '--licenses-dir') ?? 'artifacts';
  const reportPath = argValue(argv, '--report') ?? 'artifacts/dependency-audit-report.json';

  let policy: AuditPolicy;
  try {
    policy = loadPolicy(policyPath);
  } catch (error) {
    log(`unable to load policy at ${policyPath}: ${(error as Error).message}`);
    return 2;
  }

  const registryPath = policy.exceptions?.advisoryRegistry ?? '.github/audit-ignore.json';
  let registry: AdvisoryRegistry;
  try {
    registry = loadAdvisoryRegistry(registryPath);
  } catch (error) {
    log(`unable to load advisory registry at ${registryPath}: ${(error as Error).message}`);
    return 2;
  }

  const findings: Finding[] = [];
  if (npmAuditPath) {
    const npmJson = readJsonIfExists(npmAuditPath);
    if (npmJson === null) {
      log(`missing or unparseable npm audit input: ${npmAuditPath}`);
      return 2;
    }
    findings.push(...parseNpmAudit(npmJson));
  }
  if (cargoAuditPath) {
    const cargoJson = readJsonIfExists(cargoAuditPath);
    if (cargoJson === null) {
      log(`missing or unparseable cargo audit input: ${cargoAuditPath}`);
      return 2;
    }
    findings.push(...parseCargoAudit(cargoJson));
  }

  let licenseDiff: LicenseDiff | null = null;
  const current = readLicenseInventory(licensesDir);
  const baseline = readJsonIfExists(policy.licenseBaseline);
  if (current && Array.isArray(baseline)) {
    licenseDiff = diffLicenseInventory(baseline as LicenseEntry[], current);
  } else if (current && baseline === null) {
    log(`no license baseline at ${policy.licenseBaseline}; skipping inventory diff`);
  }

  const evaluation = evaluatePolicy({ findings, registry, policy, licenseDiff });

  log(evaluation.report.summary);
  for (const finding of evaluation.report.actionable) {
    log(`ACTIONABLE ${finding.ecosystem} ${finding.package} ${finding.advisory} (${finding.severity})`);
  }
  for (const { finding, exception } of evaluation.report.excepted) {
    log(`EXCEPTED ${finding.ecosystem} ${finding.package} ${finding.advisory} -> review by ${exception.reviewBy}`);
  }
  for (const exception of evaluation.report.expiredExceptions) {
    log(`EXPIRED exception ${exception.package} ${exception.advisory} (reviewBy ${exception.reviewBy})`);
  }
  for (const malformed of evaluation.report.malformedExceptions) {
    log(`MALFORMED exception: ${malformed.problems.join(', ')}`);
  }
  if (licenseDiff) {
    for (const entry of licenseDiff.added) {
      log(`LICENSE ADDED ${entry.workspace} ${entry.package}@${entry.version} (${entry.license})`);
    }
    for (const entry of licenseDiff.removed) {
      log(`LICENSE REMOVED ${entry.workspace} ${entry.package}@${entry.version} (${entry.license})`);
    }
    for (const change of licenseDiff.changed) {
      log(
        `LICENSE CHANGED ${change.after.workspace} ${change.after.package}@${change.after.version} ` +
          `${change.before.license} -> ${change.after.license}`,
      );
    }
  }

  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(evaluation.report, null, 2)}\n`, 'utf8');
    log(`report written to ${reportPath}`);
  } catch (error) {
    log(`unable to write report: ${(error as Error).message}`);
    return 2;
  }

  return evaluation.exitCode;
}

if (require.main === module) {
  process.exit(main());
}
