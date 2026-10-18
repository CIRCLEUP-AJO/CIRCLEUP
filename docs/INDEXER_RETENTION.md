# Indexer Retention and Archival

## Policy

Automatic pruning is disabled and must remain disabled. Keep all indexed
history online for API reads, reconciliation, incident investigation, and
replay preparation until an archive format and restore path for raw event
payloads has been implemented and validated.

The Stellar ledger is the canonical source of contract events. The current
indexer stores projections and an `ingested_events` identity/dedup record, but
does **not** persist the complete Soroban event payload. Rebuilding projections
therefore requires an RPC endpoint that still serves the requested ledger
range. A database backup is a restorable projection snapshot; it is not a
substitute for raw canonical event payloads when the RPC has pruned history.

## Online data classes

| Data | Current role | Retention requirement |
|---|---|---|
| Soroban ledger events | Canonical source for circle creation, membership, contributions, payouts, defaults, lifecycle, and reputation changes | Retained by the network/RPC according to its own policy. Check the RPC's oldest available ledger before replay. No local payload archive currently exists. |
| `circles`, `circle_members`, `contributions`, `payouts`, `defaults`, `reputation`, `circle_audit_events` | Derived state and user-visible API history | Keep online. Do not prune or compact while these API routes are supported. Rebuild only from a complete source range. |
| `ingested_events` | Derived identity/dedup ledger; contains no full event payload | Keep online for duplicate protection and replay operations. Never delete independently of a reviewed replay plan. |
| `ledger_checkpoints`, `indexer_state` | Cursor, per-ledger processing evidence, and recovery state | Keep online and include in every backup. |
| `event_failures` | Payload-free operational evidence for failed event processing | Keep online until resolved or acknowledged and included in incident/backup procedures. It does not make the failed event replayable if RPC history expires. |
| `schema_migrations` | Applied schema and migration integrity metadata | Keep online; do not edit or prune by hand. |

## Measure growth

There is no representative production database in the repository, so no
absolute growth rate is assumed. Before sizing an operator's database, capture
the following at least daily over a representative seven-day period, including
normal activity and a busy period. Record the database size, per-table size,
row counts, and checkpoint ledger span with the observation timestamp.

```sql
SELECT now() AS measured_at,
       current_database() AS database_name,
       pg_database_size(current_database()) AS database_bytes;

SELECT relname AS table_name,
       pg_total_relation_size(relid) AS total_bytes,
       pg_relation_size(relid) AS heap_bytes,
       n_live_tup AS estimated_rows
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

SELECT MIN(ledger) AS first_checkpoint,
       MAX(ledger) AS last_checkpoint,
       COUNT(*) AS checkpoint_rows,
       SUM(events_count) AS events_processed,
       SUM(failed_count) AS events_failed
FROM ledger_checkpoints;
```

Estimate the observed daily growth as the change in `database_bytes` divided
by elapsed days. Estimate monthly capacity as daily growth times 30, with
separate headroom for index growth, temporary replay writes, backups, and
restore workspace. `n_live_tup` is an estimate; use exact `COUNT(*)` for a
table when an audit requires exact row counts. Preserve the measurements with
the deployment record and revisit sizing when event volume or schema changes.

## Archive and verify

Until a raw-event archive is implemented, archives are full Postgres backups
for restore and operational recovery only. Do not represent them as sufficient
for replay beyond the configured RPC retention window.

1. Take a consistent custom-format `pg_dump` using the procedure in
   [`RUNBOOK.md`](./RUNBOOK.md#backup). Include all tables, migrations,
   checkpoints, cursor, and event-failure rows.
2. Write a SHA-256 sidecar for each completed dump and store both files
   off-host with the dump timestamp, database/schema version, chain/network,
   and `indexer_state.last_ledger` recorded in the archive manifest.
3. Verify the checksum and `pg_restore --list` before declaring the archive
   usable. An upload alone is not a successful archive.
4. Restore to an isolated database using
   [`RUNBOOK.md`](./RUNBOOK.md#restore-drill--isolated-target), apply only
   reviewed migrations, run migration health checks, and smoke-test normal API
   reads for circle lists, circle details, event history, and reputation.
5. Record the restore result and duration. Do not prune online rows or delete
   source material based only on a successful dump/checksum; the isolated
   restore and API checks must pass first.

For future raw-event archives, require stable network/contract identity,
ledger/transaction/event ordering, the complete original event payload, and a
versioned encoding. The archive must have a manifest with ledger bounds, row
counts, and a cryptographic checksum; a restore test must replay that range
into an isolated database and compare projections and event identities before
any retention change is considered.

## Replay and operator controls

The replay CLI is intentionally explicit and confirmation-gated. Run its
read-only preflight, verify that the requested starting ledger is available
from the RPC, and keep the indexer stopped during destructive preparation as
required by the replay procedure. `full` and `partial` replay modes delete
derived rows and dedup records in their selected ranges; neither is a retention
or archival command.

If the RPC's oldest available ledger is later than the needed replay start and
there is no validated raw-event archive for the missing range, that replay is
unsupported. Restore a verified database snapshot or recover a complete source
archive first. Do not advance the cursor, clear `ingested_events`, or prune
projections to conceal the missing history.