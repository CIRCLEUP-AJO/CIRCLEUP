# Soroban Resource Budgets

Tracks CPU, memory, ledger read/write and event budgets for representative
circle workflows so regressions surface in CI before a release, not on
mainnet. Issue #868.

> **Local measurements do not guarantee mainnet inclusion.** Network limits,
> fees, surge pricing and protocol upgrades change independently of this
> repository. Always simulate the exact transaction against RPC before
> submitting it.

## Harness

`contracts/circle/tests/resource_budget_tests.rs`

For each tier and workflow the harness builds a fresh circle, drives it to the
point just before the target entry-point, calls it **once**, and reads the
host's per-invocation metering through `env.cost_estimate().resources()`
(soroban-sdk testutils, `InvocationResources`).

| Workflow     | Entry-point measured | Preceding state                                                   |
|--------------|----------------------|-------------------------------------------------------------------|
| `create`     | `initialize`         | Funded members, SAC token, reputation with circle authorized       |
| `join`       | `join` (last member) | All other members joined, so this call also activates the circle  |
| `contribute` | `contribute` (last)  | Active round 0, all other members contributed                     |
| `payout`     | `payout`             | Round 0 fully funded                                              |
| `default`    | `mark_default`       | Ledger advanced to `deadline_ledger + 1`, last member unpaid      |
| `cancel`     | `cancel`             | Pending, all but one member joined                                |
| `close`      | `close`              | Completed with every member's collateral still locked (max fan-out) |

| Tier      | Members | Mainnet-limit policy |
|-----------|---------|----------------------|
| `min`     | 2 (`MIN_MEMBERS`)   | **Must** fit mainnet per-invocation limits |
| `typical` | 8                   | **Must** fit mainnet per-invocation limits |
| `max`     | 256 (`MAX_MEMBERS`) | Report-only: overruns are warnings (see below) |

Recorded metrics: `instructions`, `mem_bytes`, `disk_read_entries`,
`memory_read_entries`, `write_entries`, `disk_read_bytes`, `write_bytes`,
`contract_events_size_bytes`.

### What the numbers do and do not include

- Contracts are registered **natively** (`register_contract`), so Wasm VM
  instantiation, Wasm execution and contract-code reads are **not** included.
  Instruction counts are a lower bound on real network cost.
- The harness disables SDK limit enforcement and uses an unlimited budget so
  the `max` tier can report overruns instead of aborting during setup. Limits
  are evaluated by the harness against the snapshot below.
- Transaction-size and signature-verification costs are not modelled.

## Tested toolchain

| Component | Version | Source |
|---|---|---|
| Rust | 1.81.0 | `contracts/rust-toolchain.toml`, CI `dtolnay/rust-toolchain` |
| soroban-sdk | 29.0.1 | `contracts/Cargo.lock` |
| Mainnet limits | SDK 29.x `InvocationResourceLimits::mainnet()` snapshot (2026-07-10) | copied into `mainnet::*` in the harness |

The harness constants `TOOLCHAIN_RUST`, `TOOLCHAIN_SOROBAN_SDK` and
`MAINNET_LIMITS_SNAPSHOT` are written into every report.

> **Toolchain note.** The published `soroban-sdk 29.0.0` manifest declares
> `rust-version = "1.91.0"`, while `rust-toolchain.toml` and CI pin 1.81.0.
> Reconcile this before treating any recorded baseline as authoritative; a
> toolchain bump is a baseline refresh event (below).

## Thresholds and tolerances

A measurement **regresses** when it exceeds its recorded baseline by more than:

| Metric | Tolerance | Rationale |
|---|---|---|
| `instructions` | +10 % | Cost-model and codegen changes between compiler/SDK versions |
| `mem_bytes` | +10 % | Same |
| `disk_read_bytes`, `write_bytes`, `events_bytes` | +5 % | Small XDR encoding differences |
| `*_entries` | +0 (exact) | Entry counts are deterministic for a given contract + SDK; any change is a real storage-access change |

Improvements beyond tolerance are not failures, but should be captured by a
baseline refresh so later regressions are measured from the new floor.

Mainnet snapshot limits used by the harness:

| Limit | Value |
|---|---|
| Instructions | 400,000,000 |
| Memory bytes | 41,943,040 |
| Disk read entries | 200 |
| Write entries | 200 |
| Disk read bytes | 200,000 |
| Write bytes | 132,096 |
| Contract event bytes | 16,384 |

### Current baseline status

All 21 cells in `BASELINES` are `None` (**unbaselined**). Values are
never hand-estimated. The first CI run on the pinned toolchain produces
`resource-report-*.json`, and those numbers get copied in. Until that
happens:

- regression comparison is skipped and each workflow is reported as
  `"baseline": "unbaselined"`;
- the min/typical mainnet-limit checks and the sanity checks (non-zero metering, `close`
  write fan-out scaling with member count) are still enforced;
- the release smoke matrix reports unbaselined workflows as warnings.

### `max` tier overruns

`close` at 256 members fans out over every member: one token transfer, one
`Collateral` write and one `collateral_released` event per member. That can
exceed the per-invocation event-size or write-entry limits. `initialize`
also scales with member count, because it stores and de-duplicates the
member list. If the report flags a `max` workflow, the
decision is a product one:
lower `MAX_MEMBERS`, batch the workflow across invocations, or accept that
such circles cannot complete on mainnet. Record that decision in the release
notes. Do not silently raise the tolerance.

## Running

```bash
# Print reports to stdout
cd contracts && cargo test -p circle --test resource_budget_tests -- --nocapture

# Write resource-report-{min,typical,max}.json (what CI does)
CIRCLEUP_RESOURCE_REPORT_DIR=../artifacts \
  cargo test -p circle --test resource_budget_tests -- --nocapture

# Fail when any cell is unbaselined (use once baselines are recorded)
CIRCLEUP_RESOURCE_BASELINE_STRICT=1 cargo test -p circle --test resource_budget_tests
```

Report schema: `circleup.resource-report.v1` (tier, members, toolchain,
mainnet limit snapshot, tolerance, disclaimer, and per-workflow metrics with
`exceeds_mainnet` and `baseline` status).

## Release integration

- **CI (`.github/workflows/ci.yml`, Contracts job):** the step
  "Soroban resource budget report (Issue #868)" runs the harness with
  `CIRCLEUP_RESOURCE_REPORT_DIR` and uploads the `resource-budget-report`
  artifact. A regression or a min/typical mainnet overrun fails the job.
- **Release smoke matrix (`scripts/src/smoke-test.ts`):** the
  `resource_budget_reports` check reads the reports from `--evidence-dir`
  (default `artifacts/`). Missing reports are a warning for testnet RCs and a
  **failure for mainnet RCs**. See
  [RELEASE_SMOKE_TEST_MATRIX.md](./RELEASE_SMOKE_TEST_MATRIX.md).

## Refreshing baselines

Refresh in the **same PR** as any of: a Rust toolchain change, a soroban-sdk
change, an edit to a measured entry-point or its storage layout, or a change to
the harness setup.

1. Make the toolchain/SDK/code change.
2. Run the harness with `CIRCLEUP_RESOURCE_REPORT_DIR=../artifacts` using the
   pinned toolchain (CI's artifact is the reference; local runs on another
   OS/toolchain are advisory only).
3. Copy each workflow's metrics from `resource-report-<tier>.json` into the
   matching `BASELINES` entry as `Some(Measurement { … })`.
4. If the toolchain or SDK changed, update `TOOLCHAIN_RUST`,
   `TOOLCHAIN_SOROBAN_SDK`, the `mainnet::*` constants (from the new SDK's
   `InvocationResourceLimits::mainnet()`), and the table above.
5. In the PR description, list every metric that moved by more than its
   tolerance and explain why. Reviewers reject unexplained increases.
6. Once all 21 cells are populated, enable
   `CIRCLEUP_RESOURCE_BASELINE_STRICT=1` in CI.
