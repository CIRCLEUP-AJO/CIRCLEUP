-- CircleUp Indexer Schema

CREATE TABLE IF NOT EXISTS circles (
    id              SERIAL PRIMARY KEY,
    address         TEXT NOT NULL UNIQUE,
    creator         TEXT NOT NULL,
    round_amount    NUMERIC NOT NULL,        -- in stroops
    member_count    INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'Pending',
    current_round   INTEGER NOT NULL DEFAULT 0,
    total_rounds    INTEGER NOT NULL,
    created_ledger  BIGINT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS circle_members (
    id              SERIAL PRIMARY KEY,
    circle_address  TEXT NOT NULL REFERENCES circles(address),
    member_address  TEXT NOT NULL,
    payout_order    INTEGER NOT NULL,        -- 0-indexed position in rotation
    collateral      NUMERIC NOT NULL DEFAULT 0,
    defaults        INTEGER NOT NULL DEFAULT 0,
    joined_at       TIMESTAMPTZ,
    UNIQUE(circle_address, member_address)
);

CREATE TABLE IF NOT EXISTS contributions (
    id              SERIAL PRIMARY KEY,
    circle_address  TEXT NOT NULL REFERENCES circles(address),
    member_address  TEXT NOT NULL,
    round_index     INTEGER NOT NULL,
    amount          NUMERIC NOT NULL,
    tx_hash         TEXT NOT NULL,
    ledger          BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(circle_address, member_address, round_index)
);

CREATE TABLE IF NOT EXISTS payouts (
    id              SERIAL PRIMARY KEY,
    circle_address  TEXT NOT NULL REFERENCES circles(address),
    recipient       TEXT NOT NULL,
    round_index     INTEGER NOT NULL,
    amount          NUMERIC NOT NULL,
    tx_hash         TEXT NOT NULL,
    ledger          BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(circle_address, round_index)
);

CREATE TABLE IF NOT EXISTS defaults (
    id              SERIAL PRIMARY KEY,
    circle_address  TEXT NOT NULL REFERENCES circles(address),
    member_address  TEXT NOT NULL,
    round_index     INTEGER NOT NULL,
    penalty         NUMERIC NOT NULL,
    tx_hash         TEXT NOT NULL,
    ledger          BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reputation (
    member_address  TEXT PRIMARY KEY,
    score           INTEGER NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingested_events (
    event_key       TEXT PRIMARY KEY,
    contract_id     TEXT,
    ledger          BIGINT NOT NULL,
    tx_hash         TEXT,
    event_type      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indexer_state (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    last_ledger     BIGINT NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed indexer state row
INSERT INTO indexer_state (id, last_ledger) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Per-ledger checkpoint written atomically with each ledger's event batch.
-- Enables crash recovery at ledger boundaries and gap/stall visibility.
CREATE TABLE IF NOT EXISTS ledger_checkpoints (
    ledger          BIGINT PRIMARY KEY,
    events_count    INTEGER NOT NULL DEFAULT 0,
    failed_count    INTEGER NOT NULL DEFAULT 0,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tracks which files under src/db/migrations/ have been applied, so
-- migrate.ts can report schema version/status and skip re-applying files.
-- Defined here (rather than only in migrate.ts) so the schema's version
-- history lives next to the rest of the schema definition.
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename        TEXT PRIMARY KEY,
    applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_circle_members_address ON circle_members(member_address);
CREATE INDEX IF NOT EXISTS idx_contributions_member ON contributions(member_address);
CREATE INDEX IF NOT EXISTS idx_payouts_recipient ON payouts(recipient);
CREATE INDEX IF NOT EXISTS idx_defaults_member ON defaults(member_address);

-- Supports the GROUP BY event_type aggregate used by the indexer state audit
-- query (GET /indexer/state in api.ts).
CREATE INDEX IF NOT EXISTS idx_ingested_events_event_type ON ingested_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ledger_checkpoints_ledger ON ledger_checkpoints(ledger DESC);

-- circles.created_ledger: GET /circles orders the full circle list by this
-- column (see api.ts). circle_members(circle_address, payout_order) and
-- contributions/defaults(circle_address, ...) support the circle-detail
-- endpoints, which filter by circle_address and then sort by round/payout
-- order — the (address, member_address) unique constraint on circle_members
-- already covers equality on circle_address alone, but not the ORDER BY, so
-- payout_order is added as a second column here to avoid a sort step.
-- See src/db/explain.ts to re-verify these plans (`npm run explain --workspace=indexer`).
CREATE INDEX IF NOT EXISTS idx_circles_created_ledger ON circles(created_ledger DESC);
CREATE INDEX IF NOT EXISTS idx_circle_members_circle_address ON circle_members(circle_address, payout_order);
CREATE INDEX IF NOT EXISTS idx_contributions_circle_round ON contributions(circle_address, round_index, created_at);
CREATE INDEX IF NOT EXISTS idx_defaults_circle_address ON defaults(circle_address, round_index);
