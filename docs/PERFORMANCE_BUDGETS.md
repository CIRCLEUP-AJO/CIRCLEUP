# Performance Budgets

## Overview

The performance budget suite (`tests/perf/perf-budget.test.ts`) gates API payload
size, serialization/mapping cost, render-preparation cost, and app bundle size.

The suite is **offline and deterministic**:

- No live Stellar RPC.
- No PostgreSQL dependency.
- No real user records — all fixtures are generated from deterministic seeds.

## Fixture tiers

Fixture sizes live in [`tests/perf/fixture-profiles.json`](../tests/perf/fixture-profiles.json)
and the row builders live in [`tests/perf/fixtures.ts`](../tests/perf/fixtures.ts).

| Tier        | Circles | Members (detail) | Contributions |
| ----------- | ------- | ---------------- | ------------- |
| `small`     | 10      | 10               | 10            |
| `typical`   | 50      | 32               | 50            |
| `highWater` | 100     | 256 (`MAX_MEMBERS`) | 100        |

Row shapes mirror `indexer/src/db/schema.sql` (snake_case columns). A
"Fixture schema conformance" test asserts every generated row's keys are a
subset of the schema column set, so fixtures cannot silently drift from the DB
shape. When `schema.sql` changes, update `fixtures.ts` in the same PR.

## What is measured

- **API payload size** — JSON byte size of list/detail payloads per tier.
- **Serialization / mapping time** — an offline **proxy** for query cost. It is
  not real DB query time; real query plans are verified with
  `npm run explain --workspace=indexer`.
- **Render preparation time** — time to build the payload the app renders.
- **Bundle size** — read from `app/.next/build-manifest.json`; skipped when the
  app has not been built.

## Baseline update criteria

Budgets may only change when there is measured evidence:

1. Include **before/after** measured values in the PR description.
2. Include the **command** used to measure.
3. Explain **why** the previous budget was wrong (or why the regression is
   accepted).
4. A **maintainer must sign off** on any budget change.

This policy is also encoded in `tests/perf/budgets.json` under `baselinePolicy`.

## How to run

```bash
npm run build --workspace=app   # optional: exercises bundle budgets
npm run test:perf
```

CI runs a dedicated **Performance budgets** job that builds the app and then
runs `npm run test:perf`. The job is blocking — reviewed regressions fail CI.

## Relationship to `profiles/*.env`

`profiles/*.env` are **deployment environment profiles** (network, RPC URLs,
etc.). They are unrelated to the perf fixture profiles in
`tests/perf/fixture-profiles.json`.
