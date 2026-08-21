-- Migration 002: per-ledger ingest checkpoint table
--
-- ledger_checkpoints records the outcome of processing each Stellar ledger so
-- the indexer can resume from the last durably committed ledger boundary after
-- a crash or restart, and so operators can identify and replay failing ledger
-- ranges without manual DB surgery.
--
-- status values:
--   'completed'  — all events for this ledger were atomically committed
--   'failed'     — the ledger transaction was rolled back; no events committed
--   'replayed'   — a previously failed/completed ledger was re-processed

CREATE TABLE IF NOT EXISTS ledger_checkpoints (
    ledger          BIGINT PRIMARY KEY,
    status          TEXT NOT NULL,
    events_seen     INTEGER NOT NULL DEFAULT 0,
    events_ingested INTEGER NOT NULL DEFAULT 0,
    events_failed   INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial index on non-completed rows only — the common health-check query
-- ("are there any failed ledgers?") scans only this small slice.
CREATE INDEX IF NOT EXISTS idx_ledger_checkpoints_status
    ON ledger_checkpoints(status)
    WHERE status != 'completed';
