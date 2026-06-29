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

CREATE TABLE IF NOT EXISTS indexer_state (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    last_ledger     BIGINT NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed indexer state row
INSERT INTO indexer_state (id, last_ledger) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_circle_members_address ON circle_members(member_address);
CREATE INDEX IF NOT EXISTS idx_contributions_member ON contributions(member_address);
CREATE INDEX IF NOT EXISTS idx_payouts_recipient ON payouts(recipient);
CREATE INDEX IF NOT EXISTS idx_defaults_member ON defaults(member_address);
