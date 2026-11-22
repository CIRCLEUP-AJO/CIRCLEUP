# Release Smoke-Test Matrix

This is the release-readiness checklist for every CircleUp release candidate
(RC), covering four layers (contracts, SDK, indexer, app) and two targets
(testnet, mainnet). Issue #865.

**Guarantee.** The smoke-test command is **non-mutating** on every network. It
never deploys, migrates or submits a transaction. Write-based smoke scenarios
can only run through `runGatedTestnetWrites` (`scripts/src/smoke-write-gate.ts`),
which refuses mainnet outright: there is no override flag.

## Verification command

```bash
# Testnet RC (missing evidence = warning)
npm run smoke-test --workspace=scripts -- --manifest=deployments/testnet.json --evidence-dir=artifacts

# Mainnet RC (missing evidence = FAILURE; read-only)
npm run smoke-test:mainnet --workspace=scripts -- --manifest=deployments/mainnet.json --evidence-dir=artifacts

# Machine-readable report for sign-off records
npm run release:verify --workspace=scripts -- --env=mainnet --manifest=… --json > smoke-report.json
```

Exit code `1` when any check fails. `--layers=contracts,sdk,indexer,app,writes`
selects a subset.

## Existing scripts, tests and CI jobs by layer

| Layer | Existing coverage | Where |
|---|---|---|
| Contracts | `cargo test` (all crates), `cargo audit`, `cargo deny` | CI **Contracts**, **Dependency license policy** |
| Contracts | Reproducible Wasm build + hash check | `reproducibility.yml`, `scripts/src/check-artifact-hashes.ts`, `contracts/expected-hashes.json`, `contracts/provenance.json` |
| Contracts | Resource budget report (#868) | CI **Contracts** → `resource-budget-report` artifact; [RESOURCE_BUDGETS.md](./RESOURCE_BUDGETS.md) |
| Contracts | Storage compatibility fixtures (#867) | `contracts/*/tests/storage_compatibility_tests.rs`, `contracts/fixtures/storage/`; [STORAGE_COMPATIBILITY.md](./STORAGE_COMPATIBILITY.md) |
| SDK | Build, `vitest` suite, public API check (`check:api`), contract fixture tests, `npm audit` | CI **SDK** |
| SDK | Versioned RPC/transaction fixtures | `sdk/src/fixtures/versionedRpcFixtures.ts`, [CONTRACT_FIXTURES.md](./CONTRACT_FIXTURES.md) |
| Indexer | Build, typecheck, tests (incl. `db/migrate.test.ts`, `health.test.ts`) against Postgres | CI **Indexer** |
| Indexer | Migration status/check | `npm run migrate:status` / `migrate:check --workspace=indexer` |
| Indexer | Health endpoints | `GET /health`, `/health/live`, `/health/ready`, `/readyz` (`indexer/src/api.ts`) |
| App | Typecheck, production `next build`, `vitest`, visual regression | CI **App**, **Scripts** |
| App | Deployment manifest | `scripts/src/deployment-manifest.ts` (`validate-manifest`) |
| Release | Changelog/version/migration-note checks | `scripts/src/release-check.ts` |
| Release | Mainnet readiness | `scripts/src/mainnet-readiness.ts` |

## Smoke checks run by `smoke-test.ts`

`T` = testnet RC, `M` = mainnet RC. "warn" means the check is reported but
does not fail the run; **fail** blocks the release.

| Layer | Check | Evidence read | Missing evidence (T / M) |
|---|---|---|---|
| contracts | `artifact_hashes` | `contracts/expected-hashes.json` | fail / fail |
| contracts | `artifact_provenance` | `contracts/provenance.json` | per check |
| contracts | `manifest_hash_alignment` | manifest Wasm hashes vs expected hashes | skip without manifest |
| contracts | `resource_budget_reports` | `<evidence-dir>/resource-report-{min,typical,max}.json` | warn / **fail** |
| contracts | `storage_compat_fixtures` | `contracts/fixtures/storage/{circle,circle_factory,reputation}.*.json` | warn / **fail** |
| sdk | `sdk_build`, `sdk_package_integrity` | `sdk/dist`, `sdk/package.json` | per check |
| sdk | `sdk_transaction_fixtures` | `sdk/src/fixtures/versionedRpcFixtures.ts` | warn / **fail** |
| indexer | `indexer_migrations`, `indexer_schema`, `indexer_migrate_script` | `indexer/migrations`, schema, package scripts | per check |
| app | `env_examples`, `no_committed_secrets` | `*/.env.example`, absence of `.env` | per check |
| app | `deployment_manifest` | `--manifest` validated by `validateManifest` | skip / **fail** |
| app | `app_production_build` | `app/.next/BUILD_ID` | warn / **fail** |
| writes | `testnet_write_gate` | env only (see below) | skip / skip (fail if requested on mainnet) |

Resource report content rules: `regressed` in any tier means **fail**; a mainnet-limit
overrun in `min`/`typical` means **fail**; an overrun in `max` is a warning; `unbaselined`
is a warning.

## Required checks and artifacts per target

| Requirement | Testnet RC | Mainnet RC |
|---|---|---|
| All CI jobs green on the RC commit | Required | Required |
| `smoke-test` exit 0 | Required | Required (`--env=mainnet`) |
| Deployment manifest (`deployment-manifest.ts`, integrity hash valid, network matches) | Recommended | **Required** |
| Wasm hashes in manifest equal `expected-hashes.json` | Required if manifest given | **Required** |
| `resource-budget-report` CI artifact attached | Recommended | **Required** |
| No min/typical resource overrun; any max overrun has a documented decision | Required | **Required** |
| Storage compatibility tests pass; layout changes have a migration plan | Required | **Required** |
| SDK public API check passes or the break is in release notes | Required | **Required** |
| Indexer `migrate:check` clean on the target DB; `/health/ready` OK after deploy | Required | **Required** |
| App production build from the RC commit | Required | **Required** |
| Disposable testnet write scenarios (`runGatedTestnetWrites`) | Optional | **Never run** |
| `smoke-report.json` archived with the sign-off | Recommended | **Required** |

## Write-based smoke tests (disposable testnet only)

Write scenarios must call `runGatedTestnetWrites(environment, scenario)`. The
scenario runs only if **all** of the following hold:

| Condition | Variable |
|---|---|
| Environment is `testnet` (mainnet is always refused) | `--env` / argument |
| Explicit opt-in | `SMOKE_TESTNET=true` |
| Testnet passphrase (mainnet passphrase is rejected) | `SMOKE_NETWORK_PASSPHRASE` |
| Non-mainnet RPC and Horizon URLs | `SMOKE_RPC_URL`, `SMOKE_HORIZON_URL` |
| Disposable account acknowledged | `SMOKE_DISPOSABLE_ACCOUNT=true` |
| Valid signer (secret never logged) | `SMOKE_TESTNET_PUBLIC_KEY`, `SMOKE_TESTNET_SECRET` |
| Funding ≥ 50 XLM via read-only Horizon lookup | checked immediately before the run |

CI never sets `SMOKE_TESTNET`, so the gate reports `skip` there. Setting
`SMOKE_TESTNET=true` for a mainnet RC is reported as a **failure**.

## Sign-off criteria

A release candidate may be promoted only when:

1. Every row marked Required for its target is satisfied.
2. `smoke-test` exits 0 for the target environment, and the JSON report is
   attached to the release record (tag, release PR, or deployment ticket).
3. Each remaining **warning** has a named owner and a written reason in the
   release notes. Unbaselined resource cells and max-tier overruns are
   acceptable only on that basis.
4. Two reviewers sign off for mainnet: one contracts owner and one
   app/indexer owner.

## Rollout blocking rules

- **Any failing check blocks rollout.** Do not re-run until green, and do not
  bypass a failing check by passing `--layers` to skip it.
- A failed check on a mainnet RC is never downgraded to a warning for that RC.
  Fix the evidence or cut a new RC.
- If a check fails after a partial deployment, stop. Do not deploy the
  remaining layers. Follow [DEPLOYMENT_LIFECYCLE.md](./DEPLOYMENT_LIFECYCLE.md)
  and [RUNBOOK.md](./RUNBOOK.md) for rollback or forward-fix.
- A storage layout change without passing compatibility tests and a migration
  plan ([STORAGE_COMPATIBILITY.md](./STORAGE_COMPATIBILITY.md)) blocks any
  release that ships the changed contract.
