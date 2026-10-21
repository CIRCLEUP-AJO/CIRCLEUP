/** Hard caps apply to normal catch-up and historical recovery alike. */
export function boundedInteger(name: string, raw: string | undefined, fallback: number, max: number): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(name + " must be an integer in 1.." + max);
  return n;
}
export class BatchLimitError extends Error {}
export function batchEnd(from: number, head: number, ledgers: number): number {
  return Math.min(head, from + ledgers - 1);
}
