# Task: Add transaction boundaries around indexer writes

## Steps

1. ✅ Plan approved
2. ✅ Edit `indexer/src/db/pool.ts` — Added `withTransaction()` function
3. ✅ Edit `indexer/src/indexer.ts` — Added `ingestEvent()` wrapping each event in `withTransaction()`
4. ✅ Edit `indexer/src/indexer.ts` — Updated all handlers to accept `client: PoolClient` parameter
5. ✅ Edit `indexer/src/db/schema.sql` — Added `ingested_events` table for dedup tracking
6. ✅ Added `indexer/src/indexer.test.ts` — Unit tests for `createEventKey`

## Status: ✅ Complete

All indexer writes are now wrapped in database transactions via `withTransaction()`.
Each event is atomically processed (event logged + data written) within a single transaction.
Multi-query handlers (`handleCirclePayout`, `handleCircleDefault`) share the same transactional client.
Events are deduplicated via `ingested_events` table with deterministic event keys.

## Transaction Architecture

### withTransaction() contract
- Input: callback `(client: PoolClient) => Promise<T>`
- Output: `Promise<T>` — result of the callback
- Side effects: `BEGIN`, `COMMIT`, or `ROLLBACK` on the connection

### Atomicity guarantees
- `handleCirclePayout`: payout INSERT + circles.current_round UPDATE in one tx
- `handleCircleDefault`: defaults INSERT + circle_members.defaults UPDATE in one tx
- `handleFactoryCircleCreated`: circles INSERT in one tx
- `handleCircleJoined`: circle_members UPDATE in one tx
- `handleCircleActive`: circles.status UPDATE in one tx
- `handleCircleContributed`: contributions INSERT in one tx
- `handleCircleCompleted`: circles.status UPDATE in one tx
- `handleReputationIncrement`: reputation UPSERT in one tx

### Deduplication mechanism
- `createEventKey()` produces a deterministic hash from ledger, txHash, contractId, topics, value
- `ingested_events` table uses event_key as PRIMARY KEY
- On CONFLICT DO NOTHING ensures idempotent replay safety
- Duplicate events are skipped with debug log

### Rollback scenarios
- Network failure mid-transaction → ROLLBACK, no partial writes
- RPC query failure → ROLLBACK, retry on next poll cycle
- Constraint violation → ROLLBACK, error logged
- Handler exception → ROLLBACK, error logged

### Recovery guarantees
- Processing restarts from last_ledger in indexer_state
- Already-ingested events are skipped via ingested_events lookup
- No double-spend risk on payouts or defaults
- No duplicate contributions recorded

### Test coverage
- createEventKey stability for identical events
- createEventKey sensitivity to differing event content
