# Quick Reference: Issues 28-31 Implementation

## TL;DR

Four interconnected reliability improvements for the CircleUp indexer:

| Issue | What | Why | How |
|-------|------|-----|-----|
| **29** | Exponential backoff | Prevent hot loops during RPC outages | 1s → 2s → 4s → ... → 60s with jitter |
| **28** | Database idempotency | Duplicate events are normal in at-least-once polling | Unique index on (ledger, tx_hash, event_index) |
| **30** | Contract fixtures | Catch signature changes before production | XDR-encoded argument snapshots for 22 methods |
| **31** | Restart safety | No events skipped or duplicated after crash | Cursor + projections in one transaction |

---

## Running Tests

```bash
# All tests
npm test --workspaces

# Specific test files
npm test -- backoff.test.ts --run           # Issue 29
npm test -- eventIdentity.test.ts --run     # Issue 28
npm test -- contractFixtures.test.ts --run  # Issue 30
npm test -- indexer.test.ts --run           # Issue 31 (existing)
```

---

## Running Migrations

```bash
cd indexer

# Apply all pending migrations
npm run migrate

# Check schema health (exits 1 if not clean)
npm run migrate:check

# Dry-run replay from ledger N
npm run replay:dry-run -- --from=12345
```

---

## Configuration

### Environment Variables

```bash
# Exponential backoff (Issue 29)
POLL_BACKOFF_INITIAL_MS=1000       # Initial interval (default: 1s)
POLL_BACKOFF_MAX_MS=60000          # Max interval (default: 60s)
POLL_BACKOFF_MULTIPLIER=2.0        # Multiplier (default: 2.0)

# Existing polling
POLL_INTERVAL_MS=5000              # Healthy interval (default: 5s)
RPC_RETRY_MAX_ATTEMPTS=4           # Transient retry limit (default: 4)
RPC_RETRY_BASE_DELAY_MS=500        # Initial retry delay (default: 500ms)
```

### Defaults

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| Initial backoff | 1000ms | 100–10000ms | First retry wait |
| Max backoff | 60000ms | 1000–300000ms | Cap to prevent infinite wait |
| Multiplier | 2.0 | 1.0–3.0 | Growth rate (1.0 = flat) |
| Poll interval | 5000ms | 1000–60000ms | Healthy polling rate |

---

## Monitoring Queries

### Check Backoff State

Logs will show:
```
[indexer] Poll has failed 8 consecutive times. Current backoff interval: 32s.
```

**Action**: If `consecutiveFailures > 16`, investigate RPC connectivity.

### Check for Duplicate Events

```sql
-- Should always return 0 rows
SELECT ledger, tx_hash, event_index, COUNT(*)
FROM ingested_events
WHERE event_index IS NOT NULL
GROUP BY ledger, tx_hash, event_index
HAVING COUNT(*) > 1;
```

**Action**: If > 0 rows, unique constraint is broken — file urgent bug.

### Check Indexer Lag

```sql
-- Get last indexed ledger
SELECT last_ledger, updated_at FROM indexer_state WHERE id = 1;

-- Compare to network (via RPC)
-- curl -X POST $RPC_URL -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'
```

**Action**: If lag > 1000 ledgers for > 10 minutes, indexer is falling behind.

### Check Failed Events

```sql
-- Recent ledgers with failed events
SELECT ledger, events_count, failed_count, processed_at
FROM ledger_checkpoints
WHERE failed_count > 0
ORDER BY ledger DESC
LIMIT 10;
```

**Action**: If `failed_count > 0` for consecutive ledgers, event handlers need fixing.

---

## Troubleshooting

### "Backoff hitting 60s cap repeatedly"

**Cause**: RPC is down or unreachable for > 2 minutes.

**Fix**:
1. Check RPC health: `curl $STELLAR_RPC_URL/health`
2. Verify network: `ping <rpc-hostname>`
3. Check logs for specific error (connection refused, timeout, 503)
4. Switch to backup RPC if available

### "Duplicate events in database"

**Cause**: Unique constraint not working or migration didn't apply.

**Fix**:
1. Check migration status: `npm run migrate:check`
2. Verify constraint exists:
   ```sql
   \d ingested_events
   -- Should show: idx_ingested_events_identity UNIQUE (ledger, tx_hash, event_index)
   ```
3. If missing, re-run migration: `npm run migrate`

### "Indexer stuck at ledger N"

**Cause**: Event handler throwing for a specific event.

**Fix**:
1. Check logs for "Failed to process" errors
2. Query checkpoint for that ledger:
   ```sql
   SELECT * FROM ledger_checkpoints WHERE ledger = N;
   ```
3. If `failed_count > 0`, identify the failing event:
   ```sql
   SELECT * FROM ingested_events WHERE ledger = N ORDER BY created_at DESC;
   ```
4. Fix event handler or skip ledger with partial replay

### "Contract fixture test failing"

**Cause**: Contract method signature changed.

**Fix**:
1. Read error message — shows which fixture and expected vs actual
2. Check contract code for signature change
3. Update SDK client method to match
4. Update fixture encoding in `contractFixtures.test.ts`
5. Update assertion to expect new values
6. Document in CHANGELOG.md as breaking change

---

## Key Files

| File | Purpose |
|------|---------|
| `indexer/src/indexer.ts` | Main polling loop, backoff logic, event ingestion |
| `indexer/src/db/schema.sql` | Database schema (includes new constraints) |
| `indexer/src/db/migrations/003_event_dedup_constraints.sql` | Issue 28 migration |
| `sdk/src/__tests__/contractFixtures.test.ts` | Issue 30 fixtures |
| `indexer/src/backoff.test.ts` | Issue 29 backoff tests |
| `indexer/src/eventIdentity.test.ts` | Issue 28 identity tests |
| `docs/INDEXER_RELIABILITY.md` | Comprehensive design doc |
| `sdk/CONTRACT_FIXTURES.md` | Fixture maintenance guide |

---

## Deployment Checklist

### Pre-Deploy

- [ ] All tests pass: `npm test --workspaces`
- [ ] Migrations ready: `cd indexer && npm run migrate:check`
- [ ] Code review approved
- [ ] CHANGELOG.md updated
- [ ] Config verified (env vars match expected values)

### Deploy

1. **Stop Indexer**:
   ```bash
   # Graceful shutdown (waits for in-flight poll)
   kill -TERM <indexer-pid>
   ```

2. **Deploy Code**:
   ```bash
   git pull origin main
   npm install --workspaces
   npm run build --workspaces
   ```

3. **Run Migrations**:
   ```bash
   cd indexer
   npm run migrate
   npm run migrate:check  # Should exit 0
   ```

4. **Start Indexer**:
   ```bash
   npm run start
   ```

5. **Verify**:
   ```bash
   # Health check
   curl http://localhost:3001/health
   
   # Check last ledger advancing
   watch -n 5 "psql $DATABASE_URL -c 'SELECT last_ledger, updated_at FROM indexer_state'"
   ```

### Post-Deploy

- [ ] Indexer is polling (logs show "Processed ledgers X-Y")
- [ ] No duplicate events (monitoring query returns 0 rows)
- [ ] Backoff is not triggered (no "consecutive failures" warnings)
- [ ] Lag < 100 ledgers
- [ ] Failed event count is 0 or acceptable

---

## Rollback Plan

If issues arise after deploy:

1. **Stop Indexer**:
   ```bash
   kill -TERM <indexer-pid>
   ```

2. **Revert Code**:
   ```bash
   git checkout <previous-commit>
   npm install --workspaces
   npm run build --workspaces
   ```

3. **Rollback Migration** (if needed):
   ```sql
   -- Remove new constraint
   DROP INDEX IF EXISTS idx_ingested_events_identity;
   
   -- Remove new column (optional — safe to leave)
   ALTER TABLE ingested_events DROP COLUMN IF EXISTS event_index;
   ```

4. **Restart Indexer**:
   ```bash
   npm run start
   ```

5. **Verify**:
   - Indexer resumes from last cursor
   - No errors in logs
   - Lag is stable

---

## Support

### Documentation

- **Design**: `docs/INDEXER_RELIABILITY.md`
- **Fixtures**: `sdk/CONTRACT_FIXTURES.md`
- **Summary**: `IMPLEMENTATION_SUMMARY.md`
- **Changelog**: `CHANGELOG.md`

### Tests

- **Run all**: `npm test --workspaces`
- **Run one**: `npm test -- <filename> --run`
- **Watch mode**: `npm test -- <filename>` (omit --run)

### Debugging

- **Enable debug logs**: `LOG_LEVEL=debug npm run start`
- **Inspect event**: `psql $DATABASE_URL -c "SELECT * FROM ingested_events WHERE event_key = '...';"`
- **Check backoff**: Look for "consecutive failures" in logs
- **Verify constraint**: `\d ingested_events` in psql

---

## Success Criteria

After deployment, the indexer should:

✅ Resume from the last indexed ledger (no skipped events)  
✅ Handle RPC failures gracefully (backoff, no hot loop)  
✅ Reject duplicate events silently (ON CONFLICT DO NOTHING)  
✅ Produce zero duplicate events in the database  
✅ Advance `last_ledger` continuously (no stuck state)  
✅ Log structured warnings only at exponential intervals  
✅ Pass all contract fixture tests (SDK-contract compatibility)

---

## Contact

For questions or issues:

1. Check documentation (links above)
2. Search logs for error context
3. Run diagnostic queries (monitoring section)
4. File issue with reproduction steps
