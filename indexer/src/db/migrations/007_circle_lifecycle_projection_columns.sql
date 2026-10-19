-- Migration 007: circles — pause / close projection columns
--
-- Issue: audit lifecycle events for complete indexer reconstruction.
--
-- The circle/paused, circle/resumed and circle/closed handlers write three
-- columns on `circles` that no earlier migration (nor schema.sql) created:
--
--   paused          — TRUE between circle/paused and circle/resumed.
--   total_released  — circle/closed `total_released` (USDC stroops).
--   close_reason    — circle/closed `reason` ('completed' | 'cancelled').
--
-- Without them every pause, resume and close event failed with SQLSTATE 42703
-- (undefined column), was skipped as a permanent failure, and the circle's
-- history silently missed those transitions.  After applying this migration,
-- recover the skipped events with:
--
--   npm run replay --workspace=indexer -- --retry-failed
--
-- Idempotent: ADD COLUMN IF NOT EXISTS with defaults is safe on a live table.

ALTER TABLE circles
  ADD COLUMN IF NOT EXISTS paused          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS total_released  NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS close_reason    TEXT    NULL;
