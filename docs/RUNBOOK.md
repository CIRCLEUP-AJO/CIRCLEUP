# CircleUp Operational Runbook

This document is the primary operational and contributor reference for the full CircleUp stack. It covers architecture, local development, deployment, environment configuration, data flow, troubleshooting, and common failure recovery procedures.

For the SDK API reference and contract invariants see [README.md](../README.md).

---

## Table of Contents

- [System Overview](#system-overview)
- [Architecture Diagram](#architecture-diagram)
- [Component Responsibilities](#component-responsibilities)
  - [Soroban Contracts](#soroban-contracts)
  - [TypeScript SDK](#typescript-sdk)
  - [Indexer](#indexer)
  - [Frontend App](#frontend-app)
- [How the Components Connect](#how-the-components-connect)
- [Local Development Setup](#local-development-setup)
  - [Prerequisites](#prerequisites)
  - [Step-by-Step](#step-by-step)
- [Environment Variables Reference](#environment-variables-reference)
  - [Indexer (`indexer/.env`)](#indexer-indexerenv)
  - [App (`app/.env.local`)](#app-appenvlocal)
- [Deployment](#deployment)
  - [Contract Deployment Order](#contract-deployment-order)
  - [Post-Deployment Configuration](#post-deployment-configuration)
  - [Updating the App and Indexer](#updating-the-app-and-indexer)
- [Database Operations](#database-operations)
  - [Running Migrations](#running-migrations)
  - [Checking Schema Health](#checking-schema-health)
  - [Re-indexing from a Given Ledger](#re-indexing-from-a-given-ledger)
- [Database Backup and Restore](#database-backup-and-restore)
  - [Backup](#backup)
  - [Restore](#restore)
  - [Post-restore verification](#post-restore-verification)
  - [Applying migrations after restore](#applying-migrations-after-restore)
  - [When to use chain replay instead of restore](#when-to-use-chain-replay-instead-of-restore)
  - [Rollback guidance](#rollback-guidance)
- [Health Checks and Monitoring](#health-checks-and-monitoring)
  - [Indexer Health Endpoint](#indexer-health-endpoint)
  - [Indexer Audit Endpoint](#indexer-audit-endpoint)
  - [Useful Monitoring Queries](#useful-monitoring-queries)
- [Troubleshooting](#troubleshooting)
  - [App shows "indexer unreachable" banner](#app-shows-indexer-unreachable-banner)
  - [Circle list is empty but circles exist on-chain](#circle-list-is-empty-but-circles-exist-on-chain)
  - [Circle detail page shows 404](#circle-detail-page-shows-404)
  - [Reputation page shows no data](#reputation-page-shows-no-data)
  - [My Reputation link in the nav is greyed out](#my-reputation-link-in-the-nav-is-greyed-out)
  - [Transaction fails with "USDC transfer failed"](#transaction-fails-with-usdc-transfer-failed)
  - [Indexer keeps restarting with missing env vars](#indexer-keeps-restarting-with-missing-env-vars)
  - [Indexer boot: "SCHEMA WARNING"](#indexer-boot-schema-warning)
  - [Payout fails with "reputation increment failed"](#payout-fails-with-reputation-increment-failed)
  - [mark_default fails with "round deadline not yet passed"](#mark_default-fails-with-round-deadline-not-yet-passed)
  - [App build fails with TypeScript errors](#app-build-fails-with-typescript-errors)
  - [Freighter not detected](#freighter-not-detected)
- [Contract Lifecycle Reference](#contract-lifecycle-reference)
  - [Circle Status Machine](#circle-status-machine)
  - [Round Lifecycle](#round-lifecycle)
  - [Reputation Authorization Flow](#reputation-authorization-flow)
- [Security Notes](#security-notes)
- [Incident Fixtures and Offline Reproduction](#incident-fixtures-and-offline-reproduction)
  - [Fixture Overview](#fixture-overview)
  - [Running the Incident Tests](#running-the-incident-tests)
  - [StaleIndexerData fixture](#staleindexerdata-fixture)
  - [DuplicateEvents fixture](#duplicateevents-fixture)
  - [WalletRejection fixture](#walletrejection-fixture)
  - [RpcTimeout fixture](#rpctimeout-fixture)
  - [SchemaDrift fixture](#schemadrift-fixture)
- [Mutation Testing and Guard Verification](#mutation-testing-and-guard-verification)
  - [Why Mutation Testing](#why-mutation-testing)
  - [Contract Mutation Guards (Rust)](#contract-mutation-guards-rust)
  - [App Gating Mutation Tests (TypeScript)](#app-gating-mutation-tests-typescript)
  - [CI Budget and Excluded Mutations](#ci-budget-and-excluded-mutations)
- [Development Best Practices](#development-best-practices)

---

## System Overview

CircleUp is a trustless Rotating Savings and Credit Association (ROSCA) platform built on Stellar Soroban. It consists of four distinct layers:

| Layer | Package | Language | Role |
|---|---|---|---|
| Smart contracts | `contracts/` | Rust / Soroban SDK 21 | On-chain ROSCA logic, reputation scoring |
| TypeScript SDK | `sdk/` | TypeScript | Typed wrapper around RPC and indexer calls |
| Indexer | `indexer/` | Node.js / Express / Postgres | Polls Soroban events, stores derived state, exposes REST API |
| Frontend | `app/` | Next.js 14 / Tailwind CSS | User-facing interface; reads from indexer, writes via Freighter |

The contracts are the source of truth. The indexer is a derived read-model. The app is a thin presentation layer. The SDK is shared business logic that both the app and deployment scripts use.

---

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                      Stellar Testnet                            │
│                                                                 │
│  ┌──────────────────┐  deploys  ┌─────────────────────────┐   │
│  │  circle_factory  │──────────▶│  circle (per instance)  │   │
│  └──────────────────┘           └─────────────────────────┘   │
│           │                               │                     │
│     registers caller               calls increment              │
│           │                               │                     │
│           ▼                               ▼                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     reputation                            │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
           ▲ Soroban events                  ▲ RPC simulation calls
           │                                 │
┌──────────┴──────────┐          ┌───────────┴──────────┐
│      indexer        │          │         sdk           │
│  Node + Postgres    │          │  TypeScript client    │
│  REST API :3001     │          └──────────────────────┘
└──────────┬──────────┘                    ▲
           │ HTTP JSON                     │ imported by
           ▼                               │
┌──────────────────────────────────────────────────────────────┐
│                    app (Next.js 14)                            │
│  /                 → circle list (fetches from indexer)        │
│  /create           → deploy circle (Freighter + SDK)          │
│  /circles/[addr]   → detail + contribute/payout actions        │
│  /reputation/[m]   → on-chain score + participation history    │
└──────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### Soroban Contracts

Located in `contracts/`. Three contracts, each with a single responsibility:

**`circle_factory`** (`contracts/circle_factory/src/lib.rs`)
- Stores the circle WASM hash, the reputation contract address, and the USDC token address.
- `create_circle` deploys a new circle contract, initializes it, registers it as an authorized reputation caller, and records its address — all atomically in one transaction.
- Maintains `Circles: Vec<Address>` and `CircleCount: u32` which always satisfy `count == circles.len()`.

**`circle`** (`contracts/circle/src/lib.rs`)
- Core ROSCA logic: join, contribute, payout, mark_default, cancel, close.
- Status transitions: `Pending → Active → Completed` or `Pending → Cancelled`.
- Every member must lock `round_amount × COLLATERAL_MULTIPLIER` USDC (currently 1×) to join.
- Round deadline is `round_deadline_ledgers` ledgers after the circle goes Active (last member joins).
- 20% collateral penalty (`PENALTY_BPS = 2000`, `BPS_DENOM = 10000`) for a missed round.
- Calls `reputation.increment(circle_address, member)` after each successful payout.

**`reputation`** (`contracts/reputation/src/lib.rs`)
- Stores per-wallet completed-rounds score as a persistent ledger entry.
- `increment` is gated by an allowlist of authorized callers (circle contracts). Only the factory admin can add or revoke callers.
- Revocation is permanent: a revoked circle can never call `increment` again, even if its address appears again in the allowlist.
- Scores are monotonically increasing; there is no decrement or reset.

### TypeScript SDK

Located in `sdk/`. Published as `@circleup/sdk` within the npm workspace.

- `FactoryClient` — wraps `create_circle` and `get_circles` factory calls.
- `CircleClient` — wraps `join`, `contribute`, `payout`, `mark_default`, `cancel`, `close`, and all read views for a single circle.
- `ReputationClient` — wraps `score` and other reputation views.
- `getNetworkConfig` / `isValidNetwork` — typed network config with RPC URL and passphrase.
- Utility helpers: `usdcToStroops`, `stroopsToUsdc`, `formatUsdc`, `formatPot`, `daysToLedgers`, `shortAddress`.

The app package (`app/`) uses the SDK indirectly through `app/src/lib/stellar.ts` rather than importing `@circleup/sdk` directly. The `scripts/` package uses the SDK directly for deployment and seeding.

### Indexer

Located in `indexer/`. Runs as a long-lived Node.js process with two responsibilities:

1. **Event polling loop** (`indexer/src/indexer.ts`): polls `getEvents` from the Soroban RPC every `POLL_INTERVAL_MS` milliseconds (default 5 000ms), starting from `START_LEDGER`. Writes circle, member, contribution, payout, default, and reputation rows into Postgres. Uses an `ingested_events` dedup table keyed on `(tx_hash, event_index)` so replaying from the same ledger is idempotent.

2. **REST API** (`indexer/src/api.ts`): Express server on port `PORT` (default 3001). All endpoints are read-only queries against Postgres. The only stateful operations (migrations, replay) are run separately as CLI scripts, not through the API.

Database schema is in `indexer/src/db/schema.sql`. Migrations are versioned SQL files in `indexer/src/db/migrations/`.

### Frontend App

Located in `app/`. Next.js 14 App Router with Server Components for data fetching and Client Components for wallet interactions.

Key patterns:
- Server Components fetch from the indexer at render time with `cache: "no-store"`. The `cache()` wrapper in `app/src/app/page.tsx` collapses multiple calls within one render into a single request.
- All contract interactions go through `app/src/lib/stellar.ts` which wraps Freighter and the Soroban RPC.
- Wallet state is read on the client inside `useEffect` — never on the server — to avoid SSR/hydration mismatches.
- The `WalletRepLink` component in the nav reads the connected wallet address and links to `/reputation/[address]`.

---

## How the Components Connect

### Creating a circle (write path)

```
User fills /create form
  → CreateClient.tsx collects members, amount, deadline
  → invokeContract("create_circle", ...) in stellar.ts
  → Freighter signs the transaction
  → circle_factory.create_circle() on Soroban RPC:
      ├─ deploys circle WASM at deterministic address
      ├─ calls circle.initialize(...)
      └─ calls reputation.add_authorized_caller(circle_address)
  → Soroban emits factory/circle_created event
  → indexer polls event → writes row to circles table
  → /circles page fetches from indexer REST API → renders CircleCard
```

### Contributing and triggering payout (write path)

```
Member clicks "Contribute Round N"
  → CircleDetailClient invokes circle.contribute(member) via Freighter
  → circle stores Contributed(member, round_index) in persistent storage
  → Soroban emits circle/contributed event
  → (once all members contributed) anyone clicks "Trigger Payout"
  → circle.payout() transfers pot to recipient, calls reputation.increment
  → Soroban emits circle/payout and reputation/score_updated events
  → indexer processes events → updates contributions, payouts, reputation tables
  → page refetches from indexer → UI reflects new state
```

### Reading circle state (read path)

```
Browser navigates to /circles/[address]
  → CircleDetailPage (Server Component) fetches:
      GET /circles/:address          → circle row + members + latest ledger
      GET /circles/:address/rounds   → payouts + contributions + pending defaults
  → If indexer returns 404 → Next.js notFound() → not-found.tsx rendered
  → If fetch succeeds → CircleDetailClient (Client Component) hydrated with data
  → Client-side effects read wallet address from Freighter for action gating
```

### Reputation lookup (read path)

```
User navigates to /reputation/[address]
  → ReputationPage (Server Component) passes address to ReputationClient
  → ReputationClient (Client Component) fetches:
      GET /reputation/:member → score + per-circle contributions + defaults
  → Renders score card, participation table, defaults table
```

---

## Local Development Setup

### Prerequisites

| Tool | Minimum version | Purpose |
|---|---|---|
| Node.js | 18 | Frontend, indexer, scripts |
| npm | 9 | Workspace management |
| Rust (stable toolchain) | 1.75 | Compile Soroban contracts |
| stellar-cli | latest | Deploy contracts to testnet |
| Docker | any | Postgres via docker compose |
| Freighter | browser extension | Wallet for the web UI |

Install stellar-cli:
```bash
cargo install --locked stellar-cli --features opt
```

### Step-by-Step

**1. Clone and install**

```bash
git clone https://github.com/CIRCLEUP-AJO/CIRCLEUP
cd CIRCLEUP
npm install
```

**2. Start Postgres**

```bash
docker compose up -d
# Wait for the healthcheck: docker compose ps should show "healthy"
```

**3. Configure the indexer**

```bash
cp indexer/.env.example indexer/.env
# Edit indexer/.env — fill in CIRCLE_FACTORY_ADDRESS, REPUTATION_ADDRESS, USDC_ADDRESS
# Leave DATABASE_URL as-is if you are using docker compose defaults
```

**4. Run database migrations**

```bash
npm run migrate
# Equivalent to: npm run migrate:dev --workspace=indexer
# Creates all tables defined in indexer/src/db/schema.sql
```

**5. Configure the app**

```bash
cp app/.env.example app/.env.local
# Edit app/.env.local — paste the same contract addresses with NEXT_PUBLIC_ prefix
# NEXT_PUBLIC_INDEXER_URL defaults to http://localhost:3001 — leave as-is for local dev
```

**6. Start the indexer**

```bash
npm run dev:indexer
# Output: "Indexer API listening on http://0.0.0.0:3001"
# The indexer will start polling from START_LEDGER (0 by default = genesis)
# On a fresh testnet deployment set START_LEDGER to your deployment ledger to skip history
```

**7. Start the frontend**

```bash
npm run dev:app
# Open http://localhost:3000
```

**8. (Optional) Seed the demo circle**

```bash
npm run seed:demo
# Creates a 4-member $100/round testnet circle
# Runs through Round 1 (all contribute → Alice receives $400)
# Simulates Round 2 default for Dave
```

**Running both simultaneously:**

```bash
npm run dev
# Starts indexer and app in parallel (indexer & app)
# On Windows use two separate terminals instead
```

---

## Environment Variables Reference

### Indexer (`indexer/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Postgres connection string, e.g. `postgresql://postgres:password@localhost:5432/circleup` |
| `STELLAR_RPC_URL` | Yes | — | Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org` |
| `CIRCLE_FACTORY_ADDRESS` | Yes | — | Deployed factory contract ID (`C...`) |
| `REPUTATION_ADDRESS` | Yes | — | Deployed reputation contract ID (`C...`) |
| `USDC_ADDRESS` | Yes | — | USDC token contract ID (`C...`) |
| `NETWORK_PASSPHRASE` | No | `Test SDF Network ; September 2015` | Stellar network passphrase |
| `PORT` | No | `3001` | API server port |
| `START_LEDGER` | No | `0` | Ledger to start indexing from. Set to your deployment ledger to skip testnet genesis |
| `POLL_INTERVAL_MS` | No | `5000` | How often to poll the RPC for new events (milliseconds) |
| `EVENTS_LIMIT` | No | `100` | Max events per `getEvents()` call. Soroban RPC caps at 10 000 |
| `ALLOWED_ORIGINS` | No | *(all origins)* | Comma-separated CORS allow-list, e.g. `https://app.circleup.xyz`. Leave blank for local dev. Required in production |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | No | `100` | Max requests per IP per window |

All required variables are validated at boot time. The indexer will exit with a clear error message listing every missing key if any are absent or blank.

### App (`app/.env.local`)

| Variable | Required in production | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_STELLAR_RPC_URL` | Yes | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | Yes | `Test SDF Network ; September 2015` | Network passphrase |
| `NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS` | Yes (prod) | *(empty)* | Factory contract ID |
| `NEXT_PUBLIC_REPUTATION_ADDRESS` | Yes (prod) | *(empty)* | Reputation contract ID |
| `NEXT_PUBLIC_USDC_ADDRESS` | Yes (prod) | *(empty)* | USDC token contract ID |
| `NEXT_PUBLIC_INDEXER_URL` | Yes | `http://localhost:3001` | Indexer base URL |

In development, the contract address variables may be left blank — the app will start but contract interactions will fail gracefully. In production (`NODE_ENV=production`) they are required and the server will throw at boot time if they are missing.

---

## Deployment

### Contract Deployment Order

Contracts must be deployed in this exact order due to cross-contract dependencies:

```
1. reputation   — no dependencies; stores admin address
2. circle_factory — depends on reputation address and circle WASM hash
3. (circle instances are deployed by the factory; never manually)
```

Deploy using stellar-cli:

```bash
# Generate a testnet deployer identity (one-time)
stellar keys generate --global deployer --network testnet
stellar keys fund deployer --network testnet

# Deploy all three contracts in one script
npm run deploy:testnet
# Writes contract addresses to scripts/deployed.json
```

The deploy script (`scripts/src/deploy.ts`) handles:
1. Building and uploading the circle WASM to get its hash.
2. Deploying the reputation contract with the deployer as temporary admin.
3. Deploying the factory with the reputation address and circle WASM hash.
4. Transferring admin of the reputation contract to the factory address.

### Post-Deployment Configuration

After deployment, copy the addresses from `scripts/deployed.json` into both env files:

```bash
# scripts/deployed.json contains:
# { "factory": "C...", "reputation": "C...", "usdc": "C..." }

# Indexer
# Edit indexer/.env:
CIRCLE_FACTORY_ADDRESS=C...
REPUTATION_ADDRESS=C...
USDC_ADDRESS=C...

# App
# Edit app/.env.local:
NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS=C...
NEXT_PUBLIC_REPUTATION_ADDRESS=C...
NEXT_PUBLIC_USDC_ADDRESS=C...
```

Set `START_LEDGER` in `indexer/.env` to the ledger number at which the factory was deployed to avoid scanning testnet genesis (which can take hours):

```bash
START_LEDGER=12345678   # replace with the actual deployment ledger
```

### Updating the App and Indexer

The app and indexer are stateless services — update them by restarting with the new code. No special migration is needed unless the indexer schema changed.

If the indexer schema changed (new migration file added):

```bash
npm run migrate          # applies pending migrations
npm run migrate:check    # verify schema is clean before restarting
```

---

## Database Operations

### Running Migrations

```bash
# Development (uses ts-node, does not require a build)
npm run migrate

# Production (requires a compiled build first)
npm run build --workspace=indexer
npm run migrate --workspace=indexer
```

Migrations are numbered SQL files in `indexer/src/db/migrations/`. The runner tracks which files have been applied in a `schema_migrations` table and skips already-applied ones.

### Checking Schema Health

```bash
npm run migrate:check --workspace=indexer
# Exits 0 when the schema is "clean" (all migrations applied, no drift)
# Exits non-zero for: pending, drifted, partial, or uninitialized states
```

Schema states:

| State | Meaning | Action |
|---|---|---|
| `clean` | All migrations applied, no drift | None needed |
| `pending` | New migration files not yet applied | Run `npm run migrate` |
| `drifted` | Applied migrations no longer match files on disk | Investigate — do not re-run blindly |
| `partial` | Some migration files are missing from disk | Restore missing files before continuing |
| `uninitialized` | No `schema_migrations` table at all | Run `npm run migrate` from scratch |

The indexer logs a `SCHEMA WARNING` on boot for `drifted` or `partial` states. The service continues serving data but the warning should be investigated before the next deploy.

### Re-indexing from a Given Ledger

Use the replay CLI when you need to rebuild the indexer database from a specific ledger — for example after a schema migration that adds new derived columns, or after discovering a bug in the event processing logic.

```bash
# Dry-run first to see what would happen
npm run replay:dry-run --workspace=indexer -- --from=12345678

# Full replay from ledger 12345678 (wipes rows from that ledger onward)
npm run replay --workspace=indexer -- --from=12345678

# Partial replay (keep rows from before the given ledger)
npm run replay --workspace=indexer -- --from=12345678 --partial
```

Replay is atomic: it wraps the wipe and cursor reset in a single transaction. If the process is interrupted, the database returns to its pre-replay state and the replay can be retried safely.

**Warning:** a full replay (without `--partial`) deletes all derived table rows from the given ledger onward and resets the indexer cursor. The indexer will then re-ingest all events from that point. During replay the API continues to serve the (now stale) data until the cursor catches up.

---

## Database Backup and Restore

Although the indexer database is a derived read-model that can be fully reconstructed by replaying Soroban events from the deployment ledger, a tested backup and restore path reduces outage time and protects checkpoint correctness.

### Backup

**Frequency:** Daily backups are recommended for production. The indexer's `last_ledger` cursor is stored in the `indexer_state` table — losing it forces a full replay from `START_LEDGER`, which can take minutes to hours depending on chain history.

**Docker Compose (default local setup):**

```bash
# Dump the full database to a timestamped file
docker compose exec -T postgres \
  pg_dump -U postgres circleup \
  > backups/circleup_$(date +%Y%m%d_%H%M%S).sql
```

**External Postgres:**

```bash
pg_dump "$DATABASE_URL" > backups/circleup_$(date +%Y%m%d_%H%M%S).sql
```

Store backups off-host (S3, GCS, etc.). Retain at least 7 daily snapshots.

### Restore

**Stop the indexer before restoring** to prevent it from writing to a partially restored database:

```bash
# 1. Stop the indexer
npm run stop:indexer   # or kill the process

# 2. Drop and recreate the database (Docker Compose)
docker compose exec -T postgres \
  psql -U postgres -c "DROP DATABASE IF EXISTS circleup; CREATE DATABASE circleup;"

# 3. Restore from backup
docker compose exec -T postgres \
  psql -U postgres circleup < backups/circleup_<timestamp>.sql

# 4. Verify migrations are clean
npm run migrate:check --workspace=indexer
# Expected output: Health state: clean

# 5. Restart the indexer
npm run dev:indexer
```

**External Postgres:**

```bash
psql "$DATABASE_URL" < backups/circleup_<timestamp>.sql
npm run migrate:check --workspace=indexer
```

### Post-restore verification

Run these queries to confirm the restore is consistent:

```sql
-- Confirm the indexer cursor was restored
SELECT last_ledger, updated_at FROM indexer_state WHERE id = 1;

-- Confirm circle and member counts are non-zero (for a non-empty deployment)
SELECT COUNT(*) FROM circles;
SELECT COUNT(*) FROM circle_members;

-- Confirm the dedup table is present and non-empty
SELECT COUNT(*) FROM ingested_events;
```

Also check the API:

```bash
curl http://localhost:3001/health
# Expected: { "status": "ok", ... }

curl http://localhost:3001/indexer/state
# Confirm lastLedger matches the value from indexer_state above
```

### Applying migrations after restore

If the backup predates a schema migration, apply pending migrations before restarting the indexer:

```bash
npm run migrate --workspace=indexer
npm run migrate:check --workspace=indexer
# Expected: Health state: clean
```

### When to use chain replay instead of restore

Prefer **chain replay** over a backup restore when:

- No recent backup is available.
- The backup predates a schema migration that changes how events are processed (not just adds columns).
- You suspect the backup contains corrupt or duplicate rows from a failed replay.

To replay from the deployment ledger:

```bash
# Full replay — wipes all derived rows from START_LEDGER onward
npm run replay --workspace=indexer -- --from=<deployment_ledger>
```

See [Re-indexing from a Given Ledger](#re-indexing-from-a-given-ledger) for dry-run and partial replay options.

### Rollback guidance

If a migration or deploy causes data corruption:

1. Stop the indexer immediately.
2. Restore the most recent pre-migration backup (see [Restore](#restore) above).
3. Verify the schema state with `npm run migrate:check`.
4. If the backup is too old, replay from the last known-good ledger using `npm run replay -- --from=<ledger>`.
5. Do **not** re-run a failed migration without first reverting the migration file — the runner will attempt to re-apply it and may produce duplicate or conflicting schema changes.

---

## Health Checks and Monitoring

### Indexer Health Endpoint

```
GET /health
```

Returns 200 when both Postgres and the Soroban RPC are reachable:

```json
{
  "status": "ok",
  "timestamp": "2026-08-23T10:00:00.000Z",
  "db": { "status": "ok", "latencyMs": 2 },
  "rpc": { "status": "ok", "latencyMs": 45 },
  "config": { "usdcAddress": "C..." }
}
```

Returns 503 with `"status": "degraded"` and per-component error details when either component fails. Use this endpoint for load-balancer health checks and uptime monitoring.

The `config.usdcAddress` field lets operators confirm at a glance that the indexer and the app are tracking the same USDC token without cross-referencing env files.

### Indexer Audit Endpoint

```
GET /indexer/state
```

Reports indexing progress independent of connectivity:

```json
{
  "lastLedger": 12350000,
  "updatedAt": "2026-08-23T09:59:55.000Z",
  "totalEvents": 1432,
  "eventCounts": {
    "factory/circle_created": 12,
    "circle/joined": 48,
    "circle/contributed": 360,
    "circle/payout": 36,
    "reputation/score_updated": 36
  }
}
```

Alert when `lastLedger` stops advancing — this indicates the polling loop has stalled (RPC connection lost, process OOM, etc.).

### Useful Monitoring Queries

Run these against the indexer Postgres database for operational checks:

```sql
-- How far behind is the indexer? (compare to current testnet ledger via RPC)
SELECT last_ledger, updated_at FROM indexer_state WHERE id = 1;

-- Circles by status
SELECT status, COUNT(*) FROM circles GROUP BY status ORDER BY status;

-- Members with most defaults (top 10)
SELECT member_address, SUM(defaults) AS total_defaults
FROM circle_members
GROUP BY member_address
ORDER BY total_defaults DESC
LIMIT 10;

-- Recent payouts
SELECT circle_address, recipient, amount, tx_hash, created_at
FROM payouts
ORDER BY created_at DESC
LIMIT 20;

-- Dedup table size (events processed)
SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM ingested_events;

-- Circles with pending contributions (active circles where round not yet paid)
SELECT c.address, c.current_round, c.total_rounds,
       COUNT(cm.member_address) AS member_count,
       (SELECT COUNT(*) FROM contributions co
        WHERE co.circle_address = c.address AND co.round_index = c.current_round) AS contributions_in
FROM circles c
JOIN circle_members cm ON cm.circle_address = c.address
WHERE c.status = 'Active'
GROUP BY c.address, c.current_round, c.total_rounds;
```

---

## Troubleshooting

### App shows "indexer unreachable" banner

**Symptom:** The home page renders the "Circles list unavailable" amber banner and the circle count shows nothing.

**Diagnosis:**
1. Check the indexer process is running: `curl http://localhost:3001/health`
2. Check `NEXT_PUBLIC_INDEXER_URL` in `app/.env.local` — must be a valid absolute URL (`http://` or `https://`).
3. Check for CORS issues if the app and indexer are on different origins in production: ensure `ALLOWED_ORIGINS` in `indexer/.env` includes the app's origin.

**Resolution:**
- Start the indexer: `npm run dev:indexer`
- Fix the `NEXT_PUBLIC_INDEXER_URL` value and restart the Next.js dev server.
- Add the app origin to `ALLOWED_ORIGINS` in `indexer/.env` and restart the indexer.

---

### Circle list is empty but circles exist on-chain

**Symptom:** No circles appear in the app but you can see them via stellar-cli or stellar.expert.

**Diagnosis:**
1. Check indexer state: `curl http://localhost:3001/indexer/state` — is `lastLedger` advancing?
2. Check `START_LEDGER` in `indexer/.env` — if it is set to a ledger *after* the factory deployment, those events were skipped.
3. Check `CIRCLE_FACTORY_ADDRESS` in `indexer/.env` — a wrong or empty address means `getEvents` returns nothing silently.

**Resolution:**
- Set `START_LEDGER` to the ledger at or before the factory was deployed and restart.
- Fix `CIRCLE_FACTORY_ADDRESS` and replay from the correct ledger: `npm run replay -- --from=<deployment_ledger>`

---

### Circle detail page shows 404

**Symptom:** Navigating to `/circles/[address]` renders the "Page not found" page.

**Cause:** The circle exists on-chain but the indexer has not yet processed the `factory/circle_created` event. This is normal for circles created very recently (within the last `POLL_INTERVAL_MS` milliseconds).

**Resolution:**
- Wait a few seconds and refresh. The indexer will process the event on the next poll.
- If the 404 persists after 60 seconds, check `GET /indexer/state` to confirm the indexer is advancing. Also verify the circle address is correct — copy it from the transaction receipt in stellar.expert.

---

### Reputation page shows no data

**Symptom:** `/reputation/[address]` shows "No reputation record found."

**Cause:** This is not an error. It means the address has no `reputation/score_updated` events in the indexer database. The member has not yet completed a full payout round in any circle.

**If reputation should exist:**
1. Check `REPUTATION_ADDRESS` in `indexer/.env` matches the deployed contract.
2. Check the `reputation` table in Postgres directly:
   ```sql
   SELECT * FROM reputation WHERE member_address = '<address>';
   ```
3. If the row is missing but you know a payout occurred, replay from the payout ledger.

---

### My Reputation link in the nav is greyed out

**Symptom:** The "My Reputation" nav item appears muted and is not clickable.

**Cause:** This is expected when no Freighter wallet is connected. The `WalletRepLink` component reads the wallet address client-side; until Freighter returns an address the link renders as a disabled span to avoid pointing to a broken URL.

**Resolution:** Connect your Freighter wallet using the "Connect Wallet" button in the top-right of the nav.

---

### Transaction fails with "USDC transfer failed"

**Symptom:** Calling `join`, `contribute`, `payout`, or `close` returns an error containing "USDC transfer failed during ...".

**Possible causes and fixes:**

| Sub-message | Cause | Fix |
|---|---|---|
| `join collateral deposit` | Member's USDC balance is less than `round_amount` | Fund the wallet with testnet USDC via Friendbot or a faucet |
| `round contribution` | Member's balance dropped below `round_amount` since joining | Same as above |
| `round payout` | Circle contract's USDC balance is insufficient (should not happen normally) | Check for missing contributions — call `get_current_round` to verify `contributions_received` |
| `collateral release` | Token frozen, deauthorized, or missing trustline | Check the member's USDC trustline on stellar.expert |

---

### Indexer keeps restarting with missing env vars

**Symptom:** The indexer process exits immediately with `[circleup-indexer] Missing required environment variable(s)`.

**Resolution:**
1. Check that `indexer/.env` exists: `cp indexer/.env.example indexer/.env`
2. Open `indexer/.env` and fill in every variable listed in the error message.
3. Confirm no trailing spaces or quotes around values — the validator trims but does not strip quotes.

---

### Indexer boot: "SCHEMA WARNING"

**Symptom:** The indexer log shows a `SCHEMA WARNING` line after startup.

**Meaning:** The database schema is in a `drifted` or `partial` state — either a migration was applied but the file is missing, or the SQL content does not match what was applied.

**Resolution:**
1. Run `npm run migrate:check --workspace=indexer` to see the full diff.
2. For `pending`: run `npm run migrate` to apply the new files.
3. For `drifted`: restore the original migration files from git history and investigate whether the schema was modified out-of-band.
4. For `partial`: locate the missing migration files. Do not re-run the runner blindly — it will try to apply files it thinks are pending and may duplicate or conflict.

The indexer continues serving data in a `drifted` or `partial` state; the warning is surfaced so it is not missed before the next deploy.

---

### Payout fails with "reputation increment failed"

**Symptom:** `circle.payout()` transaction fails with `circle: reputation increment failed`.

**Cause:** The circle contract is not registered as an authorized caller on the reputation contract. This happens if:
- The circle was deployed manually (bypassing the factory), or
- The factory's `add_authorized_caller` call failed during `create_circle` and the transaction was not fully rolled back.

**Resolution:**
- Confirm the circle was deployed through the factory (check `factory/circle_created` event for this circle address).
- If deploying a circle manually for testing, call `reputation.add_authorized_caller(factory_address, circle_address)` from the factory admin account before attempting a payout.
- Check `GET /reputation/:member` includes the circle in `contributions` — if the indexer has no contribution records, the payout was never reached.

---

### mark_default fails with "round deadline not yet passed"

**Symptom:** Calling `mark_default` returns `"round deadline not yet passed"`.

**Cause:** The current ledger sequence is ≤ `deadline_ledger` of the current round. The contract enforces `ledger.sequence > deadline_ledger` strictly; the deadline ledger itself is not in the default window.

**Resolution:**
- Check the current ledger: `stellar network status --network testnet` shows the latest ledger.
- Check the deadline: `GET /circles/:address` returns `circle.deadline_ledger`.
- Wait until the network ledger advances past the deadline ledger.
- On testnet, ledgers advance approximately every 5 seconds. `(deadline_ledger - current_ledger) × 5` seconds is the remaining wait time.

---

### App build fails with TypeScript errors

**Symptom:** `npm run build --workspace=app` exits with TypeScript errors.

**Common causes:**

| Error pattern | Cause | Fix |
|---|---|---|
| `'useState' is not defined` in a page.tsx | A page component uses hooks without `"use client"` | Add `"use client"` or move hook logic to a Client Component |
| `Type 'X' is not assignable to 'Y'` on a page prop | `params` type mismatch for dynamic routes | Ensure `params: { address: string }` matches the route segment name |
| `Cannot find module '@/lib/...'` | Missing `@` path alias in tsconfig | Check `app/tsconfig.json` has `"paths": { "@/*": ["./src/*"] }` |
| `Property 'X' does not exist on type 'Y'` after indexer API changes | SDK types out of sync with API response shape | Update the interface in `CircleDetailClient.tsx` to match the new shape |

---

### Freighter not detected

**Symptom:** Clicking "Connect Wallet" does nothing or `isFreighterInstalled()` returns false.

**Resolution:**
1. Install the [Freighter browser extension](https://www.freighter.app/).
2. Make sure the extension is enabled and the site origin is not blocked.
3. On localhost, Freighter may require switching to testnet manually in the extension settings.
4. Try a hard refresh (`Ctrl+Shift+R`) — some Freighter versions inject the API asynchronously.

---

## Contract Lifecycle Reference

### Circle Status Machine

```
           join (all members)
Pending ──────────────────────▶ Active ──(all rounds paid)──▶ Completed
   │                                                                │
   │ cancel()                                                       │
   ▼                                                                │
Cancelled ◀─────────────────────────────────────────────────────── ┘
                                                         close() allowed from
                                                         both terminal states
```

- Status transitions are one-way and permanent.
- Active and Completed circles cannot be cancelled.
- `close()` is only callable from `Completed` or `Cancelled`.

### Round Lifecycle

Within an Active circle, each round follows this sequence:

```
Round starts (deadline clock set)
    │
    ├─ Members call contribute() before deadline_ledger
    │
    ├─ Anyone may call mark_default(member) AFTER deadline_ledger
    │   for any member who did not contribute
    │
    └─ Anyone calls payout() once all members have contributed
           │
           ├─ Transfers round_amount × member_count USDC to recipient
           ├─ Calls reputation.increment(recipient)
           └─ Advances to next round (or sets status = Completed)
```

Deadline boundary: `contribute` is rejected when `ledger.sequence > deadline_ledger`. `mark_default` is rejected when `ledger.sequence <= deadline_ledger`. The deadline ledger itself is part of the contribution window (last accepted ledger for `contribute`).

### Reputation Authorization Flow

```
Deploy:
  reputation.initialize(admin = deployer_wallet)
  circle_factory.initialize(admin = deployer_wallet,
                            reputation_contract = reputation_address, ...)
  reputation — transfer admin to factory_address
    (so factory can call add_authorized_caller)

Per circle creation:
  circle_factory.create_circle(...)
    ├─ deploys circle contract
    ├─ calls circle.initialize(...)
    └─ calls reputation.add_authorized_caller(factory_address, circle_address)
         (factory is admin; Contract Invoker rule auto-grants auth)

Per payout:
  circle.payout()
    └─ calls reputation.increment(circle_address, recipient)
         (circle address is authorized caller; Contract Invoker auto-grants auth)
```

A revoked circle can never call `increment` again, even if the factory re-deploys and re-registers its address. The revocation list is permanent and checked before the allowlist.

---

## Security Notes

- **No rug-pulls**: The organizer cannot withdraw funds. All USDC is held by the circle contract, not any wallet. Only `payout()` and `close()` release funds, and only to the scheduled recipient or back to members respectively.
- **Collateral protects the group**: Each member locks `round_amount` USDC as collateral. A missed contribution deducts 20% from their collateral (not from other members' funds). The contract cannot distribute more than it holds.
- **Deterministic payout order**: The recipient for each round is `members[round_index]`, set immutably at `initialize` time. No one can change the rotation after the circle goes Active.
- **Reentrancy protection**: `initialize` uses an `Initializing` flag. `close` sets `Closed = true` before any transfer loops. `join` writes the `Collateral` key before the token transfer. These follow the checks-effects-interactions pattern throughout.
- **Reputation is manipulation-resistant**: `increment` requires a signature from the calling circle contract (auto-granted by Soroban's Contract Invoker rule for cross-contract calls). A wallet cannot directly call `increment` for itself without producing a signature for a circle contract's private key, which is impossible.
- **CORS in production**: The indexer allows all origins by default (`ALLOWED_ORIGINS` unset). In production always set `ALLOWED_ORIGINS` to the app's exact origin. The API logs a warning on startup when this is unset.
- **Rate limiting**: The API applies a per-IP rate limit (default 100 requests/60 seconds). Adjust `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` in `indexer/.env` for production traffic.

---

## Incident Fixtures and Offline Reproduction

The fixtures in `indexer/src/fixtures/incident-fixtures.ts` encode sanitized, deterministic state snapshots for each likely incident class.  They contain no real private keys, no production transaction hashes, and no live RPC responses.  Every address is a synthetic all-zero strkey; every ledger number is chosen so relative ordering is obvious at a glance.

Use the fixtures to reproduce an incident class locally without needing a live network, a funded wallet, or a running Postgres instance.

### Fixture Overview

| Fixture namespace | Incident class | Runbook section |
|---|---|---|
| `StaleIndexerData` | Indexer cursor freezes; DB status/round lag behind chain | [Circle list is empty but circles exist on-chain](#circle-list-is-empty-but-circles-exist-on-chain) |
| `DuplicateEvents` | Same Soroban event delivered twice; dedup guard verified | [Circle list is empty but circles exist on-chain](#circle-list-is-empty-but-circles-exist-on-chain) |
| `WalletRejection` | Freighter not installed / permission denied / unknown error | [Freighter not detected](#freighter-not-detected) · [Transaction fails with "USDC transfer failed"](#transaction-fails-with-usdc-transfer-failed) |
| `RpcTimeout` | simulate / send / poll timeout; health endpoint 503 | [Transaction fails with "USDC transfer failed"](#transaction-fails-with-usdc-transfer-failed) · [App shows "indexer unreachable" banner](#app-shows-indexer-unreachable-banner) |
| `SchemaDrift` | Migration file renamed after apply; ghost entry in `schema_migrations` | [Indexer boot: "SCHEMA WARNING"](#indexer-boot-schema-warning) |

### Running the Incident Tests

```bash
# Run all incident reproduction tests (offline — no DB or RPC required):
npm run test:incidents --workspace=indexer

# Run the full indexer test suite (includes incidents + integration tests):
npm test --workspace=indexer
```

The `test:incidents` script targets only `src/fixtures/incident.test.ts` so it passes in any offline environment — CI runners without Postgres, developer laptops without a running indexer, or during an active incident when the network is degraded.

### StaleIndexerData fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` — `StaleIndexerData` namespace

**Encodes:**
- `seedIndexerState()` — indexer `last_ledger = 1_220_000` while chain tip is `1_280_000` (60 000 ledger lag ≈ 83 hours)
- `seedCircle()` — circle row frozen at `status = "Active"`, `current_round = 0` while on-chain the circle is `Completed`
- `seedOnChainState()` — the actual on-chain truth for cross-checking lag

**Reproduction steps:**
1. Insert `seedIndexerState()` into `indexer_state` and `seedCircle()` into `circles`.
2. Query `GET /circles/:address` — response shows stale `status` and `current_round`.
3. Query `GET /indexer/state` — `lastLedger` is behind by `lagLedgers`.
4. Compare against `seedOnChainState()` to verify the delta matches `expectedBehaviour.lagLedgers`.

**Resolution:** set `START_LEDGER` to `LEDGER.STALE` and replay: `npm run replay -- --from=1220000`

### DuplicateEvents fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` — `DuplicateEvents` namespace

**Encodes:**
- `seedIngestedEvent()` / `seedDuplicateIngestedEvent()` — two rows with the same `event_key` (`tx_hash:event_index`)
- `seedContribution()` / `seedPayout()` — the corresponding derived rows

**Reproduction steps:**
1. Insert `seedIngestedEvent()` into `ingested_events` — succeeds.
2. Attempt to insert `seedDuplicateIngestedEvent()` — `event_key` PRIMARY KEY conflict rejects it.
3. Confirm `ingested_events` contains exactly one row for this event (`expectedBehaviour.ingestedEventsRows = 1`).
4. Confirm the `contributions` and `payouts` tables each contain exactly one row per UNIQUE constraint.

**What to check if duplicate rows appear:** the dedup `INSERT … ON CONFLICT DO NOTHING` in `indexer.ts` was bypassed (e.g. a direct SQL insert during a failed replay).  Re-run `npm run replay -- --from=<ledger>` to reconcile.

### WalletRejection fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` — `WalletRejection` namespace

**Encodes three sub-cases:**

| Sub-case | Trigger | Expected `invokeContract` result |
|---|---|---|
| `notInstalled` | `isFreighterInstalled()` returns `false` | `{ success: false, txHash: "", error: "Freighter wallet extension is not installed." }` |
| `permissionDenied` | User dismisses the Freighter prompt | `{ success: false, txHash: "", error: "You cancelled the transaction in Freighter. No funds were moved." }` |
| `unknownError` | Extension throws `"Extension context invalidated."` | `{ success: false, txHash: "", error: "Extension context invalidated." }` |

**Reproduction steps:**
1. In a browser test environment, mock `isFreighterInstalled` to return `false` and call `connectWallet()` — should throw `WalletError` with `reason = "not_installed"`.
2. Mock `signTransaction` to throw one of `permissionDenied.rawErrorVariants` — `invokeContract` must return `expectedResult`.
3. Mock `signTransaction` to throw `unknownError.rawError` — formatted error must equal `unknownError.expectedResult.error`.

**Runbook resolution:** see [Freighter not detected](#freighter-not-detected) for install and permission steps.

### RpcTimeout fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` — `RpcTimeout` namespace

**Encodes four sub-cases:**

| Sub-case | Phase | Expected result |
|---|---|---|
| `simulateTimeout` | `simulateTransaction` throws `"Request timeout"` | `success: false`, network error message |
| `sendTimeout` | `sendTransaction` throws `"Failed to fetch"` | `success: false`, network error message |
| `pollExhausted` | 30 polls all return `NOT_FOUND` | `success: false`, `txHash` preserved, timeout message |
| `healthCheckTimeout` | DB + RPC both exceed 5 000 ms | HTTP 503, `status: "degraded"` |

**Reproduction steps:**
1. Inject `RpcTimeout.seedMockRpcThatTimesOut(10)` as the RPC client and call `invokeContract` — should return `success: false` within ~10 ms (not after the full 60 s poll budget).
2. For `pollExhausted`: stub `getTransaction` to always return `{ status: "NOT_FOUND" }` — after 30 attempts `invokeContract` returns the timeout message with the `txHash` preserved.
3. For health timeout: stub `pool.query` and RPC latency checks to resolve after 6 000 ms — `GET /health` must return 503 with `"status": "degraded"`.

**Runbook resolution:** see [App shows "indexer unreachable" banner](#app-shows-indexer-unreachable-banner) and [Transaction fails with "USDC transfer failed"](#transaction-fails-with-usdc-transfer-failed).

### SchemaDrift fixture

**File:** `indexer/src/fixtures/incident-fixtures.ts` — `SchemaDrift` namespace

**Encodes:**
- `seedAppliedInDb()` — `["001_add_round_deadline_ledgers.sql"]` (original name, still in `schema_migrations`)
- `seedFilesOnDisk()` — `["001_add_round_deadline_ledgers_renamed.sql", "002_ledger_checkpoints.sql"]` (original gone, renamed version present)
- `seedAppliedRow()` — the `schema_migrations` row with the original filename

**Reproduction steps:**
1. Insert `seedAppliedRow()` into `schema_migrations`.
2. Temporarily rename `indexer/src/db/migrations/001_add_round_deadline_ledgers.sql` to the `RENAMED_FILENAME`.
3. Run `npm run migrate:check --workspace=indexer` — output must show `Health state: drifted`.
4. Restore the original filename; re-run the check — output must show `Health state: pending` (renamed file now pending).

**Runbook resolution:** see [Indexer boot: "SCHEMA WARNING"](#indexer-boot-schema-warning) for drift recovery steps.

---

## Mutation Testing and Guard Verification

### Why Mutation Testing

A test that passes when a critical guard is removed is not testing that guard — it is testing something else.  Mutation testing detects this by explicitly removing each guard and verifying that at least one test fails.

CircleUp uses an **explicit guard-removal** strategy rather than a fully automated mutation framework (e.g. `cargo-mutants`):

- Each critical guard has a named test that proves removal would be detected.
- The strategy is transparent: the guard under test and the risk if removed are documented in the test file header.
- CI budget is predictable: the tests run as part of the standard `cargo test` / `npm test` invocations without a separate mutation runner.

### Contract Mutation Guards (Rust)

**File:** `contracts/circle/src/mutation_guards.rs`

Run with:

```bash
cd contracts && cargo test -p circle mutation_guard
```

Fifteen guards are tested across the `circle` and `reputation` contracts:

| Guard | Risk if removed | Test |
|---|---|---|
| `already joined` (`has` check, not balance) | Double-collateral pull | `guard_join_double_collateral_pull` · `guard_join_has_check_not_balance_check` |
| `not all members have contributed yet` | Payout before all deposits | `guard_payout_requires_full_contribution_counter` · `guard_payout_one_missing_contribution_blocks` |
| `round contribution tally mismatch` | Forged counter bypasses payout | `guard_payout_tally_mismatch_forged_counter` · `guard_payout_forged_keys_without_counter_blocked` |
| `round deadline not yet passed` (strict `>`) | Premature default; collateral stolen early | `guard_mark_default_deadline_strict_boundary` · `guard_mark_default_one_before_deadline_blocked` |
| `member did contribute` | Contributor penalised despite fulfilling obligation | `guard_mark_default_contributor_cannot_be_penalised` · `guard_contribution_key_persists_after_deadline_for_guard_correctness` |
| `already marked default this round` | Double penalty (36% instead of 20%) | `guard_mark_default_idempotency` · `guard_mark_default_single_penalty_amount_is_correct` |
| `circle already closed` (Closed flag) | Double-release of collateral | `guard_close_double_release_prevention` · `guard_close_collateral_zeroed_before_transfer_cei` |
| `overflows penalty calculation` | Silent i128 wrap; penalty becomes 0 | `guard_initialize_overflow_penalty_arithmetic` |
| `overflows pot calculation` | Silent i128 wrap; recipient receives wrong amount | `guard_initialize_overflow_pot_arithmetic` |
| `already initialized` | Member list overwrite mid-lifecycle | `guard_reinitialize_blocked` · `guard_reinitialize_blocked_with_different_params` |
| Reputation unauthorized caller | Self-awarded reputation points | `guard_reputation_unauthorized_caller_blocked` |
| Reputation revocation permanent | Revived circle awards points | `guard_reputation_revocation_is_permanent` |
| `duplicate members` | One wallet gets two rotation slots | `guard_duplicate_members_rejected` |
| Non-member cannot close | Outsider triggers collateral settlement | `guard_close_non_member_rejected` |
| Status gate for contribute/close | Contributions/closes on wrong lifecycle phase | `guard_contribute_blocked_while_pending` · `guard_contribute_blocked_while_completed` · `guard_contribute_rejected_one_past_deadline` |

Each guard test follows one of two forms:

- **Form A** (`#[should_panic]`): the contract is put into the state the guard is meant to block, and the test asserts the call panics with the exact guard message. Removing the guard makes the call succeed, breaking the `#[should_panic]` assertion.
- **Form B** (positive assertion): the test verifies the call _succeeds_ at the boundary where the guard allows it, and separately verifies the guard fires one step earlier. Weakening the boundary (e.g. changing `>` to `>=`) would break one of the two assertions.

### App Gating Mutation Tests (TypeScript)

**File:** `app/src/lib/gating.mutation.test.ts`

Run with:

```bash
node --require ts-node/register --test app/src/lib/gating.mutation.test.ts
```

Eight guards are tested in `computeActionEligibility`:

| Guard | Action | Risk if removed | Mutant proof |
|---|---|---|---|
| `stale_snapshot` (age ≥ maxAge) | all | Stale UI state submits on-chain write | `mutantNoStalenessCheck` allows stale snapshots |
| `wrong_status` (Pending for join) | join | `join` on Active/Completed circle | `mutantNoStatusCheckJoin` allows join on Active |
| `wrong_status` (Active for contribute) | contribute | `contribute` on Pending/Completed circle | `mutantNoStatusCheckContribute` allows on Pending |
| `deadline_passed` (latestLedger > deadlineLedger) | contribute | Late contribution submitted after deadline | `mutantNoDeadlineCheckContribute` allows late contributions |
| `already_joined` (hasLockedCollateral) | join | Double-join from browser triggers double-collateral | `mutantNoAlreadyJoinedCheck` allows when already joined |
| `already_contributed` | contribute | Double-contribute from browser | `mutantNoAlreadyContributedCheck` allows when already contributed |
| `round_not_complete` (contributions < memberCount) | payout | Premature payout triggered from UI | `mutantNoRoundCompleteCheckPayout` allows with partial contributions |
| `wrong_status` (terminal for close) | close | Close on Active/Pending circle | `mutantNoStatusCheckClose` allows on Active |

Each test follows the **production vs. mutant** pattern:
1. Assert the production function **blocks** the action for the given input.
2. Call the local mutant (guard removed) with the same input.
3. Assert the mutant **allows** it — proving the production guard is the discriminating factor.

Guard ordering invariants are also tested: `stale_snapshot` is checked before `wrong_status` which is checked before action-specific guards, for all four actions.

### CI Budget and Excluded Mutations

**Budget:** All mutation guard tests run as part of the existing CI commands — no separate mutation runner or additional CI step is required.

```
cargo test -p circle          # includes mutation_guards.rs — ~5 s
npm test --workspace=indexer  # includes incident.test.ts — ~1 s (offline)
npx tsc --noEmit              # type-checks gating.mutation.test.ts — ~3 s
```

Total added CI time: < 10 seconds.

**Excluded mutations (with rationale):**

| Excluded guard | Rationale |
|---|---|
| `MIN/MAX_ROUND_DEADLINE_LEDGERS` bounds | Removal creates an unusable circle (zero or multi-year window) but no direct financial theft path. Covered by boundary tests B3/B4 in `prop_tests.rs`. |
| `MAX_MEMBERS` bound | Removal allows expensive initialization but no financial shortcut. Covered by boundary test B5 in `prop_tests.rs`. |
| Status forward-only (no revert) | Tested exhaustively as invariant 4 in `prop_tests.rs` across random member counts and amounts. Duplicating it here would add CI time without new coverage. |
| `round_deadline_ledgers` stored as u64 (not truncated) | A u32 truncation would silently set a wrong deadline but is already caught by boundary tests B6a/B6b in `prop_tests.rs`. |

Any future change to a guard listed in either test file requires updating the corresponding mutation test or explicitly documenting why the guard is excluded. Guards not in the mutation test catalogue are considered lower-risk or already covered by property-based tests.

---

## Development Best Practices

**Contract changes**
- Run `cargo test` in `contracts/` before committing. All 15+ unit tests must pass.
- Use `stellar contract invoke --cost -- <function>` to estimate fees before broadcasting.
- Any change to `PENALTY_BPS`, `BPS_DENOM`, `COLLATERAL_MULTIPLIER`, `MIN/MAX_ROUND_DEADLINE_LEDGERS`, or `MAX_MEMBERS` is a breaking change — update the README protocol constants table, the SDK constants file, and the app's gating logic.
- After changing contract entry-points, regenerate the TypeScript bindings if the SDK uses them, and update the type interfaces in `app/src/app/circles/[address]/CircleDetailClient.tsx`.

**Indexer changes**
- New event types require a new handler in `indexer/src/indexer.ts` and a migration adding any new columns or tables.
- API shape changes must be reflected in the TypeScript interfaces in the app (`CircleDetailClient.tsx`, `ReputationClient.tsx`).
- Always run `npm run migrate:check` in CI before deploying the indexer.

**App changes**
- Keep `"use client"` boundaries minimal. Data fetching belongs in Server Components; interactivity belongs in Client Components.
- When adding a new page route, export a `generateMetadata` function to provide a title and description — all routes should have meaningful metadata.
- Run `npm run lint --workspace=app` and `npx tsc --noEmit` in `app/` before opening a PR.
- The `app/src/lib/gating.ts` action-eligibility logic is the single source of truth for which wallet actions are allowed given the current circle state. Update it — not ad-hoc UI conditions — when adding new state transitions.

**Testing**
- Rust: `cd contracts && cargo test` runs all unit, property-based, and mutation guard tests.
- TypeScript: `npm test --workspace=indexer` runs all indexer unit, integration, and incident reproduction tests.
- App gating mutation tests: `node --require ts-node/register --test app/src/lib/gating.mutation.test.ts`
- Incident reproduction (offline): `npm run test:incidents --workspace=indexer`
- Integration tests gated on `DATABASE_URL` are skipped automatically in CI environments without Postgres — run them locally before landing schema changes.
- When modifying a financial guard in `contracts/circle/src/lib.rs` or `app/src/lib/gating.ts`, update the corresponding mutation guard test in `mutation_guards.rs` or `gating.mutation.test.ts`. If the guard is intentionally excluded from mutation testing, add a rationale to the [CI Budget and Excluded Mutations](#ci-budget-and-excluded-mutations) table.

**Branching and commits**
- Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): description`, `fix(scope): description`, etc.
- One feature or fix per PR. Keep PRs focused to make review tractable.
- Update `CHANGELOG.md` under `[Unreleased]` with every user-visible change.
- CI runs on every PR: TypeScript build (`tsc --noEmit`), Rust WASM compile (`cargo build --target wasm32-unknown-unknown`), and ESLint. All checks must pass before merging.
