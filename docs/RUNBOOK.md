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
  - [Inventory and CI Parity Check](#inventory-and-ci-parity-check)
  - [Indexer (`indexer/.env`)](#indexer-indexerenv)
  - [App (`app/.env.local`)](#app-appenvlocal)
  - [SDK (`sdk/`)](#sdk-sdk)
  - [Scripts (`scripts/.env`)](#scripts-scriptsenv)
  - [Deployment Profiles (`deploy/profiles/`)](#deployment-profiles-deployprofiles)
- [Deployment](#deployment)
  - [Contract Deployment Order](#contract-deployment-order)
  - [Post-Deployment Configuration](#post-deployment-configuration)
  - [Updating the App and Indexer](#updating-the-app-and-indexer)
- [Database Operations](#database-operations)
  - [Running Migrations](#running-migrations)
  - [Checking Schema Health](#checking-schema-health)
  - [Re-indexing from a Given Ledger](#re-indexing-from-a-given-ledger)
- [Database Backup and Restore](#database-backup-and-restore)
- [Indexer Retention and Archival](./INDEXER_RETENTION.md)
  - [Backup](#backup)
  - [Restore drill — isolated target](#restore-drill--isolated-target)
  - [Post-restore verification](#post-restore-verification)
  - [Applying migrations after restore](#applying-migrations-after-restore)
  - [Restore vs. chain replay — decision criteria](#restore-vs-chain-replay--decision-criteria)
  - [Promoting the restore target to production](#promoting-the-restore-target-to-production)
  - [Rollback guidance](#rollback-guidance)
- [Health Checks and Monitoring](#health-checks-and-monitoring)
  - [Indexer Health Endpoint](#indexer-health-endpoint)
  - [Indexer Audit Endpoint](#indexer-audit-endpoint)
  - [Per-Circle Reconciliation](#per-circle-reconciliation)
  - [Circle Activity CSV Export](#circle-activity-csv-export)
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
- [Admin Credential Incident Procedure](#admin-credential-incident-procedure)
- [Demo Seed State and Repeat Runs](#demo-seed-state-and-repeat-runs)
- [Storage TTL and Retention](#storage-ttl-and-retention)
- [Protocol Invariant Reference](#protocol-invariant-reference)
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
- [Issue-to-Test Traceability](#issue-to-test-traceability)
  - [Package Impact and Verification Section](#package-impact-and-verification-section)
  - [Examples](#examples)
  - [Review Guidance](#review-guidance)
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
ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
Γöé                      Stellar Testnet                            Γöé
Γöé                                                                 Γöé
Γöé  ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ  deploys  ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ   Γöé
Γöé  Γöé  circle_factory  ΓöéΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓû╢Γöé  circle (per instance)  Γöé   Γöé
Γöé  ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ           ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ   Γöé
Γöé           Γöé                               Γöé                     Γöé
Γöé     registers caller               calls increment              Γöé
Γöé           Γöé                               Γöé                     Γöé
Γöé           Γû╝                               Γû╝                     Γöé
Γöé  ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ  Γöé
Γöé  Γöé                     reputation                            Γöé  Γöé
Γöé  ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ  Γöé
ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
           Γû▓ Soroban events                  Γû▓ RPC simulation calls
           Γöé                                 Γöé
ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö┤ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ          ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö┤ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
Γöé      indexer        Γöé          Γöé         sdk           Γöé
Γöé  Node + Postgres    Γöé          Γöé  TypeScript client    Γöé
Γöé  REST API :3001     Γöé          ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ                    Γû▓
           Γöé HTTP JSON                     Γöé imported by
           Γû╝                               Γöé
ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
Γöé                    app (Next.js 14)                            Γöé
Γöé  /                 ΓåÆ circle list (fetches from indexer)        Γöé
Γöé  /create           ΓåÆ deploy circle (Freighter + SDK)          Γöé
Γöé  /circles/[addr]   ΓåÆ detail + contribute/payout actions        Γöé
Γöé  /reputation/[m]   ΓåÆ on-chain score + participation history    Γöé
ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
```

---

## Component Responsibilities

### Soroban Contracts

Located in `contracts/`. Three contracts, each with a single responsibility:

**`circle_factory`** (`contracts/circle_factory/src/lib.rs`)
- Stores the circle WASM hash, the reputation contract address, and the USDC token address.
- `create_circle` deploys a new circle contract, initializes it, registers it as an authorized reputation caller, and records its address ΓÇö all atomically in one transaction.
- Maintains `Circles: Vec<Address>` and `CircleCount: u32` which always satisfy `count == circles.len()`.

**`circle`** (`contracts/circle/src/lib.rs`)
- Core ROSCA logic: join, contribute, payout, mark_default, cancel, close.
- Status transitions: `Pending ΓåÆ Active ΓåÆ Completed` or `Pending ΓåÆ Cancelled`.
- Every member must lock `round_amount ├ù COLLATERAL_MULTIPLIER` USDC (currently 1├ù) to join.
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

- `FactoryClient` ΓÇö wraps `create_circle` and `get_circles` factory calls.
- `CircleClient` ΓÇö wraps `join`, `contribute`, `payout`, `mark_default`, `cancel`, `close`, and all read views for a single circle.
- `ReputationClient` ΓÇö wraps `score` and other reputation views.
- `getNetworkConfig` / `isValidNetwork` ΓÇö typed network config with RPC URL and passphrase.
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
- Wallet state is read on the client inside `useEffect` ΓÇö never on the server ΓÇö to avoid SSR/hydration mismatches.
- The `WalletRepLink` component in the nav reads the connected wallet address and links to `/reputation/[address]`.

---

## How the Components Connect

### Creating a circle (write path)

```
User fills /create form
  ΓåÆ CreateClient.tsx collects members, amount, deadline
  ΓåÆ invokeContract("create_circle", ...) in stellar.ts
  ΓåÆ Freighter signs the transaction
  ΓåÆ circle_factory.create_circle() on Soroban RPC:
      Γö£ΓöÇ deploys circle WASM at deterministic address
      Γö£ΓöÇ calls circle.initialize(...)
      ΓööΓöÇ calls reputation.add_authorized_caller(circle_address)
  ΓåÆ Soroban emits factory/circle_created event
  ΓåÆ indexer polls event ΓåÆ writes row to circles table
  ΓåÆ /circles page fetches from indexer REST API ΓåÆ renders CircleCard
```

### Contributing and triggering payout (write path)

```
Member clicks "Contribute Round N"
  ΓåÆ CircleDetailClient invokes circle.contribute(member) via Freighter
  ΓåÆ circle stores Contributed(member, round_index) in persistent storage
  ΓåÆ Soroban emits circle/contributed event
  ΓåÆ (once all members contributed) anyone clicks "Trigger Payout"
  ΓåÆ circle.payout() transfers pot to recipient, calls reputation.increment
  ΓåÆ Soroban emits circle/payout and reputation/score_updated events
  ΓåÆ indexer processes events ΓåÆ updates contributions, payouts, reputation tables
  ΓåÆ page refetches from indexer ΓåÆ UI reflects new state
```

### Reading circle state (read path)

```
Browser navigates to /circles/[address]
  ΓåÆ CircleDetailPage (Server Component) fetches:
      GET /circles/:address          ΓåÆ circle row + members + latest ledger
      GET /circles/:address/rounds   ΓåÆ payouts + contributions + pending defaults
  ΓåÆ If indexer returns 404 ΓåÆ Next.js notFound() ΓåÆ not-found.tsx rendered
  ΓåÆ If fetch succeeds ΓåÆ CircleDetailClient (Client Component) hydrated with data
  ΓåÆ Client-side effects read wallet address from Freighter for action gating
```

### Reputation lookup (read path)

```
User navigates to /reputation/[address]
  ΓåÆ ReputationPage (Server Component) passes address to ReputationClient
  ΓåÆ ReputationClient (Client Component) fetches:
      GET /reputation/:member ΓåÆ score + per-circle contributions + defaults
  ΓåÆ Renders score card, participation table, defaults table
```

---

## Local Development Setup

### Prerequisites

| Tool | Minimum version | Purpose |
|---|---|---|
| Node.js + npm | 18.18+ with npm 9; 22.x with npm 10; 24.x with npm 11 (CI-tested tuples) | Frontend, indexer, scripts |
| Rust | 1.81.0 (pinned) | Compile Soroban contracts |
| Soroban SDK | 21.7.7 (locked) | Contract SDK; `contracts/Cargo.lock` is authoritative |
| Rust WASM target | `wasm32-unknown-unknown` | Compile Soroban contract artifacts |
| stellar-cli | latest | Deploy contracts to testnet |
| Docker | any | Postgres via docker compose |
| Freighter | browser extension | Wallet for the web UI |

Install stellar-cli:
```bash
cargo install --locked stellar-cli --features opt
```

Run `npm run check:node` to validate the Node/npm pair. After Rust and the WASM
target are installed, run `npm run check:toolchain` to validate the complete
pinned build tuple before compiling contracts.

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
# Edit indexer/.env ΓÇö fill in CIRCLE_FACTORY_ADDRESS, REPUTATION_ADDRESS, USDC_ADDRESS
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
# Edit app/.env.local ΓÇö paste the same contract addresses with NEXT_PUBLIC_ prefix
# NEXT_PUBLIC_INDEXER_URL defaults to http://localhost:3001 ΓÇö leave as-is for local dev
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
npm run seed:demo --workspace=scripts -- --always-create
# Creates a new 4-member $100/round testnet circle; explicit confirmation required.
# Runs through Round 1 (all contribute ΓåÆ Alice receives $400)
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

This section is the human-readable view of the environment-variable inventory. The
machine-readable source of truth lives in `config/env-inventory.json`; the CI parity
checker (`npm run check:env`) compares that inventory against the `.env.example`
files, the runtime validators in each package, and the tables below. If a variable
is renamed, gains a default, or becomes required in code, update the inventory and
this section in the same change.

### Inventory and CI Parity Check

```bash
npm run check:env
# Exits 0 when inventory, examples, validators, and this runbook agree.
# Exits non-zero and prints a name-only report for:
#   - missing:      inventory entry with no matching .env.example or doc row
#   - stale:        .env.example or doc row with no matching inventory entry
#   - undocumented: process.env read or validator key absent from the inventory
#   - drift:        requiredness or default differs between inventory and code
```

The checker reports variable **names** and the kind of mismatch only. It never
prints configured values, so it is safe to run against a populated environment
and in CI logs. Secret-bearing variables are listed by name and marked
`secret` in the inventory; their values are never read by the checker.

Each table row below follows a fixed column order so the checker can parse it:

`| Variable | Package | Required | Default | Description |`

- **Package** is the owning workspace: `indexer`, `app`, `sdk`, `scripts`, or `deploy`.
- **Required** is `Yes`, `No`, or `Prod` (required only when `NODE_ENV=production`).
- **Default** is the literal default, `—` when there is none, or `(empty)` when the
  variable is defined but intentionally blank.

### Indexer (`indexer/.env`)

| Variable | Package | Required | Default | Description |
|---|---|---|---|---|
| `DATABASE_URL` | `indexer` | Yes | — | Postgres connection string, e.g. `postgresql://postgres:password@localhost:5432/circleup`. Secret. |
| `STELLAR_RPC_URL` | `indexer` | Yes | — | Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org` |
| `CIRCLE_FACTORY_ADDRESS` | `indexer` | Yes | — | Deployed factory contract ID (`C...`) |
| `REPUTATION_ADDRESS` | `indexer` | Yes | — | Deployed reputation contract ID (`C...`) |
| `USDC_ADDRESS` | `indexer` | Yes | — | USDC token contract ID (`C...`) |
| `NETWORK_PASSPHRASE` | `indexer` | No | `Test SDF Network ; September 2015` | Stellar network passphrase |
| `PORT` | `indexer` | No | `3001` | API server port |
| `START_LEDGER` | `indexer` | No | `0` | Ledger to start indexing from. Set to your deployment ledger to skip testnet genesis |
| `POLL_INTERVAL_MS` | `indexer` | No | `5000` | How often to poll the RPC for new events (milliseconds) |
| `EVENTS_LIMIT` | `indexer` | No | `100` | Max events per `getEvents()` call. Soroban RPC caps at 10 000 |
| `ALLOWED_ORIGINS` | `indexer` | No | `(empty)` | Comma-separated CORS allow-list, e.g. `https://app.circleup.xyz`. Leave blank for local dev. Required in production |
| `RATE_LIMIT_WINDOW_MS` | `indexer` | No | `60000` | Rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | `indexer` | No | `100` | Max requests per IP per window |

All required variables are validated at boot time. The indexer will exit with a clear error message listing every missing key if any are absent or blank.

### App (`app/.env.local`)

| Variable | Package | Required | Default | Description |
|---|---|---|---|---|
| `NEXT_PUBLIC_STELLAR_RPC_URL` | `app` | No | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | `app` | No | `Test SDF Network ; September 2015` | Network passphrase |
| `NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS` | `app` | Prod | `(empty)` | Factory contract ID |
| `NEXT_PUBLIC_REPUTATION_ADDRESS` | `app` | Prod | `(empty)` | Reputation contract ID |
| `NEXT_PUBLIC_USDC_ADDRESS` | `app` | Prod | `(empty)` | USDC token contract ID |
| `NEXT_PUBLIC_INDEXER_URL` | `app` | No | `http://localhost:3001` | Indexer base URL |

In development, the contract address variables may be left blank ΓÇö the app will start but contract interactions will fail gracefully. In production (`NODE_ENV=production`) they are required and the server will throw at boot time if they are missing.

### SDK (`sdk/`)

The SDK does not read `process.env` directly. `getNetworkConfig` accepts an explicit
network name and resolves RPC URL and passphrase from the built-in network table.
The variables below are read only by the SDK's test harness and are not part of any
deployed runtime.

| Variable | Package | Required | Default | Description |
|---|---|---|---|---|
| `SDK_TEST_RPC_URL` | `sdk` | No | `https://soroban-testnet.stellar.org` | RPC endpoint used by SDK integration tests |
| `SDK_TEST_NETWORK_PASSPHRASE` | `sdk` | No | `Test SDF Network ; September 2015` | Passphrase used by SDK integration tests |

### Scripts (`scripts/.env`)

| Variable | Package | Required | Default | Description |
|---|---|---|---|---|
| `NETWORK` | `scripts` | Yes | — | Target network name (`testnet` or `mainnet`) |
| `NETWORK_PASSPHRASE` | `scripts` | Yes | — | Passphrase for the target network |
| `RPC_URL` | `scripts` | Yes | — | Soroban RPC endpoint used for deployment |
| `DEPLOYER_IDENTITY` | `scripts` | Yes | `deployer` | stellar-cli identity name. The private key stays in the CLI keystore, never in `.env` |
| `STELLAR_SECRET_KEY` | `scripts` | No | `(empty)` | CI-only injection path. Secret. Never commit or echo |
| `HORIZON_URL` | `scripts` | No | `https://horizon-testnet.stellar.org` | Horizon endpoint used for funding checks |

The deploy script validates `NETWORK`, `NETWORK_PASSPHRASE`, and `RPC_URL` before any write transaction. Run `npm run validate-env --workspace=scripts` to check the profile independently.

### Deployment Profiles (`deploy/profiles/`)

Profile files are JSON, not `.env` files. The inventory records the same
requiredness and default metadata so the parity checker can compare them with the
runtime validators that consume them.

| Variable | Package | Required | Default | Description |
|---|---|---|---|---|
| `PROFILE` | `deploy` | Yes | — | Profile name (`development`, `staging`, `production`) |
| `RPC_URL` | `deploy` | Yes | — | RPC endpoint for the profile. Must be HTTPS and non-testnet for `production` |
| `NETWORK_PASSPHRASE` | `deploy` | Yes | — | Passphrase for the profile network |
| `HORIZON_URL` | `deploy` | Yes | — | Horizon endpoint used by the mainnet readiness gate |
| `CIRCLE_FACTORY_ADDRESS` | `deploy` | Yes | — | Factory contract ID for the profile |
| `REPUTATION_ADDRESS` | `deploy` | Yes | — | Reputation contract ID for the profile |
| `USDC_ADDRESS` | `deploy` | Yes | — | USDC token contract ID for the profile |
| `ADMIN_PUBLIC_KEY` | `deploy` | Yes | — | Public key of the deployment admin. Public value only; never a secret |
| `DEPLOYMENT_MANIFEST` | `deploy` | No | `scripts/deployed-manifest.json` | Path to the deployment manifest checked by the readiness gate |

---

## Deployment

### Contract Deployment Order

Contracts must be deployed in this exact order due to cross-contract dependencies:

```
1. reputation   ΓÇö no dependencies; stores admin address
2. circle_factory ΓÇö depends on reputation address and circle WASM hash
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
4. Transferring