-- Deterministic history paging, including tied ledger/time values.
CREATE INDEX IF NOT EXISTS contributions_circle_history_idx ON contributions (circle_address, ledger, id);
CREATE INDEX IF NOT EXISTS defaults_circle_history_idx ON defaults (circle_address, ledger, id);
CREATE INDEX IF NOT EXISTS payouts_circle_history_idx ON payouts (circle_address, ledger, id);
CREATE INDEX IF NOT EXISTS circle_audit_history_idx ON circle_audit_events (circle_address, created_at, id);
CREATE INDEX IF NOT EXISTS member_contribution_history_idx ON contributions (member_address, ledger DESC, round_index DESC, created_at DESC, id DESC);
