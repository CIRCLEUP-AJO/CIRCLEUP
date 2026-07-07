# Changelog

All notable changes to CircleUp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- Nothing yet — be the first contributor!

---

## [0.1.0] — 2026-07-07

### Added
- `contracts/reputation` — on-chain completed-rounds score per wallet (Soroban)
- `contracts/circle` — full ROSCA lifecycle: `join`, `contribute`, `payout`, `mark_default`, `close`
- `contracts/circle_factory` — deploys and registers circle contract instances
- 15 Rust unit tests covering contribution accounting, rotation order, default penalties, reputation updates
- `sdk` — TypeScript client SDK wrapping every contract call (`FactoryClient`, `CircleClient`, `ReputationClient`)
- `sdk/src/constants.ts` — shared network passphrases, RPC URLs, USDC decimals, ledger-per-day constants
- `indexer` — Node.js event indexer polling Soroban events into Postgres
- `indexer/src/api.ts` — Express REST API (`/circles`, `/circles/:address`, `/reputation/:member`)
- `indexer/src/db/schema.sql` — full Postgres schema
- `app` — Next.js 14 frontend with Tailwind CSS and Freighter wallet integration
- 5 app routes: `/`, `/create`, `/circles/[address]`, `/reputation/[member]`, `/_not-found`
- `scripts/deploy.ts` — automated testnet deployment via stellar-cli
- `scripts/seed-demo.ts` — 4-member $100/round demo circle seed script
- Docker Compose for local Postgres
- GitHub Actions CI (TypeScript build, Rust WASM compile, ESLint)
- MIT License, Apache 2.0 License
- Code of Conduct (Contributor Covenant)
- Security policy with coordinated disclosure process
- Issue templates (bug report, feature request)
- Pull request template
- 5 README badges (CI, MIT, Stellar, Next.js, Rust)

### Fixed
- `circle/Cargo.toml` — moved `reputation` testutils to `[dev-dependencies]` only
- `indexer/package.json` — corrected `start` script to point to compiled `.js`
- `scripts/seed-demo.ts` — removed duplicate `path` import and wrong `.env` path coupling
- `sdk/src/client.ts` — removed 6 unused imports
- `soroban-sdk` pinned to `21.7.7` across all contracts to fix `ed25519-dalek v3` / `ChaCha20Rng` conflict
- `circle_factory` — `sha256()` returns `Hash<32>` in SDK 21.7.7; added `.into()` for `BytesN<32>` conversion
