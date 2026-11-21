# Changelog

All notable changes to CircleUp are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Fixed
- **Create-circle call and creator participation** (#873): the create form
  sent `create_circle` a `name` argument the factory does not accept. It now
  sends exactly `(creator, members, round_amount, round_deadline_ledgers)`.
  The form also refused the creator's own address with the claim "the
  creator is automatically a member", which was false (the factory never adds
  the creator); creators can now list themselves.
- **Incorrect product copy**: defaults no longer claim to "compensate
  affected members" (forfeited penalties stay in the contract), and payout
  order is no longer described as "recorded at join time" (it is fixed by
  list position at creation).
- **Pause documentation** (#876): `PAUSE_RECOVERY_SEMANTICS.md` wrongly said
  Completed and Cancelled circles cannot be paused and that paused time does
  not count against the round deadline. Both are corrected; a pause on a
  terminal circle blocks `close` until resume.

### Added
- **Terminal close semantics** (#875): `docs/TERMINAL_CLOSE_SEMANTICS.md`
  states that `close` is a single global settlement. It covers check order,
  per-member release rules, and the `total_expected_collateral` caveat for
  cancelled circles. `contracts/circle/tests/terminal_close_tests.rs` covers
  full, penalised and zero-collateral members, call orders, duplicate and
  stranger closes, and pause.
- **Default penalty rounding** (#874): `docs/DEFAULT_PENALTY_ROUNDING.md`
  documents the floor rule. New in this change: boundary, double-charge,
  depleted-balance and property tests
  (`default_penalty_boundary_tests.rs`), SDK `computeDefaultPenalty` /
  `projectCollateralAfterDefaults` / `PENALTY_ROUNDING`, and an app
  `previewDefaultPenalty` shown in the mark-default dialog.
- **Pause authority tests** (#876): `pause_semantics_tests.rs` and
  `circle_factory/tests/pause_authority_tests.rs` cover authority,
  transitions, terminal states, reads, deadlines, and the fact that
  factory-deployed circles cannot be paused. The indexer test pins that
  pause/resume never touch `status`.
- **Member order semantics** (#873): `docs/MEMBER_ORDER_SEMANTICS.md` traces
  the list end to end. New in this change: `member_order_tests.rs`
  (non-sorted 2-member and 256-member full cycles), SDK `payoutSchedule` /
  `recipientForRound` / `payoutSlotOf`, and app `buildCreateCircleArgs`.
- **Explicit SDK retry policy** (#900): `RETRY_POLICY` documents per-stage
  retry rules (bounded read retries with backoff, no wallet retries,
  submission resends only the identical envelope), and `classifyRpcFailure`
  classifies provider errors as throttled / transient / cancelled / permanent.
- **Stable SDK error taxonomy** (#901): `classifySdkError`, `classifyTxFailure`,
  `classifyWalletFailure` and `SdkError` map every failure to
  `{ stage, code, retry, retryable, txHash?, message }` with SDK-authored,
  log-safe messages. Unknown errors classify as `"unknown"`.
- **Typed transaction lifecycle** (#902): `txLifecycleFromResult` /
  `txLifecycleFromLookup` return `not_applied | submitted | pending |
  confirmed | failed | unavailable`, so a local polling timeout is never
  read as an on-chain failure. `CircleUpClient.waitForTransaction(hash)`
  resumes confirmation by hash without resubmitting.
- **Network identity binding** (#903): optional `CircleUpConfig.network`
  (`"testnet" | "mainnet" | "custom"`), `resolveNetworkIdentity`,
  `getNetworkIdentity`, `getResolvedConfig` and `explorerLink`. Inconsistent
  name / passphrase / preset-URL combinations are rejected at construction,
  and writes fail with the new `"network_mismatch"` code if the config is
  mutated afterwards.
- **Cursor pagination for history scans** (#898):
  `GET /circles/:address/activity` and `GET /members/:member/contributions`
  accept an opaque `?cursor=` keyset token with a deterministic tie-breaker.
  Cursor pages return `{ limit, hasMore, nextCursor }`, and page-mode
  envelopes also carry `nextCursor`. `?page=` is unchanged. The SDK adds
  `IndexerClient.getMemberContributionsByCursor`,
  `iterateMemberContributionsByCursor`, `getCircleActivityByCursor`,
  `iterateCircleActivityByCursor` and the `IndexerCursorPagination` /
  `CursorPageParams` types. See `docs/INDEXER_API_COMPATIBILITY.md`.
- **RPC read timeouts and cancellation** (#899): every RPC-backed SDK read
  (`getConfig`, `getStatus`, `getCurrentRound`, `getCollateral`,
  `getDefaults`, `hasContributed`, `getFullState`, `getScore`, factory reads,
  `lookupTransaction`) takes optional `ReadOptions { timeoutMs, signal }`. One
  deadline covers all retries, and the default is `DEFAULT_RPC_READ_TIMEOUT_MS`
  (20 s), configurable with `setReadTimeout`. A stopped read throws
  `RpcReadCancelledError` (`reason: "timeout" | "aborted"`), or sets
  `cancelled` on `*Result` / `lookupTransaction` failures, so it is never
  mistaken for a remote error. A stopped status lookup says explicitly that
  the transaction was not cancelled. Writes are unchanged.
- **Wallet adapter boundary** (#904): the SDK exports an optional
  `WalletAdapter` interface and `signWithWalletAdapter`, which refuses before
  any signing prompt with an explicit `WalletFailure` (`not_available`,
  `unsupported_capability`, `account_mismatch`, `network_mismatch`,
  `user_rejected`, …). It is types only, with no browser globals. The app's
  Freighter integration is now `freighterAdapter`
  (`app/src/lib/walletAdapter.ts`), and `submitContractTx` signs through it
  without changing the order of simulate, sign, send and poll.
- **Circle lifecycle transition matrix**: `contracts/circle/src/transition.rs`
  specifies the outcome of every public mutation in the Pending, Active,
  Completed, Cancelled, Paused and Closed conditions, along with the pause
  overlay rule. `contracts/circle/tests/transition_tests.rs` runs every cell
  against the contract. Each rejected call must leave status, round, counters,
  balances, collateral, reputation and events unchanged. The matrix is an
  exhaustively matched grid, so adding a status or mutation does not compile
  until the matrix covers it.
- **Factory registry paging**: new `get_circles_paginated(cursor, limit)`
  returns a `CirclePage { circles, next_cursor, total }`. Pages hold at most 50
  entries (`MAX_PAGE_SIZE`). New errors: `InvalidPageLimit` (110) and
  `CursorOutOfRange` (111). `get_circles` behaves as before. The SDK adds
  `FactoryClient.getCirclesPaginated`, `FactoryClient.getAllCirclesPaged`,
  `mapRawCirclePage`, `FactoryCirclePage` and `FACTORY_MAX_PAGE_SIZE`, plus ABI
  fixtures.
- **Registry ordering and cursor specification**: the registry is append-only
  and ordered by creation, and the cursor is the creation index. Specified in
  `contracts/circle_factory/src/registry.rs` and
  `contracts/circle_factory/README.md`, and tested for stable ordering
  across reads, appends and concurrent clients.
- **Registry storage-growth model**: design note at
  `docs/scalability/FACTORY_REGISTRY_GROWTH.md`. Constants in
  `contracts/circle_factory/src/scalability.rs` keep protocol limits separate
  from project thresholds: warning at 750 circles, high-water mark at 1,000.
  Boundary tests measure the serialized registry size against the model.
- **Issue #715**: Added `docs/CONTRACT_REFERENCE.md` as the canonical reference for
  all public methods, error codes, and authorization rules across the
  `circle_factory`, `circle`, and `reputation` contracts.  The README Contracts
  Reference section now links to it.  A coverage-drift check command is included
  so undocumented public entry-points are caught before they land.
- **Issue #716**: Added explicit secret-redaction guidance to `SECURITY.md`,
  `SUPPORT.md`, and the bug-report issue template.  Each surface now names the
  prohibited items (seeds, private keys, signed XDR, API credentials, production
  wallet addresses) with safe substitutes.  Vulnerabilities are routed to the
  private GitHub Security Advisory process.
- **Issue #717**: Added a "Protocol and Wire-Format Changes" section to
  `CONTRIBUTING.md` with per-category checklists covering contract events,
  method signatures, database schema, API response fields, SDK exports, and
  artifact-hash updates.  Each checklist item links to the affected file and
  includes a verification command.
- **Issue #718**: Added `docs/CONTRACT_SECURITY_CHECKLIST.md` — a structured
  review prompt for contract PRs covering authorization, arithmetic, token
  transfers, reentrancy, lifecycle, events, storage cost, and rollback
  semantics.  The PR template now includes an expandable contract-security
  section and two new checklist items; `CONTRIBUTING.md` Governance References
  links to the checklist.  The document explicitly states that completing the
  checklist does not replace a specialist security audit.

### Changed (SDK)
- **Strict RPC decoding** (`sdk/src/types.ts`): reads now fail at the
  decoding boundary, with the method or field named, on wrong variants, absent
  fields, and out-of-range values. New narrow decoders: `decodeI128`,
  `decodeU64`, `decodeU32InRange`, `decodeRecord`. `mapRawConfig` enforces
  distinct members (≤ 256), `round_amount ≥ 1`, and the contract's deadline
  bounds. `getCollateral` rejects negative values. `assertValidCircleStatus`
  now accepts the `#[contracttype]` enum wire form (`["Active"]`) that
  `get_status` actually returns, as well as a bare symbol. `createCircle`
  only reports a contract address as `circleAddress`.
- **Write retry safety** (`sdk/src/client.ts`): a write is never rebuilt
  inside the SDK. `sendTransaction` resends only the identical signed
  envelope. When a send may have reached the RPC without a reply, the SDK looks
  the locally computed hash up instead of reporting a retryable error.
  New `TxErrorCode`s: `outcome_unknown` (not retryable, carries
  `diagnostics: SubmissionDiagnostics`) and `tx_expired` (retryable — the
  envelope passed its time bound unincluded). **Behaviour change:** losing
  connectivity while polling an accepted transaction now returns
  `outcome_unknown` instead of `network_error`. `network_error` now always
  means the request never reached the RPC. Added
  `CircleUpClient.lookupTransaction(hash)`.
- **Indexer paging** (`IndexerClient`): query options are validated locally
  (`RangeError`, before any request), unknown keys are rejected instead of
  dropped, and responses must carry a pagination envelope matching the request.
  Added the bounded iterators `iterateCircles` / `iterateMemberContributions`
  (default 10 pages), `GetMemberContributionsParams`, `IndexerPagination`
  (incl. `hasMore`), `totalAmount` on contributions, and
  `INDEXER_DEFAULT_PAGE_SIZE` / `INDEXER_MAX_PAGE_SIZE`.
- **Public API boundary**: `package.json` now declares `exports` (root only) and
  `files`. Co-located `src/*.test.ts` files are no longer emitted to `dist/`.
  The test-only helpers `isTransientRpcError` and `withRpcRetry` are no longer
  exported from the package root. New release check `npm run check:api` (clean
  build, compile `examples/` against `dist/`, verify documented imports, and
  block deep imports) runs in CI.

### Fixed (SDK)
- Restored `formatMismatchMessage`, which `CircleClient.preflight` calls but a
  merge had removed, leaving `sdk/src/client.ts` unable to compile.

### Added
- **Issue #710**: Added a secret-safe, read-only mainnet readiness gate with
  explicit mainnet confirmation, manifest/address/token checks, artifact hash
  verification, and funding checks. The generic contract deployer is now
  testnet-only.
- **Issue #709**: New deployment manifests use schema 2 and checksum the full
  document. Schema 1 remains explicitly readable; unknown versions and network
  names fail validation.
- **Issue #707**: Added weekly Dependabot proposals and CI-enforced npm/Cargo
  license inventories with fail-closed SPDX policy.
- **Issue #708**: Declared supported Node.js/npm and pinned Rust/Soroban/WASM
  toolchains, added early Node/npm validation, and aligned CI and setup docs.
- **Issue 712**: Added a role-specific compromised/unavailable admin credential
  response procedure to `docs/RUNBOOK.md`, including the lack of admin rotation
  and the limits of pause, communication, and evidence preservation.
- **Issue 711**: Made the demo seeder testnet-only, manifest-validated, and
  explicit about always-create behavior. Added a public-only progress/history
  journal with transaction references and redacted failures.
- **Issue 714**: Added `docs/PROTOCOL_INVARIANTS.md`, linking protocol guarantees
  to enforcing contract entry points and executable tests while identifying
  unsupported behavior and maintenance requirements.
- **Issue 713**: Documented Soroban storage TTL and retention assumptions and
  added a test for reputation score renewal on increment; circle-key renewal
  remains unsupported.
- **Issue 32**: Bounded timeouts and categorised failures for SDK indexer
  requests (`sdk/src/client.ts`) — every `IndexerClient` request (connect,
  headers and body) is bounded by `DEFAULT_INDEXER_TIMEOUT_MS` (10 s,
  configurable per client and per call) and honours a caller `AbortSignal`.
  `IndexerError` gains `kind` (`network` | `timeout` | `aborted` | `http` |
  `json` | `schema`) and `retryable`; error messages never include full
  response bodies. Covered by `sdk/src/__tests__/indexerClient.test.ts`
- **Issue 34**: Indexer response compatibility checks
  (`sdk/src/indexerSchema.ts`, `docs/INDEXER_API_COMPATIBILITY.md`) — runtime
  wire schemas for list, detail, members, rounds, history, reputation, audit,
  health and state responses, with representative fixtures validated in
  `sdk/src/__tests__/indexerContract.test.ts`. Documents which response changes
  are additive and which need a coordinated release
- **Issue 35**: Opt-in `CircleUpClient.verifyDeployment()` (`sdk/src/client.ts`)
  — read-only, time-bounded check of the RPC network passphrase and the
  factory / reputation / USDC contract identities against the config, with a
  typed per-check result (`ok` | `mismatch` | `missing` | `incompatible` |
  `unreachable` | `skipped`). Construction stays offline. Covered by
  `sdk/src/__tests__/verifyDeployment.test.ts`
- **Issue 41**: Query-plan review for indexer indexes (`indexer/src/db/explain.ts`,
  `docs/QUERY_PLANS.md`, `indexer/src/db/migrations/006_status_and_history_composite_indexes.sql`)
  — `npm run explain` now reports cardinalities, per-query cost / time / scan
  nodes, and queries that miss their expected index. Adds composite indexes
  for `GET /circles?status=` and `GET /members/:member/contributions?circle=`,
  whose filter-only indexes forced a full Sort before LIMIT
- **Issue 477**: Address validation for every member entry on the create flow
  (`app/src/lib/address.ts`, `app/src/app/create/CreateClient.tsx`)
  — Added dependency-free strkey checksum verification (base32 decode +
  CRC16/XMODEM) as `hasValidStrKeyChecksum` / `isValidStellarAccount`, plus a
  per-row `validateMemberEntry` that `validateCreateForm` now applies to every
  filled member row. A string that is 56 base32 characters but fails its
  checksum — a single mistyped character or a truncated copy-paste — was
  accepted by the form and only failed later inside transaction construction,
  after the wallet prompt had already appeared. Each failure mode (lowercase,
  contract `C…`, muxed `M…`, bad shape, bad checksum) now reports its own
  `Member N:` message under the offending row. Covered by
  `app/src/__tests__/member-address-validation.test.ts` and the updated
  create-form, submission-guard, and member-list suites
- **Issue 30**: Contract argument compatibility fixtures (`sdk/src/__tests__/contractFixtures.test.ts`)
  — Base64-encoded XDR fixtures for every public contract method (factory, circle,
  reputation) that verify SDK argument encoding remains compatible with contract
  signatures across releases. Covers valid arguments and boundary cases for all
  22 contract methods. See `sdk/CONTRACT_FIXTURES.md` for maintenance guide
- **Issue 28**: Canonical event identity constraints (`indexer/src/db/migrations/003_event_dedup_constraints.sql`)
  — Added `event_index` column and unique index on `(ledger, tx_hash, event_index)`
  to enforce idempotency at the database layer rather than relying on application
  memory. Makes duplicate event delivery (from at-least-once polling) a silent
  no-op via `ON CONFLICT DO NOTHING`
- **Issue 29**: Exponential backoff for RPC polling (`indexer/src/indexer.ts`)
  — Temporary RPC failures (connection refused, timeout, rate limit) now trigger
  capped exponential backoff (1s → 2s → 4s → ... → 60s) with full jitter instead
  of hot-looping or immediate exit. Backoff resets after successful poll. Structured
  warnings at exponentially-spaced thresholds (3, 4, 8, 16, 32 failures) prevent
  log spam
- `docs/INDEXER_RELIABILITY.md` — Comprehensive design document covering atomic
  ledger checkpointing, event idempotency model, backoff policy, graceful shutdown,
  and monitoring recommendations
- `sdk/CONTRACT_FIXTURES.md` — Documentation for maintaining contract fixtures,
  debugging failed tests, and integrating with CI
- `indexer/src/backoff.test.ts` — 12 unit tests verifying backoff progression,
  jitter bounds, reset-after-success, warning thresholds, and cap enforcement
- `indexer/src/eventIdentity.test.ts` — 13 unit tests verifying `parseEventIndex`
  extraction, `createEventKey` stability, canonical identity properties, and
  duplicate detection across ledgers and transactions
- `indexer/src/indexer.ts` — `parseEventIndex()` function extracts event index
  from Soroban RPC event.id format (`ledger-txIndex-eventIndex`)
- `sdk/src/index.ts` — documented the public API surface at the package entry
  point: a grouped map (clients, errors, config & types, gating, utilities,
  constants, low-level encoders) states that the package root is the only
  supported import path and that deep paths / test modules carry no stability
  guarantee. Re-export order is annotated so each symbol has one canonical source
- `sdk/examples/public-api.ts` — side-effect-free fixture that imports every
  documented symbol from the package root (no deep or `../src` paths) and is
  type-checked by `sdk/examples/tsconfig.json`, so the public contract stays
  reachable-from-root and cannot silently regress
- `indexer/src/db/migrate.ts` — `checkMigrationHealth()` function that classifies
  the database schema state as one of five well-defined states: `clean`, `pending`,
  `drifted`, `partial`, or `uninitialized`; exported `SchemaHealthState` type and
  `MigrationHealth` interface for structured decisions at call sites
- `indexer/src/db/migrate.ts` — `--check` CLI flag: exits non-zero when schema is
  not clean so CI pipelines can gate deploys on schema health
- `indexer/src/db/replay.ts` — `prepareReplay()`: transactional re-index from a
  given ledger N; wipes derived tables, clears ingested-events dedup keys for the
  replay range, and resets the indexer cursor — all in one atomic transaction
- `indexer/src/db/replay.ts` — `replayPreflight()`: non-destructive pre-check
  that reports estimated event count, current cursor, and warnings without touching
  the database
- `indexer/src/db/replay.ts` — CLI entry point (`npm run replay -- --from=<N>`)
  with `--partial` (keep rows from earlier ledgers) and `--dry-run` flags
- `indexer/src/db/migrate.test.ts` — deterministic unit tests for all five
  `SchemaHealthState` transitions, the decision matrix, summary string content,
  `currentVersion` derivation, idempotence guard, transaction rollback safety,
  and `42P01` handling; integration tests (gated on `DATABASE_URL`) for live
  idempotence, drifted-state detection, and ghost-entry flagging
- `indexer/src/db/replay.test.ts` — unit tests for input validation, cursor math,
  `fullWipe` forcing, SQL range selection, table wipe strategies, transaction
  commit/rollback paths, and preflight warnings; integration tests for full and
  partial replay semantics and preflight non-mutation guarantee
- `indexer` boot sequence now logs a prominent `SCHEMA WARNING` for `drifted` or
  `partial` states after migrations run, surfacing drift before the poller starts
- SDK: caller correlation metadata on every write. Mutation methods (`join`,
  `contribute`, `payout`, `markDefault`, `close`, `createCircle`) accept an
  optional `{ metadata }` (a flat bag of scalar identifiers, e.g.
  `{ operation: "join-circle", uiRequestId: "req_8a1f" }`) that is echoed back on
  the resulting `TxResult` — present on failures too, so a UI action ties to a tx
  hash whether it confirmed or failed
- SDK: `sanitizeTxMetadata` security boundary strips secrets before metadata is
  ever echoed or logged — drops keys named like secrets (`secret`, `seed`,
  `signed`, `xdr`, `apiKey`, …), Stellar secret-seed values under any key,
  over-long strings (signed XDR), and all non-scalars; caps at 32 keys
- SDK: opt-in structured tx logging via `CircleUpClient.setTxLogger`. A registered
  `TxLogger` receives log-safe `TxLogEvent`s across the write lifecycle
  (`simulated` → `submitted` → `confirmed` | `failed`) carrying the contract,
  method, tx hash, ledger/error code, and sanitised correlation metadata — never
  the signing key, its secret, the signed XDR, or the raw arguments. A throwing
  logger can never change a transaction's outcome
- `sdk/src/__tests__/txMetadata.test.ts` — unit tests for `sanitizeTxMetadata`
  (secret/payload/non-scalar stripping, key cap, no-mutation/frozen output) and
  the write path (metadata echoed on success and failure results, log lifecycle
  ordering and log-safe fields, correlation preserved across retried attempts,
  end-to-end threading through `CircleClient.join`)

### Changed
- **Indexer numeric wire format** (#897): every numeric response field now
  has exactly one documented JSON type (`docs/INDEXER_NUMERIC_WIRE_FORMAT.md`).
  Amounts are decimal strings, persisted BIGINT ledgers are decimal strings,
  and counters and computed ledgers are safe JSON integers. Migration notes:
  `GET /members/:member/circles` now returns `circle.deadline_ledger` as a JSON
  integer (it used to be a string). The SDK schemas no longer accept either
  form for ledger fields. The SDK types `ApiCircleRow.created_ledger`,
  `round_deadline_ledgers`, `roundDeadlineLedgers` and `ApiRoundRow.ledger`
  are narrowed to `string`.
- **Issue 31**: Event ingestion is now fully restart-safe — the indexer cursor and
  all event projections (circles, contributions, payouts, etc.) are written in a
  single database transaction per ledger. On crash before commit, the transaction
  rolls back and restart processes the same ledger again (idempotent via dedup
  constraints). On crash after commit, restart resumes from the next ledger. The
  cursor is always read from the database (never from memory) on startup
- **Issue 29**: Poll error handling now applies jittered backoff wait inside the
  error catch block before allowing the next tick, preventing hot loops during
  sustained RPC outages
- `indexer/src/indexer.ts` — `ingestEventInTx()` now inserts `event_index` column
  for canonical identity-based deduplication alongside the legacy `event_key` column
- `indexer/src/db/schema.sql` — `ingested_events` table now includes `event_index`
  column and unique index on `(ledger, tx_hash, event_index)` for database-enforced
  idempotency
- `indexer/src/index.ts` — imports `checkMigrationHealth` and runs a post-migration
  health check on every boot; non-clean states emit a `SCHEMA WARNING` log line
  rather than aborting so the indexer keeps serving data in ambiguous situations
- `indexer/package.json` — added `migrate:check`, `replay`, and `replay:dry-run`
  scripts; added `src/db/replay.test.ts` to the `test` script
- Homepage hero copy rewritten around what the visitor does and gets
- Homepage circles fetch is memoized per render, so the hero count, the heading
  count and the list can no longer disagree
- `sdk/src/utils.ts` — `usdcToStroops` now routes both `string` and `number`
  input through one exact string-parsing path that expands JavaScript exponent
  notation (`1e-7`, `1e+21`) losslessly and counts only *significant* decimals.
  Valid small/large numeric amounts such as `0.0000001` now convert exactly
  instead of throwing, while `> 7`-decimal precision, negatives, non-finite
  numbers, and malformed exponents are rejected with specific messages. Also
  documented USDC units/precision and that `formatUsdc` truncates (never rounds
  up) so a displayed amount can never overstate the true balance

### Fixed
- `app/src/lib/config.ts` — `usdcToStroops` silently discarded any digits beyond
  7 decimal places (`frac.padEnd(7, "0").slice(0, 7)`), so an over-precise amount
  was signed for a *different* value than the user entered. It now rejects excess
  precision (and handles exponent notation) identically to the SDK. Realigned the
  other money helpers with `sdk/src/utils.ts` too: added the missing negative /
  `NaN` guards to `stroopsToUsdc` and `formatUsdc`, and the non-integer / negative
  member-count guard to `formatPot` (a fractional count previously made
  `BigInt(memberCount)` throw)
- SDK: every read (`getConfig`, `getStatus`, `getCircles` and the rest) failed with
  `this.source.sequenceNumber is not a function`. The read path built its
  transaction from an account stub that was missing that method, and it always
  reached that stub because it looked up a throwaway account that never exists on
  chain. Reads now use a fixed placeholder source and make no account lookup at all
- SDK: a transaction the RPC declined to queue (`TRY_AGAIN_LATER`) was polled for
  the full confirmation budget and then reported as a timeout, hiding the fact that
  it simply needed resubmitting
- SDK: an RPC that stops advancing its ledger answers `NOT_FOUND` forever, which was
  indistinguishable from a slow ledger and consumed the whole timeout budget
- SDK: `scI128` accepted numbers above `Number.MAX_SAFE_INTEGER`, which round
  silently on conversion to `bigint` and would have signed a payment for the wrong
  amount
- SDK: the test suite could not run. Every fixture used placeholder addresses that
  the config validator and the address encoder both reject, and several files mocked
  the read helper with a raw value rather than its result type
- Homepage returned a 500 after a 60-second hang when the indexer refused the
  connection, so the "indexer is unreachable" banner never reached the user
- `app/src/app/create/page.tsx` — restored to a thin server-component wrapper
  delegating to `CreateClient`; a bad merge had replaced it with all the
  client-side hook logic, causing 55 TypeScript errors at build time
- `app/src/components/WalletButton.tsx` — removed dead code block referencing
  `result`, `setConnectState`, and `setErrorMsg` left behind after a state-machine
  refactor; tightened `(err as any)` cast to `(err as Error)`
- `indexer/src/db/migrate.ts` — partial-state summary now lists both the pending
  file names and the missing-on-disk file names; previously only the missing names
  were shown, leaving operators without enough information to act

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
