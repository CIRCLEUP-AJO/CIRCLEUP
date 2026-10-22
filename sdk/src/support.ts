import type { TxErrorCode, TxFailure } from './types';
/** Canonical guidance: never display errorMessage or serialize a failure object. */
const GUIDANCE: Record<TxErrorCode, string> = {
  invalid_argument: 'Review the input values before trying again.',
  account_not_found: 'Check the account on the selected network.',
  simulation_failed: 'The action could not be simulated. Refresh state and review eligibility.',
  network_error: 'The network is unavailable. Check the hash before considering another submission.',
  try_again_later: 'The RPC is busy. Check transaction status before trying another write.',
  tx_rejected: 'The network rejected the transaction. Review the action and account state.',
  tx_failed: 'The transaction failed on-chain. Refresh state before preparing another action.',
  tx_expired: 'The transaction expired. Check its final status before preparing another action.',
  stale_rpc: 'The RPC is behind the network. Try a status check later.',
  stale_state: 'Circle state changed. Refresh and review the action again.',
  timeout: 'Stopped waiting for confirmation. Check the transaction hash; it may still confirm.',
  outcome_unknown: 'Submission outcome is unknown. Check the hash; do not automatically resubmit.',
  unknown: 'Unable to complete the action. Copy the support summary for help.',
};
const OPERATIONS = ['create_circle','join','contribute','payout','close','mark_default','transaction_status'] as const;
export interface SupportSummary {
  operation: string;
  network: 'mainnet' | 'testnet' | 'custom';
  category: TxErrorCode;
  txHash?: string;
}
export function transactionSupport(failure: TxFailure, operation: string, network: string): { message: string; diagnostics: SupportSummary } {
  const category: TxErrorCode = Object.prototype.hasOwnProperty.call(GUIDANCE, failure.errorCode ?? '') ? failure.errorCode! : 'unknown';
  return {
    message: GUIDANCE[category],
    diagnostics: {
      operation: (OPERATIONS as readonly string[]).includes(operation) ? operation : 'unknown',
      network: network === 'mainnet' || network === 'testnet' ? network : 'custom',
      category,
      ...(typeof failure.txHash === 'string' && /^[a-fA-F0-9]{64}$/.test(failure.txHash) ? { txHash: failure.txHash.toLowerCase() } : {}),
    },
  };
}
