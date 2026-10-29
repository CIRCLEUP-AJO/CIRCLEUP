# Runtime Dependencies

A quick-audit view of each workspace's key runtime dependencies and their
current pinned major version. Run `npm outdated --workspaces` for the full
report.

## sdk (`@circleup/sdk`)

| Package | Major | Purpose |
|---------|-------|---------|
| `@stellar/stellar-sdk` | 17 | Stellar / Soroban RPC client, XDR, contract invocation |

## indexer (`@circleup/indexer`)

| Package | Major | Purpose |
|---------|-------|---------|
| `@stellar/stellar-sdk` | 17 | Soroban event polling, XDR decoding |
| `cors` | 2 | CORS middleware for Express |
| `dotenv` | 18 | Environment variable loading |
| `express` | 5 | REST API server |
| `express-rate-limit` | 8 | Per-route rate limiting |
| `pg` | 8 | PostgreSQL client / connection pool |
| `pino` | 9 | Structured JSON logging |

## app (`@circleup/app`)

| Package | Major | Purpose |
|---------|-------|---------|
| `@circleup/sdk` | 0.1 | SDK client (workspace dep) |
| `@stellar/stellar-sdk` | 17 | Wallet integration, contract calls |
| `@stellar/freighter-api` | 6 | Freighter wallet browser extension |
| `clsx` | 2 | Conditional className composition |
| `lucide-react` | 1 | Icon set |
| `next` | 16 | Next.js App Router (React 18/19) |
| `react` | 18 | UI runtime |
| `react-dom` | 19 | DOM rendering |

## scripts (`@circleup/scripts`)

| Package | Major | Purpose |
|---------|-------|---------|
| `@stellar/stellar-sdk` | 17 | Contract deployment, testnet seeding |
| `dotenv` | 18 | Environment loading for deploy scripts |
| `ts-node` | 10 | TypeScript execution for CLI scripts |

## Root

The root `package.json` has no direct runtime dependencies — it is a
workspace-only manifest that delegates to the four workspaces above.
The only root devDependency is `typescript`.

## Auditing

```bash
# Check for outdated packages across all workspaces
npm outdated --workspaces

# Audit for known vulnerabilities
npm audit --omit=dev --audit-level=high

# Rust dependency audit
cd contracts && cargo audit

# Rust license + advisory policy
cd contracts && cargo deny check licenses advisories
```
