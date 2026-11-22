import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHECKS, checksForTier, parseTier, runVerification } from './verify';

const noopLog = () => {};

test('fast tier runs checks in declared order', () => {
  const invoked: string[] = [];
  const { exitCode } = runVerification('fast', {
    log: noopLog,
    exec: (command, args) => {
      invoked.push(`${command} ${args.join(' ')}`);
      return 0;
    },
  });

  const expected = checksForTier('fast').map((check) => `${check.command} ${check.args.join(' ')}`);
  assert.deepEqual(invoked, expected);
  assert.equal(exitCode, 0);
});

test('a failing child makes the parent fail and is reported', () => {
  const failingId = 'app:typecheck';
  const failingCheck = CHECKS.find((check) => check.id === failingId);
  assert.ok(failingCheck);

  const { outcomes, exitCode } = runVerification('fast', {
    log: noopLog,
    exec: (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      return key === `${failingCheck.command} ${failingCheck.args.join(' ')}` ? 1 : 0;
    },
  });

  assert.equal(exitCode, 1);
  const outcome = outcomes.find((o) => o.id === failingId);
  assert.ok(outcome);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.exitCode, 1);
});

test('checks after a failure are not executed', () => {
  const failingId = 'sdk:build';
  const failingCheck = CHECKS.find((check) => check.id === failingId);
  assert.ok(failingCheck);

  const invoked: string[] = [];
  const { outcomes } = runVerification('fast', {
    log: noopLog,
    exec: (command, args) => {
      invoked.push(`${command} ${args.join(' ')}`);
      return 1;
    },
  });

  assert.equal(invoked.length, 1);
  const notRun = outcomes.filter((o) => o.status === 'not-run');
  assert.equal(notRun.length, checksForTier('fast').length - 1);
});

test('unmet prerequisites are reported as skips without invoking exec', () => {
  const gated = CHECKS.find((check) => check.id === 'contracts:test');
  assert.ok(gated);
  assert.ok(gated.prerequisite);

  const invoked: string[] = [];
  const { outcomes, exitCode } = runVerification('full', {
    log: noopLog,
    exec: (command, args) => {
      invoked.push(`${command} ${args.join(' ')}`);
      return 0;
    },
  });

  const outcome = outcomes.find((o) => o.id === 'contracts:test');
  assert.ok(outcome);
  if (!gated.prerequisite.isAvailable()) {
    assert.equal(outcome.status, 'skip');
    assert.match(outcome.skipReason ?? '', /prerequisite not met/);
    assert.ok(!invoked.some((call) => call.startsWith('cargo ')));
  } else {
    assert.equal(outcome.status, 'pass');
  }
  assert.equal(exitCode, 0);
});

test('full tier includes every fast-tier check plus integration checks', () => {
  const fastIds = checksForTier('fast').map((check) => check.id);
  const fullIds = checksForTier('full').map((check) => check.id);

  for (const id of fastIds) {
    assert.ok(fullIds.includes(id), `full tier missing fast check ${id}`);
  }
  assert.ok(fullIds.includes('contracts:test'));
  assert.ok(fullIds.includes('app:test:visual'));
  assert.ok(fullIds.includes('release-check'));
  assert.ok(fullIds.length > fastIds.length);
});

test('all-pass scenario returns exit code 0', () => {
  const { outcomes, exitCode } = runVerification('full', {
    log: noopLog,
    exec: () => 0,
  });

  assert.equal(exitCode, 0);
  assert.ok(outcomes.every((o) => o.status === 'pass' || o.status === 'skip'));
});

test('parseTier maps known tiers and rejects unknown values', () => {
  assert.equal(parseTier([]), 'fast');
  assert.equal(parseTier(['--tier=fast']), 'fast');
  assert.equal(parseTier(['--tier=full']), 'full');
  assert.throws(() => parseTier(['--tier=slow']), /Unknown verification tier/);
});
