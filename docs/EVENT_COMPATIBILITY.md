# CircleUp — Event Versioning and Compatibility Rules

Contract event topics and data tuples are a **public integration contract**.
The indexer replays them from genesis to rebuild its projections, so a change
to an event's layout or meaning can break historical replay or, worse, project
wrong data without anyone noticing. This document sets the rules for changing
events and explains how the indexer handles shapes it does not recognise.

Field-level schemas live in [EVENTS.md](EVENTS.md). The machine-readable copy
is the registry in `indexer/src/eventSchemas.ts`. Every consumed event has an
entry there, and the indexer checks every event against it before running a
handler.

---

## 1. Inventory

| Contract | Event | Schema version | Indexer handling |
|---|---|---|---|
| factory | `circle_created` | 1 | projected |
| circle | `initialized` | **2** (`members` added) | projected |
| circle | `joined` | 1 | projected |
| circle | `active` | 1 | projected |
| circle | `contributed` | 1 | projected |
| circle | `payout` | 1 | projected |
| circle | `default` | 1 | projected |
| circle | `round_started` | 1 | projected |
| circle | `exceptional_settlement` | 1 | projected |
| circle | `completed` | 1 | projected |
| circle | `cancelled` | 1 | projected |
| circle | `collateral_released` | 1 | ignored (derivation rule) |
| circle | `closed` | 1 | projected |
| circle | `paused` | 1 | projected |
| circle | `resumed` | 1 | projected |
| reputation | `score_updated` | 1 | projected |
| reputation | `increment` | 1 (legacy, no longer emitted) | projected |
| reputation | `caller_added` | 1 | ignored (on-chain allowlist) |
| reputation | `caller_removed` | 1 | ignored (on-chain allowlist) |

"Ignored" means the shape is still validated and documented, but no projection
is written. The reason is recorded in the registry's `notes` and in
[LIFECYCLE_EVENT_MATRIX.md](LIFECYCLE_EVENT_MATRIX.md).

---

## 2. Versioning rules

A version number belongs to one `(family, name)` pair, starts at 1, and is
stored as `version` in the registry.

### Backwards-compatible changes (same event name, bump `version`)

- **Appending a trailing field** to a data tuple. Declare it in the registry
  with `since: <new version>`. Older events that lack it still match. Example:
  `circle/initialized` v2 appended `members: Vec<Address>`.

Consumers must ignore trailing fields they do not know. The indexer does this:
an event with *more* fields than its newest known version still projects, using
the fields it understands (see the fixture "circle/contributed with unknown
trailing field").

### Breaking changes (new event name, explicit decision)

- Removing, reordering or retyping a field.
- Changing a field's meaning or unit (e.g. stroops → whole USDC), even with the
  type unchanged.
- Moving data between topics and payload.
- Changing the topic count or the family namespace.

A breaking change **must** ship as a new event name (e.g. `payout_v2`) next to
the old one for as long as the old one can appear in replayed ledgers. The PR
must include:

1. A note in the PR description recording the version decision ("breaking →
   `payout_v2`", or "compatible → `payout` v2, trailing field `foo`").
2. A new registry entry, a new handler, and updates to [EVENTS.md](EVENTS.md) and
   [LIFECYCLE_EVENT_MATRIX.md](LIFECYCLE_EVENT_MATRIX.md).
3. Fixtures for both the old and the new shape (section 4).

Changing a field in place, without a new name, is never allowed. The indexer
would quarantine every new event (section 3). A change that happened to keep
the types but alter the meaning would be projected wrongly and go unnoticed,
which is why it counts as breaking.

### Retiring an event

An event the contracts no longer emit stays in the registry while any ledger
the indexer may replay could contain it. `reputation/increment` is an example.
Mark it as legacy in `notes` and in EVENTS.md. Remove it only once `START_LEDGER`
is past the last ledger that emitted it.

---

## 3. Unknown and incompatible events

Before choosing a handler, `classifyEvent` (`indexer/src/eventSchemas.ts`)
sorts every event from a watched contract into one of four outcomes:

| Outcome | Meaning | What the indexer does |
|---|---|---|
| `projected` | Known event, payload matches a supported version | Runs the handler |
| `ignored` | Known event, deliberately not projected | Nothing (no failure) |
| `unknown` | Topic not in the registry, missing topics, or unknown family | **Quarantine** |
| `incompatible` | Known topic, but the payload matches no supported version: too few fields, wrong field types, wrong topic count, or a `circle_address` field that differs from the emitting contract | **Quarantine** |

**Quarantine** means the event is never projected. It is still visible and can
be recovered:

- `routeEvent` gives it a handler that throws `UnsupportedEventError`.
  `processLedger` rolls back that event's savepoint, so the event is **not**
  recorded in `ingested_events`. It writes a payload-free row to
  `event_failures` with `error_name = 'UnsupportedEventError'` and a message
  naming the event type and the reason (for example
  `field 3 (round_index): expected u32`).
- The error is classified `permanent`, so the ledger still commits and the
  indexer moves on instead of retrying in a hot loop.
- Operators can see quarantined events through `GET /indexer/failures` and
  through the open-failure count in `GET /health`.
- **Recovery:** deploy an indexer that understands the new shape (registry
  entry + handler), then run
  `npm run replay --workspace=indexer -- --retry-failed`. The cursor rewinds to
  the oldest open failure, the event ingests normally, and its failure row is
  resolved in the same transaction. Events that already committed keep their
  dedup rows, so nothing is applied twice.
- If an operator decides a quarantined event is safe to ignore, they
  acknowledge it in `event_failures` (`acknowledged_at`, `acknowledged_note`)
  rather than deleting it.

Before quarantine existed, unknown circle events and events with fewer than two
topics were dropped silently. A payload with swapped fields could be projected
with values in the wrong columns.

---

## 4. Fixtures

`indexer/src/fixtures/event-fixtures.ts` holds typed fixtures, each field
tagged with its Soroban kind:

- `SUPPORTED_EVENT_FIXTURES`: exactly one fixture per registry entry, in the
  newest shape the contracts emit.
- `COMPATIBLE_VARIANT_FIXTURES`: historical shapes that must still replay
  (e.g. `initialized` v1) and forward-compatible additions.
- `QUARANTINED_VARIANT_FIXTURES`: shapes that must be rejected (reordered,
  truncated or retyped fields, a mismatched emitter, unknown names and
  families).

`indexer/src/eventSchemas.test.ts` encodes every fixture to real `xdr.ScVal`
values and runs it through the same decode → classify → route path as the
live poller. Projected fixtures then go through their handler with a recording
Postgres client, and the test compares the SQL parameters field by field with
the event payload. The test fails if:

- a registry entry has no supported fixture, or its fixture is not at the
  newest version;
- a fixture's classification changes; or
- a handler writes a value that differs from the event payload.

**Maintenance rules**

1. A PR that changes an emitted event in `contracts/` updates its fixture in
   the same PR. The contract-side test for the payload (e.g.
   `test_initialized_event_carries_rotation_as_trailing_field` in
   `contracts/circle/src/tests.rs`) pins the emitted shape on that side.
2. Never edit a fixture just to make a failing test pass. A supported fixture
   that stops classifying as `projected` means the change is breaking, so
   apply section 2.
3. When a shape is superseded, move the old fixture to
   `COMPATIBLE_VARIANT_FIXTURES` and keep it for as long as the event is kept
   in the registry.
