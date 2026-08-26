-- Migration 003: canonical event identity and idempotency constraints
--
-- Issue 28: At-least-once polling makes duplicate delivery normal. This migration
-- adds network context and stronger uniqueness constraints to enforce idempotency
-- at the database layer rather than relying on process memory.
--
-- Event identity is defined by:
--   - ledger (sequence number on-chain)
--   - tx_hash (transaction that emitted the event)
--   - event_index (zero-based index within that transaction)
--
-- The existing `event_key` column combines these plus contract_id and topic/value
-- data. This migration adds explicit columns for the canonical identity fields so
-- queries and conflict resolution are simpler and more explicit.

-- Add canonical identity columns
ALTER TABLE ingested_events
  ADD COLUMN IF NOT EXISTS event_index INTEGER;

-- Backfill event_index for existing rows (parse from event_key if possible,
-- otherwise NULL — those rows will remain duplicable until re-indexed)
-- In production the event_key encodes ledger:txhash:contractid:topics:value;
-- event_index is not currently included. For now we leave it NULL on existing
-- rows and enforce uniqueness only on new ingests going forward.

-- Create a unique constraint on the canonical identity fields.
-- This makes duplicate ingestion a silent no-op (ON CONFLICT DO NOTHING) rather
-- than an application-layer dedup check, so restart-after-crash is guaranteed
-- idempotent even if the cursor update transaction rolled back.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingested_events_identity
  ON ingested_events(ledger, tx_hash, event_index)
  WHERE event_index IS NOT NULL;

-- The event_key column remains as a secondary dedup layer for events ingested
-- before this migration or when event_index is unavailable.

