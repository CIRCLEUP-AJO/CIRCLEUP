import { describe, expect, it } from 'vitest';
import { transactionSupport } from '../support';
import type { TxErrorCode, TxFailure } from '../types';
const codes: TxErrorCode[] = ['invalid_argument','account_not_found','simulation_failed','network_error','try_again_later','tx_rejected','tx_failed','tx_expired','stale_rpc','stale_state','timeout','outcome_unknown','unknown'];
describe('allowlisted transaction support', () => {
  for (const code of codes) it('maps ' + code + ' without copying provider diagnostics', () => {
    const secret = 'S' + 'A'.repeat(55);
    const failure = { success: false, errorCode: code, errorMessage: secret, txHash: 'ab'.repeat(32), signedXdr: secret, stack: secret } as TxFailure;
    const result = transactionSupport(failure, 'contribute', 'testnet');
    expect(result.diagnostics).toEqual({ category: code, operation: 'contribute', network: 'testnet', txHash: 'ab'.repeat(32) });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.message.length).toBeGreaterThan(10);
  });
  it('rejects unrestricted runtime fields despite static types', () => {
    const secret = 'private key';
    const result = transactionSupport({ success: false, errorCode: secret, errorMessage: secret, txHash: secret } as unknown as TxFailure, secret, secret);
    expect(result.diagnostics).toEqual({ category: 'unknown', operation: 'unknown', network: 'custom' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
