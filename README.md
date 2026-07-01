# 🔄 CircleUp

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/CIRCLEUP-AJO/CIRCLEUP/actions/workflows/ci.yml/badge.svg)](https://github.com/CIRCLEUP-AJO/CIRCLEUP/actions/workflows/ci.yml)
[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar%20Soroban-7B2FBE?logo=stellar&logoColor=white)](https://stellar.org)
[![Next.js](https://img.shields.io/badge/Frontend-Next.js%2014-black?logo=next.js&logoColor=white)](https://nextjs.org)
[![Rust](https://img.shields.io/badge/Contracts-Rust%20%2B%20Soroban-orange?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CODE_OF_CONDUCT.md)
> **The savings club a billion people already use — made trustless.**

CircleUp brings Rotating Savings & Credit Associations (ROSCAs) — known as **Ajo** in Nigeria, **Esusu** across West Africa, **Tanda** in Latin America, and **Chama** in Kenya — onto **Stellar Soroban**. The notebook-and-trust model is replaced by a tamper-proof smart contract: every member contributes each round, and the pot auto-pays the scheduled recipient. The organizer can never run off with the money.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Data Flow](#data-flow)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Contracts Reference](#contracts-reference)
- [API Reference](#api-reference)
- [Demo Flow](#demo-flow)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)

---

## How It Works

```
1. Organizer creates a circle → sets members, $amount/round, rotation order, schedule
2. All members lock collateral (1× round amount) to join
3. Each round: every member contributes → contract holds the pot
4. Contract auto-pays the scheduled recipient (no intermediary)
5. Miss a round → 20% collateral penalty + default flag on your record
6. Complete a full circle → your on-chain reputation score increments
```

**Example:** 4 members, $100/round, monthly schedule

| Round | Pot    | Recipient |
|-------|--------|-----------|
| 1     | $400   | Alice     |
| 2     | $400   | Bob       |
| 3     | $400   | Carol     |
| 4     | $400   | Dave      |

Each member contributes $400 total, receives $400 once. Zero interest. Zero trust required.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Stellar Testnet                          │
│                                                              │
│  ┌──────────────────┐   deploys   ┌────────────────────┐    │
│  │  circle_factory  │────────────▶│  circle (instance) │    │
│  └──────────────────┘             └────────────────────┘    │
│           │                               │                  │
│     registers                       calls increment          │
│           │                               │                  │
│           ▼                               ▼                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   reputation                          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         ▲ events                              ▲ RPC calls
         │                                     │
┌────────┴──────────┐               ┌──────────┴──────────┐
│      indexer      │               │       sdk            │
│  Node + Postgres  │               │   TypeScript client  │
│  REST API :3001   │               └─────────────────────┘
└────────┬──────────┘                         ▲
         │ HTTP                               │ imports
         ▼                                   │
┌──────────────────────────────────────────────────────────┐
│                     app (Next.js 14)                      │
│   /          → circle list (reads indexer)                │
│   /create    → deploy circle (calls contract via sdk)     │
│   /circles/[addr] → detail, contribute, payout actions    │
│   /reputation/[member] → score + history                  │
└──────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
circleup/
│
├── contracts/                  # Soroban smart contracts (Rust)
│   ├── Cargo.toml              # Workspace root
│   ├── circle_factory/         # Deploys + registers circle instances
│   │   └── src/lib.rs
│   ├── circle/                 # Core ROSCA logic
│   │   └── src/
│   │       ├── lib.rs          # Contract: join, contribute, payout, mark_default, close
│   │       └── tests.rs        # 15 unit tests
│   └── reputation/             # On-chain score per wallet
│       └── src/lib.rs
│
├── sdk/                        # TypeScript SDK (@circleup/sdk)
│   └── src/
│       ├── index.ts            # Public exports
│       ├── client.ts           # FactoryClient, CircleClient, ReputationClient
│       ├── types.ts            # Shared TypeScript types
│       ├── utils.ts            # stroopsToUsdc, daysToLedgers, etc.
│       └── constants.ts        # Network passphrases, RPC URLs, USDC decimals
│
├── indexer/                    # Event indexer + REST API (@circleup/indexer)
│   └── src/
│       ├── index.ts            # Entry point: boots API + indexer
│       ├── api.ts              # Express REST API
│       ├── indexer.ts          # Soroban event polling loop
│       └── db/
│           ├── pool.ts         # Postgres connection pool
│           ├── migrate.ts      # Schema migration runner
│           └── schema.sql      # Full DB schema
│
├── app/                        # Next.js 14 frontend (@circleup/app)
│   └── src/
│       ├── app/                # App Router pages
│       │   ├── page.tsx        # / — circle list
│       │   ├── create/         # /create — new circle form
│       │   ├── circles/[address]/ # circle detail + actions
│       │   └── reputation/[member]/ # member reputation page
│       ├── components/         # Reusable React components
│       │   ├── CircleCard.tsx
│       │   ├── WalletButton.tsx
│       │   └── ReputationBadge.tsx
│       └── lib/
│           ├── config.ts       # Env var accessors + USDC helpers
│           └── stellar.ts      # Soroban RPC + Freighter integration
│
├── scripts/                    # Deployment + demo scripts (@circleup/scripts)
│   └── src/
│       ├── deploy.ts           # Build + deploy all contracts to testnet
│       └── seed-demo.ts        # Seed a 4-member $100/round demo circle
│
├── docker-compose.yml          # Local Postgres for the indexer
├── package.json                # npm workspaces root
├── CHANGELOG.md
└── README.md
```

---

## Data Flow

### Creating a circle
```
User (browser)
  → /create page (Next.js)
  → invokeContract("create_circle", ...) via stellar.ts
  → Freighter signs the tx
  → circle_factory.create_circle() deploys a new circle contract
  → Event: factory/circle_created
  → indexer picks up event → writes to circles table
  → /circles page fetches from indexer REST API
```

### Contributing & payout
```
Member clicks "Contribute"
  → contribute() call → contract holds tokens
  → Once all members contribute → anyone calls payout()
  → Contract transfers pot to recipient
  → Calls reputation.increment(recipient)
  → Events: circle/contributed, circle/payout, reputation/increment
  → indexer updates contributions, payouts, reputation tables
```

### Default
```
Round deadline passes, member hasn't contributed
  → Anyone calls mark_default(member)
  → 20% collateral penalty applied on-chain
  → Event: circle/default
  → indexer records in defaults table, increments member default count
```

---

## Quick Start

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 18 | Frontend + indexer + scripts |
| Rust | stable | Compile Soroban contracts |
| stellar-cli | latest | Deploy contracts to testnet |
| Docker | any | Local Postgres via docker compose |
| Freighter | browser ext | Wallet for the web app |

Install stellar-cli:
```bash
cargo install --locked stellar-cli --features opt
```

### 1. Clone and install dependencies

```bash
git clone https://github.com/your-org/circleup
cd circleup
npm install
```

### 2. Build and deploy contracts

```bash
# Generate a testnet deployer identity
stellar keys generate --global deployer --network testnet
stellar keys fund deployer --network testnet

# Deploy all three contracts (reputation → circle_factory → circle WASM hash)
npm run deploy:testnet
# Writes contract addresses to scripts/deployed.json
```

### 3. Configure environment variables

```bash
# Indexer
cp indexer/.env.example indexer/.env
# Paste the addresses from scripts/deployed.json into indexer/.env

# App
cp app/.env.example app/.env.local
# Paste the same addresses with NEXT_PUBLIC_ prefix
```

### 4. Start Postgres

```bash
docker compose up -d
npm run migrate
```

### 5. Start the indexer

```bash
npm run dev:indexer
# Listening on http://localhost:3001
```

### 6. Start the frontend

```bash
npm run dev:app
# Open http://localhost:3000
```

### 7. Seed the demo circle

```bash
npm run seed:demo
# Creates a 4-member $100/round testnet circle
# Runs Round 1 (all contribute → Alice receives $400)
# Shows Round 2 default for Dave
```

---

## Environment Variables

### `indexer/.env`

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string | `postgresql://postgres:password@localhost:5432/circleup` |
| `STELLAR_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `NETWORK_PASSPHRASE` | Stellar network passphrase | `Test SDF Network ; September 2015` |
| `CIRCLE_FACTORY_ADDRESS` | Deployed factory contract ID | `C...` |
| `REPUTATION_ADDRESS` | Deployed reputation contract ID | `C...` |
| `USDC_ADDRESS` | USDC token contract ID | `C...` |
| `PORT` | API server port | `3001` |
| `START_LEDGER` | Ledger to start indexing from | `0` |

### `app/.env.local`

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_STELLAR_RPC_URL` | Soroban RPC endpoint |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | Network passphrase |
| `NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS` | Factory contract ID |
| `NEXT_PUBLIC_REPUTATION_ADDRESS` | Reputation contract ID |
| `NEXT_PUBLIC_USDC_ADDRESS` | USDC contract ID |
| `NEXT_PUBLIC_INDEXER_URL` | Indexer base URL (default: `http://localhost:3001`) |

---

## Contracts Reference

### `circle_factory`

| Function | Parameters | Description |
|----------|-----------|-------------|
| `initialize` | `admin, circle_wasm_hash, reputation_contract, usdc_token` | One-time setup |
| `create_circle` | `creator, members[], round_amount, round_deadline_ledgers` | Deploy a new circle |
| `get_circles` | — | List all deployed circle addresses |
| `get_circle_count` | — | Total number of circles |

### `circle`

| Function | Auth | Description |
|----------|------|-------------|
| `initialize` | factory | Set up members, amount, schedule |
| `join` | member | Lock collateral (1× round_amount) |
| `contribute` | member | Deposit round contribution |
| `payout` | anyone | Transfer pot to current round recipient |
| `mark_default` | anyone (post-deadline) | Flag + penalize a missed contribution |
| `close` | anyone (post-completion) | Release collateral to all members |
| `get_config` | — | Read circle configuration |
| `get_status` | — | `Pending / Active / Completed / Cancelled` |
| `get_current_round` | — | Current round index, recipient, deadline |
| `get_collateral` | — | Member's locked collateral balance |
| `get_defaults` | — | Member's missed-contribution count |

### `reputation`

| Function | Auth | Description |
|----------|------|-------------|
| `initialize` | deployer | Set admin |
| `increment` | member (via circle) | Add 1 completed round to score |
| `score` | anyone | Read a wallet's score |

---

## API Reference

Base URL: `http://localhost:3001`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Service health check |
| `GET` | `/circles` | List all circles (sorted by creation) |
| `GET` | `/circles/:address` | Circle detail + members |
| `GET` | `/circles/:address/members` | Members with reputation and contribution counts |
| `GET` | `/circles/:address/rounds` | Round history: payouts, contributions, defaults |
| `GET` | `/reputation/:member` | Wallet reputation score + participation history |

---

## Demo Flow

```
Step 1: Create circle
  → 4 members (Alice, Bob, Carol, Dave), $100/round, monthly

Step 2: Round 1 — all contribute
  Alice   contributes $100  ✅
  Bob     contributes $100  ✅
  Carol   contributes $100  ✅
  Dave    contributes $100  ✅
  → Contract pays $400 to Alice
  → Alice's reputation: 0 → 1 🏆

Step 3: Round 2 — Dave misses
  Alice   contributes $100  ✅
  Bob     contributes $100  ✅
  Carol   contributes $100  ✅
  Dave    MISSED             ❌
  → mark_default(Dave) called after deadline
  → Dave's collateral: $100 → $80 (20% penalty)
  → Dave's default count: 0 → 1 ⚠️

Step 4: Explorer
  → https://stellar.expert/explorer/testnet/contract/<circle_address>
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart contracts | Rust, Soroban SDK 21, WASM |
| Blockchain | Stellar Testnet (Soroban RPC) |
| Wallet | Freighter browser extension |
| SDK | TypeScript, @stellar/stellar-sdk 12 |
| Indexer | Node.js, Express, PostgreSQL, ts-node-dev |
| Frontend | Next.js 14 (App Router), Tailwind CSS, React 18 |
| Inf.ra | Docker Compose (Postgres), npm workspaces |

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make your changes, run tests
4. For contract changes: `cargo test` in `contracts/`
5. For TS changes: `npx tsc --noEmit` in the relevant package
6. Submit a pull request

---

## License

MIT © CircleUp Contributors
r3tkl