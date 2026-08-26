# Indexer Reliability Design

This document describes the reliability mechanisms in the CircleUp event indexer, covering crash recovery, idempotency, and transient failure handling.

## Overview

The indexer must maintain exactly-once semantics across:
- Process crashes and restarts
- Temporary RPC outages
- Database connection failures
- Duplicate event delivery from at-least-once polling

These guarantees are enforced through:
1. **Atomic ledger checkpointing** — cursor and projections in one transaction
2. **Canonical event identity** — database-level deduplication
3. **Exponential backoff with cancellation** — graceful handling of transient failures

## Atomic Ledger Processing (Issue 31)

### Design

Each ledger's events are processed in a single database transaction that includes:
- Event projections (circles, contributions, payouts, etc.)
- Cursor advancement (`indexer_state.last_ledger`)
- Checkpoint record (`ledger_checkpoints`)

```typescript
await withTransaction(async (client) => {
  for (const event of ledgerEvents) {
    await ingestEventInTx(client, event, handler);
  }
  
  // Both updates happen atomically with event writes
  await client.query("UPDATE indexer_state SET last_ledger = $1", [ledger]);
  await client.query("INSERT INTO ledger_checkpoints ...", [ledger, ...]);
});
```

### Restart Safety

On restart, the indexer reads `last_ledger` from the database (never from memory) and resumes from the next ledger:

```typescript
async function runPollCycle(): Promise<void> {
  let lastLedger = await getLastLedger(); // always from DB
  if (lastLedger === 0) lastLedger = START_LEDGER;
  
  const toLedger = (await rpc.getLatestLedger()).sequence;
  if (toLedger > lastLedger) {
    await processEvents(lastLedger + 1, toLedger);
  }
}
```

If the process crashes:
- **Before commit**: The transaction rolls back, `last_ledger` stays at N, restart processes ledger N+1 again
- **After commit**: The transaction is durable, `last_ledger` is N+1, restart processes ledger N+2

No events are skipped, no events are double-applied.

### Savepoints for Partial Failure

Individual event failures use savepoints so one bad event doesn't abort the entire ledger:

```typescript
for (const { event, handler } of items) {
  await client.query("SAVEPOINT sp_event");
  try {
    await ingestEventInTx(client, event, handler);
    await client.query("RELEASE SAVEPOINT sp_event");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT sp_event");
    // log error, increment failure counter, continue
  }
}
```

The ledger checkpoint records both success and failure counts, so monitoring can detect degraded ingestion.

## Event Idempotency (Issue 28)

### Canonical Identity

Events are uniquely identified by:
- `ledger` — Stellar ledger sequence number
- `tx_hash` — Transaction hash that emitted the event
- `event_index` — Zero-based index within that transaction's event list

This identity is extracted from the Soroban RPC event `id` field:
```
"0000012345678-0000000002-0000000001"
 │            │          │           │
 └─ ledger   └─ tx idx  └─ event idx
```

### Database Constraint

Migration `003_event_dedup_constraints.sql` adds:

```sql
CREATE UNIQUE INDEX idx_ingested_events_identity
  ON ingested_events(ledger, tx_hash, event_index)
  WHERE event_index IS NOT NULL;
```

This makes duplicate inserts a silent no-op:

```typescript
await client.query(
  `INSERT INTO ingested_events (event_key, contract_id, ledger, tx_hash, event_type, event_index)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (event_key) DO NOTHING`,
  [eventKey, contractId, ledger, txHash, eventType, eventIndex],
);
```

### Why Not Application-Layer Dedup?

Application-layer dedup (checking a Set before processing) fails across restarts:
- Process crashes after writing event but before committing cursor
- Restart re-fetches the same ledger range
- In-memory Set is empty — event is processed again ❌

Database constraints enforce idempotency even when the cursor transaction rolls back.

### Multi-Event Transactions

A single transaction can emit multiple events. Each gets a distinct `event_index`:
```
ledger 12345, tx abc123:
  event 0: factory/circle_created
  event 1: circle/joined
  event 2: circle/active
```

The unique constraint on `(ledger, tx_hash, event_index)` ensures all three are ingested exactly once even if delivered multiple times.

### Network Separation

The constraint is ledger-scoped. If the same transaction hash appears in multiple ledgers (impossible on Stellar, but the schema defends against it), the events are treated as distinct.

## Exponential Backoff (Issue 29)

### Design

Temporary RPC failures (connection refused, timeout, rate limit) should not cause:
- Hot loop — immediate retry burns CPU and floods logs
- Immediate exit — transient 5-second outage kills the process

The polling loop tracks consecutive failures and backs off exponentially:

```typescript
interface BackoffState {
  consecutiveFailures: number;
  currentIntervalMs: number;
}

function incrementBackoff(state: BackoffState): void {
  state.consecutiveFailures++;
  state.currentIntervalMs = Math.min(
    BACKOFF_MAX_MS,
    state.currentIntervalMs * BACKOFF_MULTIPLIER,
  );
}
```

### Progression

Default config: initial 1s, multiplier 2.0, cap 60s

| Failure | Interval |
|---------|----------|
| 1       | 1s       |
| 2       | 2s       |
| 3       | 4s       |
| 4       | 8s       |
| 5       | 16s      |
| 6       | 32s      |
| 7+      | 60s      |

### Jitter

Full jitter spreads retries across `[0, currentInterval]` to avoid thundering herd:

```typescript
const jitteredWait = Math.floor(Math.random() * state.currentIntervalMs);
await new Promise((resolve) => setTimeout(resolve, jitteredWait));
```

When 100 indexers all fail simultaneously (RPC restart), they don't all retry at exactly `t + 1s`.

### Reset After Success

A successful poll resets the backoff:

```typescript
async function runPollCycle(): Promise<void> {
  // ... fetch and process events ...
  resetBackoff(backoffState); // next failure starts from initial interval
}
```

### Structured Warnings

Warnings are emitted at exponentially spaced thresholds (3, 4, 8, 16, 32, ...) to avoid log spam:

```typescript
if (shouldWarnBackoff(backoffState)) {
  console.warn(
    `[indexer] Poll has failed ${backoffState.consecutiveFailures} consecutive times. ` +
    `Current backoff interval: ${Math.floor(backoffState.currentIntervalMs / 1000)}s.`,
  );
}
```

### Graceful Shutdown

The shutdown path waits for in-flight polls to finish:

```typescript
export async function stopIndexer(): Promise<void> {
  shuttingDown = true;
  if (pollTimer) clearInterval(pollTimer);
  if (pollInFlight) {
    console.log("[indexer] Waiting for in-flight poll cycle to finish...");
    await pollInFlight.catch(() => undefined);
  }
}
```

This prevents mid-transaction kills that would leave the database in an inconsistent state.

## Configuration

All backoff parameters are configurable via environment variables:

```bash
# Initial backoff interval (default: 1000ms)
POLL_BACKOFF_INITIAL_MS=1000

# Maximum backoff interval (default: 60000ms)
POLL_BACKOFF_MAX_MS=60000

# Backoff multiplier (default: 2.0)
POLL_BACKOFF_MULTIPLIER=2.0

# Base polling interval when healthy (default: 5000ms)
POLL_INTERVAL_MS=5000
```

## Testing

### Backoff Tests

`indexer/src/backoff.test.ts` verifies:
- Initial interval is applied
- Interval doubles on consecutive failures
- Interval is capped at maximum
- Jitter produces varied waits within bounds
- Success resets state
- Warnings trigger at correct thresholds

### Event Identity Tests

`indexer/src/eventIdentity.test.ts` verifies:
- `parseEventIndex` extracts index from SDK event.id
- `createEventKey` produces stable keys
- Same (ledger, tx, index) → same key
- Different ledger/tx/index → different key
- Missing fields handled gracefully

### Integration Tests

`indexer/src/indexer.test.ts` (existing) verifies:
- Restart resumes from durable cursor
- Duplicate events are skipped
- Ledger checkpoint atomicity
- Gap detection

## Monitoring

Key metrics for production monitoring:

### Backoff State
- `consecutiveFailures` — rising trend indicates RPC issues
- `currentIntervalMs` — hitting max cap means sustained outage

### Ledger Processing
- `ledger_checkpoints.failed_count` — events that threw during ingestion
- Gap between `last_ledger` and latest network ledger — indexer lag

### Event Deduplication
- Count of `ON CONFLICT DO NOTHING` hits in logs — normal in at-least-once model

## Future Improvements

### Adaptive Backoff
- Track RPC latency percentiles
- Reduce backoff multiplier when latency is low
- Increase multiplier during known maintenance windows

### Circuit Breaker
- After N failures, switch to a backup RPC endpoint
- Reset circuit after M consecutive successes

### Ledger Cursor Sharding
- Split ledger range across multiple indexer processes
- Each owns a shard (e.g. ledger % 10)
- Reduces RPC load, increases throughput

### Event Replay
- Admin endpoint to replay a ledger range
- Useful for recovering from data corruption
- Dedup constraint makes it safe to replay arbitrary ranges
