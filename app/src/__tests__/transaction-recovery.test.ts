import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Account, BASE_FEE, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk';
import { CREATOR_ADDR, MEMBER_A_ADDR, FACTORY_ADDR, REPUTATION_ADDR, USDC_ADDR, SDK_CONFIG } from '../../../../sdk/src/__tests__/fixtures';
const rpc = vi.hoisted(() => ({ getTransaction: vi.fn(), getNetwork: vi.fn(), simulateTransaction: vi.fn(), sendTransaction: vi.fn() }));
const wallet = vi.hoisted(() => ({ getPublicKey: vi.fn(), signTransaction: vi.fn() }));
vi.mock('@stellar/stellar-sdk', async importOriginal => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return { ...actual, SorobanRpc: { ...actual.SorobanRpc, Server: class { getTransaction = rpc.getTransaction; getNetwork = rpc.getNetwork; simulateTransaction = rpc.simulateTransaction; sendTransaction = rpc.sendTransaction; } } };
});
vi.mock('@stellar/freighter-api', () => ({ isConnected: async () => true, getPublicKey: wallet.getPublicKey, signTransaction: wallet.signTransaction, requestAccess: wallet.getPublicKey }));
vi.mock('../lib/config', async () => {
  const fixtures = await import('../../../../sdk/src/__tests__/fixtures');
  return { STELLAR_RPC_URL: fixtures.SDK_CONFIG.rpcUrl, NETWORK_PASSPHRASE: fixtures.SDK_CONFIG.networkPassphrase, CIRCLE_FACTORY_ADDRESS: fixtures.FACTORY_ADDR, REPUTATION_ADDRESS: fixtures.REPUTATION_ADDR, USDC_ADDRESS: fixtures.USDC_ADDR };
});
vi.mock('../lib/walletCapabilities', () => ({ detectWalletCapabilities: () => ({ canSignTransaction: true }), explainUnsupportedAction: () => null }));
import { lookupTransactionStatus, submitContractTx, verifyConfiguredDeployment } from '../lib/stellar';
import { setDeploymentFacts } from '../lib/deploymentState';
import { invalidateWalletIdentity } from '../lib/walletIdentity';
import { startTx } from '../lib/telemetry';
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window, { freighter: {} });
  wallet.getPublicKey.mockResolvedValue(CREATOR_ADDR);
  setDeploymentFacts([{ name: 'test evidence', status: 'verified' }]);
});
describe('read-only recovery categories', () => {
  it.each([['SUCCESS', false, 'success'], ['FAILED', false, 'failed'], ['NOT_FOUND', false, 'not_found'], ['NOT_FOUND', true, 'pending'], ['unexpected', false, 'unavailable']] as const)('%s with accepted=%s maps to %s', async (status, accepted, expected) => {
    rpc.getTransaction.mockResolvedValue({ status });
    expect(await lookupTransactionStatus('ab'.repeat(32), accepted)).toBe(expected);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });
  it('offers a new read after an outage without submitting', async () => {
    rpc.getTransaction.mockRejectedValueOnce(new Error('secret provider body')).mockResolvedValueOnce({ status: 'SUCCESS' });
    expect(await lookupTransactionStatus('ab'.repeat(32))).toBe('unavailable');
    expect(await lookupTransactionStatus('ab'.repeat(32))).toBe('success');
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });
});
describe('identity gates', () => {
  it('does not prompt when the current account differs from the prepared identity', async () => {
    wallet.getPublicKey.mockResolvedValue(MEMBER_A_ADDR);
    await expect(submitContractTx('unused', CREATOR_ADDR, startTx('join'))).rejects.toThrow('Wallet account changed');
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });
  it('discards a signature returned after an account transition', async () => {
    let finish!: (xdr: string) => void;
    wallet.signTransaction.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const envelope = new TransactionBuilder(new Account(CREATOR_ADDR, '0'), { fee: BASE_FEE, networkPassphrase: SDK_CONFIG.networkPassphrase }).setTimeout(30).build().toXDR();
    const work = submitContractTx(envelope, CREATOR_ADDR, startTx('join'));
    await vi.waitFor(() => expect(wallet.signTransaction).toHaveBeenCalled());
    invalidateWalletIdentity();
    const rejected = expect(work).rejects.toThrow('Wallet account changed');
    finish(envelope); await rejected;
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });
});
describe('explicit deployment evidence', () => {
  it('reports a wrong network and skips contract probes', async () => {
    rpc.getNetwork.mockResolvedValue({ passphrase: 'wrong network' });
    const facts = await verifyConfiguredDeployment();
    expect(facts[0].status).toBe('mismatch');
    expect(facts.slice(1).every(f => f.status === 'unverifiable')).toBe(true);
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });
  it('reports an outage without leaking its body', async () => {
    rpc.getNetwork.mockRejectedValue(new Error('seed private provider body'));
    const facts = await verifyConfiguredDeployment();
    expect(facts.every(f => f.status === 'unverifiable')).toBe(true);
    expect(JSON.stringify(facts)).not.toContain('private provider body');
  });
  it('accepts the configured getter evidence and rejects malformed values', async () => {
    rpc.getNetwork.mockResolvedValue({ passphrase: SDK_CONFIG.networkPassphrase });
    const answer = (value: unknown, type?: 'u32') => ({ result: { retval: type ? nativeToScVal(value, { type }) : nativeToScVal(value) } });
    rpc.simulateTransaction.mockResolvedValueOnce(answer(USDC_ADDR)).mockResolvedValueOnce(answer(REPUTATION_ADDR)).mockResolvedValueOnce(answer(CREATOR_ADDR)).mockResolvedValueOnce(answer(7, 'u32'));
    expect((await verifyConfiguredDeployment()).every(f => f.status === 'verified')).toBe(true);
    rpc.simulateTransaction.mockResolvedValue(answer({ malformed: true }));
    expect((await verifyConfiguredDeployment()).slice(1).every(f => f.status === 'unverifiable')).toBe(true);
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });
});
