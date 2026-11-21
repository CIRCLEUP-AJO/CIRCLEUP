# Issue 120 (#956): Separate read-only browsing from write-configuration failures

## Problem

Configuration is checked as one undivided set, so a missing write dependency can look like a read outage or block pages that only read.

### Current inventory

| Where | What it reads | Behaviour today |
|---|---|---|
| `app/src/lib/config.ts` `assertEnvVars()` | `REQUIRED_ALWAYS`: `NEXT_PUBLIC_STELLAR_RPC_URL`, `NEXT_PUBLIC_NETWORK_PASSPHRASE`, `NEXT_PUBLIC_INDEXER_URL` | **Throws at module load on the server.** A missing RPC URL (needed only for writes and contract reads) crashes every page, including indexer-only browsing |
| same | `REQUIRED_IN_PRODUCTION`: `CIRCLE_FACTORY_ADDRESS`, `REPUTATION_ADDRESS`, `USDC_ADDRESS` | In production, missing write addresses also crash every page |
| same, exports | `STELLAR_RPC_URL`, `NETWORK_PASSPHRASE`, `INDEXER_URL` | Fall back to testnet or `http://localhost:3001` defaults, so in development "absent" and "configured" can't be told apart |
| `app/src/app/page.tsx`, `circles/[address]/page.tsx` | `INDEXER_URL` | Each has its own copy of `isValidUrl()` and reports `misconfigured` |
| `app/src/app/reputation/[member]/page.tsx` | `INDEXER_URL` | Indexer read |
| `app/src/lib/stellar.ts` | `STELLAR_RPC_URL`, `NETWORK_PASSPHRASE`, `REPUTATION_ADDRESS` | `getRpc()`, `invokeContract()`, `readContract()`, `getReputationScore()` |
| `app/src/app/create/page.tsx` | `CIRCLE_FACTORY_ADDRESS` | Checks for empty only at submit time ("Factory contract not configured") |
| `CircleDetailClient.tsx` | wallet via `getWalletAddress()`, `invokeContract` | Write buttons render whatever the RPC/passphrase config is |
| `USDC_ADDRESS` | not read by any app route | Required in production even though no app code uses it. Confirm whether `create` should pass it to the factory |

## Capabilities

| Capability | Required config | Used by |
|---|---|---|
| **public-read** | `INDEXER_URL` | `/`, `/circles`, `/circles/[address]` (data), `/reputation/[member]` |
| **contract-read** | `STELLAR_RPC_URL`, `NETWORK_PASSPHRASE`, plus the contract address being read (`REPUTATION_ADDRESS` for scores) | Live reputation score, freshness check ([Issue 123](issue-123-detail-partial-data.md)) |
| **transaction-write** | contract-read config, plus a wallet (Freighter installed and connected) and, per action, `CIRCLE_FACTORY_ADDRESS` (create) or the circle address from the route (join / contribute / payout / close). `USDC_ADDRESS` is needed where a flow uses it | Create, Join, Contribute, Payout, Release Collateral |

The wallet is runtime state, not configuration, but it is reported in the same typed shape so the UI can name the exact cause.

### Per-field states

```ts
type FieldState =
  | { state: "ok"; value: string }
  | { state: "absent" }                          // unset or blank
  | { state: "malformed"; detail: string };      // e.g. not http(s), bad StrKey

type CapabilityState =
  | { state: "available" }
  | { state: "unconfigured"; fields: Array<{ key: string; problem: "absent" | "malformed" }> }
  | { state: "unreachable"; service: "indexer" | "rpc" };   // runtime, from fetch/RPC failure
```

- **absent**: env var unset or whitespace.
- **malformed**: URL isn't absolute `http(s)`, or the contract address fails `StrKey.isValidContract` (`C…`, 56 chars).
- **unreachable**: config is valid but the request failed. This is set by the fetching code at runtime, never by `config.ts`.

## Design

### `config.ts`

- Remove the module-load `throw`. Replace it with `getCapabilities(env = process.env)`, which returns `{ publicRead, contractRead, transactionWrite }` as `CapabilityState`s. It is pure and unit-testable, like the existing `getMissingEnvVars`.
- Stop silently defaulting in exports. Export the parsed `FieldState`s. Keep testnet defaults only behind an explicit `NODE_ENV === "development"` path, and label them as defaults in the banner ("Using testnet RPC default").
- Log all problems once at server start (`console.warn` in dev, `console.error` in prod) so operators still get the loud signal the throw used to give, without taking down read routes.
- Move the duplicated `isValidUrl()` into `config.ts`.

### UI states

One `CapabilityBanner` component, with copy that names the capability:

| Cause | Where shown | Copy (example) |
|---|---|---|
| public-read unconfigured | Page body in place of the list or detail | "Circle data can't load: `NEXT_PUBLIC_INDEXER_URL` is missing." |
| public-read unreachable | Same | "The indexer is unreachable. Circle data may be out of date." |
| contract-read unconfigured | Inline next to live-score or freshness widgets | "Live on-chain data is unavailable on this deployment." |
| transaction-write unconfigured | Action panel and create form, **not** a page-level alert | "Transactions are disabled: the factory contract address isn't configured." |
| wallet missing / not connected | Action panel | Existing "Connect your wallet" guidance |

When public-read is available, a write-config problem never uses the amber "Circles list unavailable" / "Could not load circle details" alerts.

### Action gates

- `CircleDetailClient` and `create/page.tsx` receive `transactionWrite` as a prop from their server parent, so the state is known at first render with no flash of enabled buttons.
- Each gate checks, in order: write config, then wallet, then data (Issue 123). It returns the first failing reason, which the user sees next to the disabled button.
- `invokeContract()` gets a defensive check that refuses to run if contract-read or write config isn't `ok`, as defense in depth.

## Test plan

| Case | Env | Expect |
|---|---|---|
| Read-only deployment | only `INDEXER_URL` set | `/`, `/circles/[address]`, `/reputation/[member]` render indexer data with no read error banner. Action panel says transactions are disabled. Create submit disabled |
| Missing factory only | everything but `CIRCLE_FACTORY_ADDRESS` | Detail page writes enabled (with a wallet). Create disabled with the factory reason |
| Malformed address | `CIRCLE_FACTORY_ADDRESS=not-an-address` | `malformed` reason, create disabled |
| Missing RPC | no `STELLAR_RPC_URL` (prod mode) | Reads work. All writes and live scores disabled with the RPC reason. No crash at module load |
| Missing indexer | no `INDEXER_URL` | Public-read unconfigured banner. Not reported as "unreachable" |
| Indexer down | valid URL, fetch rejects | "unreachable" copy, distinct from unconfigured |
| Wallet absent | full config, no Freighter | Wallet reason, not a config reason |
| `getCapabilities` unit | table of env objects | Exact `CapabilityState` per capability, including `absent` vs `malformed` |

## Acceptance criteria mapping

- *Users can tell read config, wallet state and write config apart.* Each cause has its own typed state and banner copy.
- *A missing transaction dependency doesn't label indexer data unavailable.* The module-load throw is gone and write states render only in action areas.
- *No write is enabled with incomplete configuration.* Server-provided `transactionWrite` gates the buttons, and `invokeContract` has its own check.
