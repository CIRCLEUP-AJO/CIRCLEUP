-- Migration 001: add round_deadline_ledgers to circles
--
-- round_deadline_ledgers: the number of ledgers per round as configured at
-- circle creation time (~5 s/ledger on Stellar, so 30 days ≈ 518_400 ledgers).
-- NULL on rows created before this migration; those circles will fall back to
-- the "deadline unknown" display state in the UI.

ALTER TABLE circles
  ADD COLUMN IF NOT EXISTS round_deadline_ledgers BIGINT;
