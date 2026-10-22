import { NETWORK_PASSPHRASE } from './config';
export type TransactionStatus = 'not_found' | 'pending' | 'success' | 'failed' | 'unavailable';
export interface RecentTransaction { network: string; hash: string; accepted: boolean }
export const RECEIPTS_KEY = 'circleup.receipts.v1';
export function isTransactionHash(value: unknown): value is string { return typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value); }
export function readReceipts(): RecentTransaction[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECEIPTS_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).flatMap((v) => v && typeof v.network === 'string' && v.network.length <= 200 && isTransactionHash(v.hash) ? [{ network: v.network, hash: v.hash.toLowerCase(), accepted: v.accepted === true }] : []);
  } catch { return []; }
}
export function rememberTransaction(hash: string, accepted: boolean): void {
  if (!isTransactionHash(hash)) return;
  try {
    const receipts = readReceipts();
    const old = receipts.find(v => v.network === NETWORK_PASSPHRASE && v.hash === hash.toLowerCase());
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify([{ network: NETWORK_PASSPHRASE, hash: hash.toLowerCase(), accepted: accepted || old?.accepted === true }, ...receipts.filter(v => v.network !== NETWORK_PASSPHRASE || v.hash !== hash.toLowerCase())].slice(0, 20)));
    window.dispatchEvent(new Event('circleup:receipts'));
  } catch { /* Storage may be unavailable; submission must still proceed. */ }
}
/** Deadline bounds observation, including a hung RPC; it never cancels a chain transaction. */
export function boundedRead<T>(work: Promise<T>, ms = 8000, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(new Error('Observation stopped')); };
    const timer = setTimeout(() => { finish(); reject(new Error('Read unavailable')); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    work.then(v => { finish(); resolve(v); }, e => { finish(); reject(e); });
  });
}
