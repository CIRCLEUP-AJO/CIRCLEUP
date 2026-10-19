# CircleUp — Contract Event Payloads

This document is the single source of truth for every event emitted by the
CircleUp smart contracts. The indexer, SDK, and frontend all rely on these
shapes; any on-chain change to a topic or data tuple **must** be reflected here,
in the schema registry `indexer/src/eventSchemas.ts`, in the fixtures
`indexer/src/fixtures/event-fixtures.ts`, and in the corresponding
`parseXxxEvent` / handler in `indexer/src/indexer.ts`.

Related documents:
- [EVENT_COMPATIBILITY.md](EVENT_COMPATIBILITY.md) — versioning rules, unknown-event
  quarantine, fixture maintenance.
- [LIFECYCLE_EVENT_MATRIX.md](LIFECYCLE_EVENT_MATRIX.md) — which event (or
  derivation rule) every user-visible lifecycle transition comes from.

---

## Encoding rules

Events are Soroban `env.events().publish(topics, data)` calls. The Stellar SDK
deserialises them with `scValToNative`. The shapes described below use the
native-decoded types after that call:

| Soroban type | Native-decoded type |
|---|---|
| `Symbol` | `string` |
| `Address` | `string` (strkey, C- or G-prefix) |
| `u32` | `number` |
| `u64` | `bigint` |
| `i128` | `bigint` |
| `Vec<Address>` | `string[]` |
| `bool` | `boolean` |
| tuple `(A, B, C)` | `[A, B, C]` (`Array`) |

**Filter key:** Every event has two symbol topics:
`topic[0]` = contract family (`"factory"`, `"circle"`, `"reputation"`),
`topic[1]` = event name. The indexer uses both to route events. (The legacy
`reputation/increment` shape carries a third `Address` topic.)

---

## Factory events

Contract: `CIRCLE_FACTORY_ADDRESS` (env var)

### `factory` / `circle_created`

Emitted at the end of a successful `create_circle` call, after the new circle
has been deployed, initialised, and registered in the factory registry.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"factory"` |
| 1 | `Symbol` | `"circle_created"` |

**Data** — tuple `(Address, Address, u32)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` (C-prefix) | Contract ID of the newly deployed circle |
| 1 | `creator` | `string` (G-prefix) | Wallet that authorised `create_circle` |
| 2 | `circle_index` | `number` | Zero-based factory counter **before** this create. After the event the stored `CircleCount` is `circle_index + 1`. |

**Invariants**
- `circle_index` equals `CircleCount` read immediately before the deploy; it is
  also mixed into the deploy salt together with `creator`, ledger sequence, and
  ledger timestamp to guarantee address uniqueness.
- A failed `create_circle` (validation error, deploy failure, init failure) never
  emits this event and never increments `circle_index`.
- After this event the factory registry (`Circles` + `CircleCount`) has already
  been updated atomically; the indexer can read both in the same ledger.

**Indexer handler:** `handleFactoryCircleCreated` in `indexer/src/indexer.ts`  
**Parser:** `parseCircleCreatedEvent` (exported for unit testing)

---

## Circle events

Contract: per-circle address (discovered from `factory/circle_created`)

All circle events share `topic[0] = "circle"`.

### `circle` / `initialized`

Emitted once at the end of `initialize`, confirming the circle is set up and
ready to accept members.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"initialized"` |

**Schema version:** 2

**Data** — tuple `(Address, u32, i128, Vec<Address>)`

| Index | Field | Type | Since | Description |
|-------|-------|------|-------|-------------|
| 0 | `circle_address` | `string` | v1 | This circle's own contract address |
| 1 | `member_count` | `number` | v1 | Number of configured members (= total rounds) |
| 2 | `round_amount` | `bigint` | v1 | USDC contribution per member per round (stroops) |
| 3 | `members` | `string[]` | v2 | Payout rotation in order; index = `payout_order` |

`members` is a trailing, backwards-compatible addition. Events from v1
contract builds stop at index 2; the indexer still projects them but cannot
create `circle_members` rows for those circles.

**Indexer note:** The indexer uses this event to backfill `member_count`,
`total_rounds`, and `round_amount` on the `circles` row that was created by
the `factory/circle_created` handler.  The factory event does not carry those
fields, so they are written as `0` placeholders at creation time and updated
here.  Because `circle/initialized` fires inside the **same transaction** as
`factory/circle_created` (the circle's `initialize` is called synchronously by
the factory's `create_circle`), both events are processed in the same indexer
ledger batch, guaranteeing the row is complete by the time the batch commits.
For v2 payloads it also inserts one `circle_members` row per rotation slot
(`payout_order` = index in `members`), which `circle/joined` and
`circle/default` then update.

**Parser:** `parseInitializedEvent` (exported for unit testing)

---

### `circle` / `joined`

Emitted when a member successfully locks collateral and joins the circle.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"joined"` |

**Data** — tuple `(Address, Address, u32, i128)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | This circle's contract address |
| 1 | `member` | `string` | Member who joined |
| 2 | `order` | `number` | 1-based join-queue position (1 = first, N = last / triggers Active) |
| 3 | `collateral` | `bigint` | Collateral locked by this member (stroops) |

**Invariants**
- `order` is in `[1, member_count]`.
- When `order == member_count` the circle has transitioned to Active and the
  `circle/active` event follows in the same transaction.

**Indexer handler:** `handleCircleJoined` — updates `circle_members.joined_at`,
`join_order` and `collateral`. If the member row does not exist (circle
initialized by a v1 build) the event fails visibly into `event_failures`
instead of updating zero rows.

---

### `circle` / `active`

Emitted immediately after the last member joins, signalling the circle has
transitioned from Pending to Active and the round-0 deadline clock has started.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"active"` |

**Data** — tuple `(Address, u64)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | This circle's contract address |
| 1 | `deadline_ledger` | `bigint` | Round-0 contribution deadline, started at activation |

**Indexer handler:** `handleCircleActive` — sets `circles.status = 'Active'`

---

### `circle` / `contributed`

Emitted when a member submits a contribution for the current round.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"contributed"` |

**Data** — tuple `(Address, Address, u32, i128)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | Circle contract address |
| 1 | `member` | `string` | Member who contributed |
| 2 | `round_index` | `number` | Zero-based round index this contribution applies to |
| 3 | `amount` | `bigint` | Amount contributed in stroops (equal to `round_amount`) |

**Indexer handler:** `handleCircleContributed` — inserts `contributions` row

---

### `circle` / `payout`

Emitted after the round's designated recipient receives the pooled pot.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"payout"` |

**Data** — tuple `(Address, Address, i128, u32)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | Circle contract address |
| 1 | `recipient` | `string` | Member who received the payout |
| 2 | `amount` | `bigint` | Total pot paid out in stroops (`round_amount × member_count`) |
| 3 | `round_index` | `number` | Zero-based round index that was paid out |

**Invariants**
- `amount` equals `round_amount × member_count` (overflow-safe: the factory and
  circle both pre-check this at init/create time).
- After this event `current_round` advances to `round_index + 1`; if all rounds
  are complete the circle transitions to Completed.

**Indexer handler:** `handleCirclePayout` — inserts `payouts` row, advances
`circles.current_round`

---

### `circle` / `default`

Emitted when a member is marked as having missed the contribution deadline for
the current round. A penalty is deducted from their collateral.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"default"` |

**Data** — tuple `(Address, Address, i128, u32, i128)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | Circle contract address |
| 1 | `member` | `string` | Member who defaulted |
| 2 | `penalty` | `bigint` | Amount deducted from collateral in stroops (`round_amount × PENALTY_BPS / BPS_DENOM`) |
| 3 | `round_index` | `number` | Zero-based round index the default applies to |
| 4 | `new_collateral` | `bigint` | Member's remaining collateral after deduction in stroops |

**Invariants**
- `penalty = round_amount × 2000 / 10000` (20 % of round amount).
- `new_collateral = old_collateral - penalty` (clamped to 0 if exhausted).
- A member can be marked default at most once per round.

**Indexer handler:** `handleCircleDefault` — inserts `defaults` row, increments
`circle_members.defaults`

---

### `circle` / `completed`

Emitted when the last round's payout confirms that all rounds have been paid out
and the circle's ROSCA cycle is complete.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"completed"` |

**Data** — tuple `(Address, u32)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | This circle's contract address |
| 1 | `member_count` | `number` | Number of rounds that were paid out |

**Indexer handler:** `handleCircleCompleted` — sets `circles.status = 'Completed'`

---

### `circle` / `cancelled`

Emitted when a Pending circle is cancelled before all members have joined.
Collateral locked by early joiners is released via a subsequent `close` call.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"cancelled"` |

**Data** — tuple `(Address, Address, u32)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | Circle contract address |
| 1 | `caller` | `string` | Address that triggered cancellation |
| 2 | `ledger` | `number` | Ledger sequence at cancellation |

**Indexer handler:** `handleCircleCancelled` — sets `circles.status = 'Cancelled'`,
writes a `circle_audit_events` row

---

### `circle` / `collateral_released`

Emitted inside `close` once per member whose remaining collateral is returned.

**Topics** — `("circle", "collateral_released")`

**Data** — tuple `(Address, Address, i128)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | Circle contract address |
| 1 | `member` | `string` | Member whose collateral was released |
| 2 | `collateral` | `bigint` | Stroops returned to the member |

**Indexer note:** not projected (schema handling `ignored`). The aggregate is
taken from `circle/closed` `total_released`; see the derivation rule in
[LIFECYCLE_EVENT_MATRIX.md](LIFECYCLE_EVENT_MATRIX.md).

---

### `circle` / `closed`

Emitted when all remaining collateral (and any unreleased funds) have been
returned to members after a Completed or Cancelled circle is closed.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"closed"` |

**Data** — tuple `(Address, Address, i128, i128, Symbol)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | Circle contract address |
| 1 | `closer` | `string` | Address that triggered `close` |
| 2 | `total_released` | `bigint` | Total USDC returned to members in stroops |
| 3 | `total_expected_collateral` | `bigint` | Original collateral sum (before any penalties) in stroops |
| 4 | `reason` | `string` | Human-readable close reason (`"completed"` or `"cancelled"`) |

**Invariants**
- `total_released ≤ total_expected_collateral` (penalties reduce the actual
  amount released when members defaulted).

**Indexer handler:** `handleCircleClosed` — sets `circles.status = 'Closed'`,
writes `total_released` and `close_reason` (columns added by migration 007),
writes a `circle_audit_events` row

---

### `circle` / `paused`

Emitted when the circle admin pauses the circle. All fund-moving operations
(`join`, `contribute`, `payout`, `mark_default`, `close`) are blocked until
a matching `resumed` event.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"paused"` |

**Data** — tuple `(Address, Address, u32)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | Circle contract address |
| 1 | `admin` | `string` | Admin that issued the pause |
| 2 | `ledger` | `number` | Ledger sequence at which the pause took effect |

**Indexer handler:** `handleCirclePaused` — sets `circles.paused = TRUE`

---

### `circle` / `resumed`

Emitted when the circle admin resumes a paused circle. Fund-moving operations
are re-enabled immediately.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"circle"` |
| 1 | `Symbol` | `"resumed"` |

**Data** — tuple `(Address, Address, u32)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `circle_address` | `string` | Circle contract address |
| 1 | `admin` | `string` | Admin that issued the resume |
| 2 | `ledger` | `number` | Ledger sequence at which the resume took effect |

**Indexer handler:** `handleCircleResumed` — sets `circles.paused = FALSE`

---

## Reputation events

Contract: `REPUTATION_ADDRESS` (env var)

All reputation events share `topic[0] = "reputation"`.

### `reputation` / `increment` (legacy)

**Not emitted by the current reputation contract** — it publishes only
`score_updated` (below). This shape is documented and still handled so that
ledgers emitted by earlier builds replay correctly.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"reputation"` |
| 1 | `Symbol` | `"increment"` |

**Data** — `u32` (new total score)

| Field | Type | Description |
|-------|------|-------------|
| `score` | `number` | Member's new cumulative reputation score |

**Member address:** encoded as `topic[2]` (a third topic `Address`).

**Invariants**
- Only callers registered via `add_authorized_caller` (factory-deployed circles)
  can emit this event.
- Score is monotonically non-decreasing — a member's reputation can only grow.

**Indexer handler:** `handleReputationIncrement` — upserts `reputation` row

---

### `reputation` / `score_updated`

Emitted on every successful `increment` call. Carries both the member address
and the full new score.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"reputation"` |
| 1 | `Symbol` | `"score_updated"` |

**Data** — tuple `(Address, u32)`

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | `member` | `string` | Member address |
| 1 | `new_total_score` | `number` | Member's new cumulative score |

**Indexer handler:** `handleReputationScoreUpdated` — upserts `reputation` row

---

### `reputation` / `caller_added`

Emitted when the factory registers a new circle as an authorized reputation
caller.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"reputation"` |
| 1 | `Symbol` | `"caller_added"` |

**Data** — `Address`

| Field | Type | Description |
|-------|------|-------------|
| `circle` | `string` | Circle contract address that was granted call rights |

**Indexer note:** not projected (schema handling `ignored`); read
`get_authorized_callers` on-chain.

---

### `reputation` / `caller_removed`

Emitted when the factory de-registers a circle from the authorized caller list.

**Topics**

| Index | Type | Value |
|-------|------|-------|
| 0 | `Symbol` | `"reputation"` |
| 1 | `Symbol` | `"caller_removed"` |

**Data** — `Address`

| Field | Type | Description |
|-------|------|-------------|
| `circle` | `string` | Circle contract address that had its call rights revoked |

**Indexer note:** not projected (schema handling `ignored`); read
`get_revoked_callers` on-chain.

---

## Event ordering guarantees

1. Within a single transaction events are emitted in source-code order; the
   indexer processes them in `event.id` ascending order to preserve this.
2. `factory/circle_created` is always the last event in a successful
   `create_circle` transaction — the circle's own `circle/initialized` event
   fires before it (inside the `invoke_contract` call at step 5).
3. `circle/active` fires in the same transaction as the last member's
   `circle/joined` event. The indexer relies on this to advance status in one
   ledger batch.
4. `circle/completed` fires in the same transaction as the final round's
   `circle/payout` event.

## Stability contract

Topics (topic[0] and topic[1]) and the **order and types** of data tuple fields
are considered stable. Adding a new trailing field to a data tuple is a
backwards-compatible change; reordering or removing fields is a breaking change
that requires a new event name.

The full rules — version decisions, how the indexer quarantines unknown and
incompatible shapes, and how fixtures are maintained — are in
[EVENT_COMPATIBILITY.md](EVENT_COMPATIBILITY.md).

Any event change must:
1. Update this document.
2. Update the schema entry in `indexer/src/eventSchemas.ts` (bump `version`
   and mark new trailing fields with `since`).
3. Update the fixture in `indexer/src/fixtures/event-fixtures.ts` (keep the
   previous shape as a historical fixture while old ledgers must replay).
4. Update the corresponding `parseXxxEvent` / `handleXxxEvent` pair in
   `indexer/src/indexer.ts` and the projection test in
   `indexer/src/eventSchemas.test.ts`.
5. Bump the relevant contract version comment in the Rust source.
