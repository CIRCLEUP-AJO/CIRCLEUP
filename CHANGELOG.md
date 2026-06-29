# Changelog

All notable changes to CircleUp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0] — 2026-06-29

### Added
- `contracts/reputation` — on-chain score per wallet (Soroban)
- `contracts/circle` — full ROSCA lifecycle: join, contribute, payout, mark_default, close (Soroban)
- `contracts/circle_factory` — deploys and registers circle instances (Soroban)
- 15 Rust unit tests covering contribution accounting, rotation order, default penalties, reputation updates
- `sdk` — TypeScript client SDK wrapping every contract call
- `indexer` — Node.js event indexer writing to Postgres, REST API
- `app` — Next.js 14 frontend with Tailwind CSS and Freighter wallet integration
- `scripts/deploy.ts` — automated testnet deployment via stellar-cli
- `scripts/seed-demo.ts` — 4-member demo circle seed script
- Docker Compose for local Postgres
