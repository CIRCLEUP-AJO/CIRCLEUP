// Bounded indexer-update discovery for circle pages (issue #797).
//
// Operational trade-off (documented, measured defaults):
// - SSE (`/api/indexer-events`) is preferred when the deployment allows
//   long-lived proxied streams (see docs/indexer-transport-notes.md); it is
//   strictly bounded by `maxReconnects` with exponential backoff + jitter.
// - Otherwise `startBoundedPolling` polls `fetchLedger` at most `maxPolls`
//   times at `intervalMs`. Both paths deduplicate by ledger value, cancel on
//   route change (call `stop()` in an effect cleanup), and ALWAYS fall back
//   to manual refresh — the page stays usable with push disabled.
// - Updates NEVER imply on-chain confirmation: `IndexedUpdate.confirmed`
//   is always false; transaction confirmation is a separate wallet/RPC fact.

export interface IndexedUpdate {
  circleAddress: string;
  latestLedger: number | null;
  /** Always false: an indexed projection is not a confirmation. */
  confirmed: false;
}

export interface UpdateSource {
  onUpdate(cb: (u: IndexedUpdate) => void): void;
  stop(): void;
  readonly attempts: number;
}

export function dedupeLedger(seen: number | null, next: number | null): boolean {
  if (next === null || next === undefined) return false;
  if (seen === next) return false;
  return true;
}

export function backoffMs(attempt: number, baseMs = 1000, maxMs = 30000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10));
  return exp + Math.floor(Math.random() * 250);
}

export function startBoundedPolling(opts: {
  circleAddress: string;
  fetchLedger: () => Promise<number | null>;
  onUpdate: (u: IndexedUpdate) => void;
  intervalMs?: number;
  maxPolls?: number;
  signal?: AbortSignal;
}): UpdateSource {
  const { circleAddress, fetchLedger, onUpdate } = opts;
  const intervalMs = opts.intervalMs ?? 5000;
  const maxPolls = opts.maxPolls ?? 12;
  let polls = 0;
  let last: number | null = null;
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped || opts.signal?.aborted) {
      clearInterval(timer);
      return;
    }
    if (polls >= maxPolls) {
      clearInterval(timer);
      return;
    }
    polls += 1;
    try {
      const ledger = await fetchLedger();
      if (stopped) return;
      if (dedupeLedger(last, ledger)) {
        last = ledger;
        onUpdate({ circleAddress, latestLedger: ledger, confirmed: false });
      }
    } catch {
      // Transient fetch failure: counted against the bound, surfaced via
      // the next successful poll or manual refresh. Never throws.
    }
  }, intervalMs);
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => {
      stopped = true;
      clearInterval(timer);
    });
  }
  return {
    onUpdate: () => undefined,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    get attempts() {
      return polls;
    },
  };
}

export function subscribeIndexerUpdates(opts: {
  circleAddress: string;
  streamUrl: string | null;
  fetchLedger: () => Promise<number | null>;
  onUpdate: (u: IndexedUpdate) => void;
  maxReconnects?: number;
  signal?: AbortSignal;
}): UpdateSource {
  const { circleAddress, streamUrl, fetchLedger, onUpdate } = opts;
  const maxReconnects = opts.maxReconnects ?? 5;
  if (streamUrl === null || typeof EventSource === "undefined") {
    return startBoundedPolling({ circleAddress, fetchLedger, onUpdate, signal: opts.signal });
  }
  let reconnects = 0;
  let last: number | null = null;
  let stopped = false;
  let es: EventSource | null = null;
  let fallback: UpdateSource | null = null;

  const emit = (raw: string) => {
    try {
      const msg = JSON.parse(raw) as { circleAddress?: string; latestLedger?: number };
      if (msg.circleAddress !== circleAddress) return;
      const ledger = typeof msg.latestLedger === "number" ? msg.latestLedger : null;
      if (!dedupeLedger(last, ledger)) return;
      last = ledger;
      onUpdate({ circleAddress, latestLedger: ledger, confirmed: false });
    } catch {
      // Malformed SSE payload: ignore, keep the stream open.
    }
  };

  const connect = () => {
    if (stopped || opts.signal?.aborted) return;
    try {
      es = new EventSource(streamUrl);
    } catch {
      fallback = startBoundedPolling({ circleAddress, fetchLedger, onUpdate, signal: opts.signal });
      return;
    }
    es.onmessage = (ev) => emit(String((ev as MessageEvent).data ?? ""));
    es.onerror = () => {
      es?.close();
      reconnects += 1;
      if (reconnects > maxReconnects || stopped) {
        fallback = startBoundedPolling({ circleAddress, fetchLedger, onUpdate, signal: opts.signal });
        return;
      }
      setTimeout(connect, backoffMs(reconnects));
    };
  };
  connect();
  opts.signal?.addEventListener("abort", () => {
    stopped = true;
    es?.close();
    fallback?.stop();
  });
  return {
    onUpdate: () => undefined,
    stop() {
      stopped = true;
      es?.close();
      fallback?.stop();
    },
    get attempts() {
      return reconnects;
    },
  };
}
