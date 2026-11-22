import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditPolicy,
  AdvisoryRegistry,
  Finding,
  classifyFindings,
  diffLicenseInventory,
  evaluatePolicy,
  validateAdvisoryExceptions,
} from './dependency-audit-policy';

const NOW = new Date('2026-11-20T00:00:00Z');

function makePolicy(): AuditPolicy {
  return {
    version: 1,
    cadence: { cron: '0 6 * * 1' },
    severityThresholds: {
      npm: { failAt: 'high', warnAt: 'moderate' },
      cargo: { failAt: 'high', warnAt: 'moderate' },
    },
    exceptionOwner: '@CIRCLEUP-AJO/maintainers',
    artifactRetentionDays: 90,
    licenseBaseline: 'artifacts/licenses-baseline.json',
    exceptions: {
      advisoryRegistry: '.github/audit-ignore.json',
      maxReviewIntervalDays: 90,
    },
    behavior: {
      failOnNewFindings: true,
      failOnExpiredExceptions: true,
      autoAccept: false,
      modifyDependencies: false,
    },
  };
}

function makeRegistry(advisories: unknown[] = []): AdvisoryRegistry {
  return { schemaVersion: 1, reviewIntervalDays: 90, advisories: advisories as never[] };
}

const knownException = {
  package: 'next',
  advisory: 'GHSA-3h5v-q93c-6h6q',
  severity: 'high',
  reason: 'Upstream fix pending; not reachable in production build.',
  owner: '@CIRCLEUP-AJO/maintainers',
  added: '2026-11-01',
  reviewBy: '2027-01-15',
};

const knownFinding: Finding = {
  ecosystem: 'npm',
  package: 'next',
  advisory: 'GHSA-3h5v-q93c-6h6q',
  severity: 'high',
};

test('known exception is classified as excepted and passes', () => {
  const policy = makePolicy();
  const registry = makeRegistry([knownException]);

  const { actionable, excepted } = classifyFindings([knownFinding], registry, policy, NOW);
  assert.equal(actionable.length, 0);
  assert.equal(excepted.length, 1);

  const result = evaluatePolicy({ findings: [knownFinding], registry, policy, now: NOW });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.excepted.length, 1);
});

test('synthetic new finding is actionable and fails', () => {
  const policy = makePolicy();
  const registry = makeRegistry([knownException]);
  const newFinding: Finding = {
    ecosystem: 'npm',
    package: 'left-pad',
    advisory: 'GHSA-0000-0000-0000',
    severity: 'critical',
  };

  const result = evaluatePolicy({
    findings: [knownFinding, newFinding],
    registry,
    policy,
    now: NOW,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.actionable.length, 1);
  assert.equal(result.report.actionable[0].package, 'left-pad');
});

test('expired exception fails the audit', () => {
  const policy = makePolicy();
  const expired = { ...knownException, added: '2026-01-01', reviewBy: '2026-06-01' };
  const registry = makeRegistry([expired]);

  const validation = validateAdvisoryExceptions(registry, NOW, 90);
  assert.equal(validation.expired.length, 1);

  const result = evaluatePolicy({ findings: [knownFinding], registry, policy, now: NOW });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.expiredExceptions.length, 1);
  assert.equal(result.report.actionable.length, 1);
});

test('malformed exception fails the audit', () => {
  const policy = makePolicy();
  const registry = makeRegistry([
    { package: 'next', advisory: 'GHSA-3h5v-q93c-6h6q', severity: 'high' },
  ]);

  const validation = validateAdvisoryExceptions(registry, NOW, 90);
  assert.equal(validation.malformed.length, 1);
  assert.ok(validation.malformed[0].problems.includes('missing owner'));

  const result = evaluatePolicy({ findings: [knownFinding], registry, policy, now: NOW });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.malformedExceptions.length, 1);
});

test('license inventory diff reports added, removed and changed entries', () => {
  const baseline = [
    { workspace: 'app', package: 'react', version: '18.0.0', license: 'MIT' },
    { workspace: 'app', package: 'old-pkg', version: '1.0.0', license: 'MIT' },
    { workspace: 'sdk', package: 'stellar-sdk', version: '17.0.0', license: 'Apache-2.0' },
  ];
  const current = [
    { workspace: 'app', package: 'react', version: '18.0.0', license: 'MIT' },
    { workspace: 'app', package: 'new-pkg', version: '2.0.0', license: 'ISC' },
    { workspace: 'sdk', package: 'stellar-sdk', version: '17.0.0', license: 'GPL-3.0' },
  ];

  const diff = diffLicenseInventory(baseline, current);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].package, 'new-pkg');
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].package, 'old-pkg');
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].before.license, 'Apache-2.0');
  assert.equal(diff.changed[0].after.license, 'GPL-3.0');
});

test('evaluation never mutates the advisory registry', () => {
  const policy = makePolicy();
  const registry = makeRegistry([knownException]);
  const snapshot = JSON.stringify(registry);

  evaluatePolicy({ findings: [knownFinding], registry, policy, now: NOW });
  classifyFindings([knownFinding], registry, policy, NOW);

  assert.equal(JSON.stringify(registry), snapshot);
});

test('missing input yields exit code 2', () => {
  const policy = makePolicy();
  const registry = makeRegistry([]);
  const result = evaluatePolicy({
    findings: [],
    registry,
    policy,
    now: NOW,
    inputError: 'missing npm audit input',
  });
  assert.equal(result.exitCode, 2);
});
