import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { boundedRead, readReceipts, rememberTransaction, RECEIPTS_KEY } from './transactionStatus';
import { NETWORK_PASSPHRASE } from './config';
import { invalidateWalletIdentity, observeWalletChanges, walletRevision } from './walletIdentity';
import { deploymentVerified, setDeploymentFacts } from './deploymentState';
import { buildDiagnosticsBundle } from './diagnostics';
import { parseContractError } from './contractErrors';
beforeEach(() => { localStorage.clear(); setDeploymentFacts([]); });
afterEach(() => { vi.useRealTimers(); });
describe('resumable public receipts', () => {
  it('persists only network, hash and acceptance evidence across reads', () => {
    rememberTransaction('ab'.repeat(32), true);
    rememberTransaction('ab'.repeat(32), false);
    expect(readReceipts()).toEqual([{ network: NETWORK_PASSPHRASE, hash: 'ab'.repeat(32), accepted: true }]);
    expect(Object.keys(JSON.parse(localStorage.getItem(RECEIPTS_KEY)!)[0]).sort()).toEqual(['accepted','hash','network']);
    localStorage.removeItem(RECEIPTS_KEY);
    expect(readReceipts()).toEqual([]);
  });
  it('keeps network identity and rejects corrupt or secret-shaped hashes', () => {
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify([{ network: 'other network', hash: 'cd'.repeat(32), accepted: true }, { network: NETWORK_PASSPHRASE, hash: 'S' + 'A'.repeat(55), signedXdr: 'secret' }]));
    expect(readReceipts()).toEqual([{ network: 'other network', hash: 'cd'.repeat(32), accepted: true }]);
  });
  it('bounds a hung read and cleans up on navigation abort', async () => {
    vi.useFakeTimers();
    const timed = expect(boundedRead(new Promise(() => {}), 100)).rejects.toThrow('Read unavailable');
    await vi.advanceTimersByTimeAsync(100); await timed;
    const ctrl = new AbortController();
    const stopped = expect(boundedRead(new Promise(() => {}), 8000, ctrl.signal)).rejects.toThrow('Observation stopped');
    ctrl.abort(); await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });
});
it('invalidates identity and deployment before re-resolution, without deleting submitted receipts', () => {
  rememberTransaction('ab'.repeat(32), true);
  setDeploymentFacts([{ name: 'network', status: 'verified' }]);
  const before = walletRevision();
  const changed = vi.fn();
  const stop = observeWalletChanges(changed);
  invalidateWalletIdentity();
  expect(walletRevision()).toBeGreaterThan(before);
  expect(changed).toHaveBeenCalled();
  expect(deploymentVerified()).toBe(false);
  expect(readReceipts()).toHaveLength(1);
  stop();
});
it('copies canonical guidance, never provider text or extra properties', () => {
  const secret = 'S' + 'A'.repeat(55);
  const error = { ...parseContractError('timeout'), message: 'seed ' + secret, raw: secret, signedXdr: secret };
  const summary = buildDiagnosticsBundle({ typedError: error, txHash: 'ab'.repeat(32), operation: 'contribute' });
  expect(JSON.stringify(summary)).not.toContain(secret);
  expect(summary.error?.txHash).toBe('ab'.repeat(32));
  expect(summary.error?.operation).toBe('contribute');
  expect(summary.error?.message).toContain('may still confirm');
});
