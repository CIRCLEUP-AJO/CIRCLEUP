"use client";
import { useEffect, useState } from 'react';
import { NETWORK_PASSPHRASE, ACTIVE_NETWORK, getExplorerLink } from '@/lib/config';
import { lookupTransactionStatus } from '@/lib/stellar';
import { readReceipts, RECEIPTS_KEY, isTransactionHash, type RecentTransaction, type TransactionStatus } from '@/lib/transactionStatus';
const messages: Record<TransactionStatus, string> = {
  not_found: 'Not found in this RPC’s retained history. This does not establish failure or cancellation.',
  pending: 'Submission was accepted; confirmation has not been observed. The transaction may still confirm.',
  success: 'Successful: confirmed on-chain.', failed: 'Failed: the chain reported transaction failure.',
  unavailable: 'Status temporarily unavailable. Retry the status check; do not resubmit the transaction.',
};
export default function TransactionsPage() {
  const [receipts, setReceipts] = useState<RecentTransaction[]>([]);
  const [selected, setSelected] = useState<RecentTransaction | null>(null);
  const [hash, setHash] = useState('');
  const [status, setStatus] = useState<TransactionStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const [copy, setCopy] = useState('Copy support summary');
  useEffect(() => { const load = () => setReceipts(readReceipts()); load(); window.addEventListener('circleup:receipts', load); window.addEventListener('storage', load); return () => { window.removeEventListener('circleup:receipts', load); window.removeEventListener('storage', load); }; }, []);
  useEffect(() => {
    if (!selected || selected.network !== NETWORK_PASSPHRASE) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(null); setChecking(true); setExhausted(false);
    async function poll(count: number): Promise<void> {
      const next = await lookupTransactionStatus(selected!.hash, selected!.accepted, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setStatus(next);
      if ((next === 'pending' || next === 'not_found') && count < 9) timer = setTimeout(() => { void poll(count + 1); }, 2000);
      else { setChecking(false); setExhausted(count === 9); }
    }
    void poll(0);
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [selected, attempt]);
  function clear() { try { localStorage.removeItem(RECEIPTS_KEY); setReceipts([]); setSelected(null); setStatus(null); } catch { setCopy('Storage unavailable'); } }
  return <section className="space-y-4">
    <h1 className="text-2xl font-bold">Recent transactions</h1>
    <p>Active network: {ACTIVE_NETWORK}. Only public hashes and network identity are saved locally (up to 20 receipts). Status checks never sign or submit transactions.</p>
    <button type="button" onClick={clear}>Clear saved receipts</button>
    <ul>{receipts.map(r => <li key={r.network + r.hash} className="break-all py-2"><button type="button" disabled={r.network !== NETWORK_PASSPHRASE} onClick={() => setSelected(r)}>{r.hash}</button>{r.network !== NETWORK_PASSPHRASE && ' — switch the app to the receipt’s network to check'}</li>)}</ul>
    <form onSubmit={e => { e.preventDefault(); if (isTransactionHash(hash)) setSelected({ network: NETWORK_PASSPHRASE, hash: hash.toLowerCase(), accepted: false }); }}>
      <label htmlFor="transaction-hash">Transaction hash on the active network</label>
      <input id="transaction-hash" className="border p-2 w-full" value={hash} onChange={e => setHash(e.target.value.trim())} maxLength={64} />
      <button disabled={!isTransactionHash(hash)}>Check status</button>
    </form>
    {selected && <div className="border rounded p-4 space-y-3">
      <p className="break-all">{selected.hash}</p>
      <p role="status">{status ? messages[status] : 'Checking status…'}{checking && status ? ' Checking again…' : ''}</p>
      {exhausted && <p>Observation limit reached. The transaction may still confirm. You can check again.</p>}
      <button type="button" onClick={() => setAttempt(n => n + 1)} disabled={checking}>Retry status check</button>
      {getExplorerLink(ACTIVE_NETWORK, 'tx', selected.hash) && <a href={getExplorerLink(ACTIVE_NETWORK, 'tx', selected.hash)!} target="_blank" rel="noopener noreferrer">View in explorer</a>}
      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify({ operation: 'transaction_status', network: ACTIVE_NETWORK, category: status ?? 'checking', txHash: selected.hash }, null, 2)); setCopy('Copied'); } catch { setCopy('Copy failed; try again'); } }}>{copy}</button>
    </div>}
  </section>;
}
