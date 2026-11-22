# CircleUp Event Catalog

This document provides a complete reference for all events emitted by the CircleUp contracts. Events are part of the permanent public history and are used by the indexer to project state into PostgreSQL.

## Event Schema Versioning

- **Topics** (family + name) are immutable for a given event name
- **Data fields** can be appended (backward compatible) but not reordered or removed
- A breaking change requires a new event name (e.g., `payout_v2`)
- See `indexer/src/eventSchemas.ts` for the machine-readable registry

---

## Factory Events

### `factory/circle_created`

Emitted when a new circle is successfully deployed, initialized, and registered.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("factory", "circle_created")` | Stable filter keys |
| Data | `(circle_address: Address, creator: Address, circle_index: u32)` | Tuple of three fields |

**Fields:**
1. `circle_address` — Contract ID of the newly deployed circle
2. `creator` — Wallet that authorized `create_circle`
3. `circle_index` — Zero-based factory counter **before** this create; after the event `CircleCount = circle_index + 1`

**Introduced:** v1 (initial release)

**Indexing:** Projected to `circles` table; `circle_index` used for ordering

---

## Circle Events

### `circle/initialized`

Emitted at the end of `initialize` with the circle's configuration.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "initialized")` | Stable filter keys |
| Data | `(circle_address: Address, member_count: u32, round_amount: i128, members: Vec<Address>)` | Tuple of 3-4 fields |

**Fields:**
1. `circle_address` — This circle's address (matches emitting contract)
2. `member_count` — Number of configured members
3. `round_amount` — USDC stroops per member per round
4. `members` — **v2+** Full member list for indexer projection (optional in v1)

**Introduced:** v1 (member_count, round_amount); v2 (members)

**Indexing:** Creates `circle_members` rows; v2 enables projection without RPC calls

---

### `circle/joined`

Emitted when a member locks collateral to join the circle.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "joined")` | Stable filter keys |
| Data | `(circle_address: Address, member: Address, join_order: u32, collateral: i128)` | Tuple of four fields |

**Fields:**
1. `circle_address` — This circle's address
2. `member` — Member who joined
3. `join_order` — 1-based position in join queue (N triggers Active transition)
4. `collateral` — USDC stroops locked (equals `round_amount × COLLATERAL_MULTIPLIER`)

**Introduced:** v1

**Indexing:** Updates `circle_members.collateral`, triggers Active transition when `join_order == member_count`

---

### `circle/active`

Emitted when the last member joins and the circle transitions to Active.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "active")` | Stable filter keys |
| Data | `(circle_address: Address, deadline_ledger: u64)` | Tuple of two fields |

**Fields:**
1. `circle_address` — This circle's address
2. `deadline_ledger` — Ledger after which contributions are rejected for round 0

**Introduced:** v1

**Indexing:** Marks circle as Active; starts round 0 deadline countdown

---

### `circle/contributed`

Emitted when a member deposits their round contribution.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "contributed")` | Stable filter keys |
| Data | `(circle_address: Address, member: Address, round_index: u32, amount: i128)` | Tuple of four fields |

**Fields:**
1. `circle_address` — This circle's address
2. `member` — Contributor
3. `round_index` — Which round this contribution belongs to
4. `amount` — USDC stroops transferred (equals `round_amount`)

**Introduced:** v1

**Indexing:** Updates `contributions` table; triggers payout eligibility check

---

### `circle/payout`

Emitted when the pot is transferred to the round recipient.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "payout")` | Stable filter keys |
| Data | `(circle_address: Address, recipient: Address, amount: i128, round_index: u32)` | Tuple of four fields |

**Fields:**
1. `circle_address` — This circle's address
2. `recipient` — Address that received the pot
3. `amount` — Total USDC stroops paid (`round_amount × member_count`)
4. `round_index` — Which round was settled

**Introduced:** v1

**Indexing:** Updates `payouts` table; triggers reputation increment

---

### `circle/default`

Emitted when a member is penalized for missing the round deadline.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "default")` | Stable filter keys |
| Data | `(circle_address: Address, member: Address, penalty: i128, round_index: u32, new_collateral: i128)` | Tuple of five fields |

**Fields:**
1. `circle_address` — This circle's address
2. `member` — Member who was penalized
3. `penalty` — USDC stroops deducted (20% of current collateral)
4. `round_index` — Round in which default occurred
5. `new_collateral` — Member's collateral balance after penalty

**Introduced:** v1

**Indexing:** Updates `defaults` table; adjusts member collateral

---

### `circle/round_started`

Emitted after payout advances to the next round (except final round).

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "round_started")` | Stable filter keys |
| Data | `(circle_address: Address, round_index: u32, recipient: Address, deadline_ledger: u64)` | Tuple of four fields |

**Fields:**
1. `circle_address` — This circle's address
2. `round_index` — The new round that opened
3. `recipient` — Address scheduled to receive this round's pot
4. `deadline_ledger` — Ledger after which contributions are rejected

**Introduced:** v1

**Indexing:** Creates new round row; resets contribution tracking

---

### `circle/exceptional_settlement`

Emitted when `settle_round` resolves a round with partial contributions.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "exceptional_settlement")` | Stable filter keys |
| Data | `(circle_address: Address, recipient: Address, pot: i128, round_index: u32, defaulted_count: u32)` | Tuple of five fields |

**Fields:**
1. `circle_address` — This circle's address
2. `recipient` — Address that received the partial pot
3. `pot` — USDC stroops actually transferred (may be < full pot)
4. `round_index` — Round that was settled
5. `defaulted_count` — Members who did not contribute

**Introduced:** v1

**Indexing:** Marks round as exceptional; distinguishes from full-contribution payout

---

### `circle/completed`

Emitted after the final round payout.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "completed")` | Stable filter keys |
| Data | `(circle_address: Address, member_count: u32)` | Tuple of two fields |

**Fields:**
1. `circle_address` — This circle's address
2. `member_count` — Total rounds completed (equals configured members)

**Introduced:** v1

**Indexing:** Marks circle as Completed; enables `close`

---

### `circle/cancelled`

Emitted when a Pending circle is cancelled before filling.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "cancelled")` | Stable filter keys |
| Data | `(circle_address: Address, caller: Address, ledger: u32)` | Tuple of three fields |

**Fields:**
1. `circle_address` — This circle's address
2. `caller` — Member who triggered cancellation
3. `ledger` — Ledger sequence at cancellation

**Introduced:** v1

**Indexing:** Marks circle as Cancelled; enables `close`

---

### `circle/collateral_released`

Emitted during `close` for each member with positive collateral.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "collateral_released")` | Stable filter keys |
| Data | `(circle_address: Address, member: Address, collateral: i128)` | Tuple of three fields |

**Fields:**
1. `circle_address` — This circle's address
2. `member` — Recipient of released collateral
3. `collateral` — USDC stroops returned

**Introduced:** v1

**Indexing:** Ignored (aggregate tracked via `closed` event)

---

### `circle/closed`

Emitted once at the end of `close` after all collateral is released.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "closed")` | Stable filter keys |
| Data | `(circle_address: Address, closer: Address, total_released: i128, total_expected_collateral: i128, reason: Symbol)` | Tuple of five fields |

**Fields:**
1. `circle_address` — This circle's address
2. `closer` — Member or admin who triggered settlement
3. `total_released` — Sum of all released collateral
4. `total_expected_collateral` — What would have been released with zero penalties
5. `reason` — `"completed"` or `"cancelled"`

**Introduced:** v1

**Indexing:** Finalizes circle; `total_expected - total_released = total penalties forfeited`

---

### `circle/paused`

Emitted when the circle is paused by the admin.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "paused")` | Stable filter keys |
| Data | `(circle_address: Address, admin: Address, ledger: u32)` | Tuple of three fields |

**Fields:**
1. `circle_address` — This circle's address
2. `admin` — Address that triggered pause
3. `ledger` — Ledger sequence at pause

**Introduced:** v1

**Indexing:** Records pause state for audit trail

---

### `circle/resumed`

Emitted when a paused circle is resumed by the admin.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("circle", "resumed")` | Stable filter keys |
| Data | `(circle_address: Address, admin: Address, ledger: u32)` | Tuple of three fields |

**Fields:**
1. `circle_address` — This circle's address
2. `admin` — Address that triggered resume
3. `ledger` — Ledger sequence at resume

**Introduced:** v1

**Indexing:** Records resume state for audit trail

---

## Reputation Events

### `reputation/score_updated`

Emitted when a member's reputation score increases.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("reputation", "score_updated")` | Stable filter keys |
| Data | `(member: Address, new_total_score: u32)` | Tuple of two fields |

**Fields:**
1. `member` — Member whose score increased
2. `new_total_score` — Updated score after increment

**Introduced:** v1

**Indexing:** Updates `reputation` table

---

### `reputation/increment`

**Legacy event** — kept for historical replay. Current contracts emit `score_updated`.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("reputation", "increment", member: Address)` | Three topics |
| Data | `(score: u32)` | Bare u32 value |

**Introduced:** Legacy; deprecated in favor of `score_updated`

**Indexing:** Handled for replay compatibility

---

### `reputation/caller_added`

Emitted when a circle is authorized to award reputation points.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("reputation", "caller_added")` | Stable filter keys |
| Data | `(circle: Address)` | Bare address |

**Introduced:** v1

**Indexing:** Ignored (authorization read from `get_authorized_callers`)

---

### `reputation/caller_removed`

Emitted when a circle's authorization is revoked.

| Part | Shape | Description |
|------|-------|-------------|
| Topics | `("reputation", "caller_removed")` | Stable filter keys |
| Data | `(circle: Address)` | Bare address |

**Introduced:** v1

**Indexing:** Ignored (revocation read from `get_revoked_callers`)

---

## Event Ordering Guarantees

Within a single transaction:

1. All events are emitted in the order the contract executes operations
2. The indexer preserves this order when inserting to PostgreSQL
3. Events from different transactions are ordered by `(ledger, tx_index, event_index)`

For compound operations:

- **payout**: `payout` → `round_started` (if not final) or `completed` (if final)
- **settle_round**: `default` (per defaulted member) → `exceptional_settlement` → `payout` → `round_started`/`completed`
- **close**: `collateral_released` (per member) → `closed`
- **create_circle**: `circle/initialized` (from circle) → `factory/circle_created`

---

## Compatibility Rules

1. **Never remove** an existing data field
2. **Never reorder** existing data fields
3. **Never change** the type of an existing field
4. **Never change** topic names for existing events
5. **Appending** new trailing fields is backward compatible
6. **Breaking changes** require a new event name (e.g., `payout_v2`)

When adding a new field:
- Add it as the **last** field in the tuple
- Document it in this catalog with `since: <version>`
- Update `indexer/src/eventSchemas.ts` with the new version
- Add a decoder test for the new field

---

## Fixture Tests

See `indexer/src/fixtures/event-fixtures.ts` for encoded event fixtures that verify decoder correctness. Each event in this catalog has a corresponding fixture test.