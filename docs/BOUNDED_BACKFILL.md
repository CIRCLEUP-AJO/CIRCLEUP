# Bounded indexer catch-up and recovery

Normal polling and recovery after approved replay use the same serial pipeline and durable database cursor. START_LEDGER applies only when the cursor is zero. Replay preparation remains an explicit operation and does not itself fetch historical events.

| Setting | Default | Hard maximum | Meaning |
| --- | ---: | ---: | --- |
| BACKFILL_MAX_LEDGERS | 100 | 10000 | Ledger span per poll |
| BACKFILL_MAX_EVENTS | 10000 | 100000 | Total events across all filters |
| BACKFILL_MAX_PAGES | 100 | 1000 | RPC pages per filter |

All new settings require positive safe integers. EVENTS_LIMIT retains its existing validated page bound. Concurrency is fixed at one. Circle filters use five contract IDs at most per request, serially. Poll ticks do not overlap. All fetches finish before ledger writes begin. A failed page, stalled cursor, invalid ledger range or exhausted budget fails instead of returning partial data. A budget error halves the range and retries. If one ledger exceeds the budget, ingestion stops without skipping it; increase bounded allowances only after checking provider limits.

Each ledger commits projection writes, dedup rows, failure evidence and checkpoint atomically through processLedger. Trailing empty ledgers use the same checkpoint transaction. Shutdown is checked before fetches and between ledgers; an active transaction finishes atomically. Restart reads indexer_state from the database. Committed events are deduplicated; transient database errors roll their ledger back. Existing permanent-event quarantine remains visible through /indexer/failures.

/indexer/health includes backfill durableLedger, observed headLedger, attempted range, remainingLedgers, estimatedBatches, caps and concurrency. /indexer/state remains the authoritative durable cursor, including after failure. Estimates are snapshots, not event-volume estimates or completion-time predictions; adaptive shrinking can increase batch counts. No wallet identity or payload is added to progress logs.

Suggested initial settings, not benchmarks: local 20 ledgers / 1000 events / 10 pages; staging 100 / 10000 / 100; production begin with staging settings and reduce spans under quota pressure. Existing pool and statement timeouts remain applicable. No provider quota or historical volume has been measured here. Verify provider retention before recovery; do not move the cursor forward to conceal missing history. Monitor lag, failures, API latency and DB connections before raising caps.
