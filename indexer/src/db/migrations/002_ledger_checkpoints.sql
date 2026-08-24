-- Migration 002: per-ledger checkpoint table for crash-recovery and gap tracking.
--
-- ledger_checkpoints records the outcome of each ledger's event batch so the
-- indexer can resume from the last durable boundary rather than restarting the
-- full poll range on crash or restart.  The same DDL is present in schema.sql
-- (CREATE TABLE IF NOT EXISTS) so both fresh installs and live upgrades work.

CREATE TABLE IF NOT EXISTS ledger_checkpoints (
    ledger          BIGINT PRIMARY KEY,
    events_count    INTEGER NOT NULL DEFAULT 0,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_checkpoints_ledger
    ON ledger_checkpoints(ledger DESC);
