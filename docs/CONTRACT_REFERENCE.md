# CircleUp — Contract Method and Event Reference

This document is the canonical reference for all public entry-points and events
across the three CircleUp smart contracts: `circle_factory`, `circle`, and
`reputation`.

**Source of truth rules:**
- Method signatures, error codes, and authorization rules are owned by this
  document and the Rust source.  If they diverge, the Rust source wins and this
  document must be updated.
- Event wire shapes are owned by **[`docs/EVENTS.md`](EVENTS.md)**.  This
  document links to the relevant section for each event rather than duplicating
  the payload tables.
- SDK argument fixtures are owned by **[`sdk/CONTRACT_FIXTURES.md`](../sdk/CONTRACT_FIXTURES.md)**.
  Those XDR fixtures detect signature drift in CI.

**Coverage drift detection:** every public entry-point in the three contract
sources must appear in this document.  To check for undocumented entry-points:

```bash
# List all pub fn items in the three contract contractimpl blocks
grep -n "pub fn" contracts/circle_factory/src/lib.rs \
                 contracts/circle/src/lib.rs \
                 contracts/reputation/src/lib.rs
```

If the output contains a function not listed below, open an issue to add it
before the PR lands.

---

## CircleFactory contract

**Address:** `CIRCLE_FACTORY_ADDRESS` (environment variable; see
[`docs/RUNBOOK.md`](RUNBOOK.md)).

**Deployment:** deployed once per network.  The factory holds the WASM hash of
the circle contract and deploys circle instances on demand.

---

### `initialize`

```
initialize(
    env:                  Env,
    admin:                Address,
    circle_wasm_hash:     BytesN<32>,
    reputation_contract:  Address,
    usdc_token:           Address,
)
```

**Authorization:** permissionless on first call; panics with
`FactoryError::AlreadyInitialized` if called again.  The deployer is expected to
call this immediately after uploading the WASM — no other address can call it
first because storage is empty.

**What it does:** stores `admin`, `circle_wasm_hash`, `reputation_contract`, and
`usdc_token` in contract instance storage.  Sets and then clears
`DataKey::Initializing` as a reentrancy guard.

**Returns:** nothing.

**Errors:**

| Code | Name | Condition |
|------|------|-----------|
| 108 | `AlreadyInitialized` | Called after a previous successful `initialize` |
| 109 | `InitializeInProgress` | Reentrant call landed while `initialize` was in progress |

**Events:** none.

---

### `create_circle`

```
create_circle(
    env:                    Env,
    creator:                Address,
    members:                Vec<Address>,
    round_amount:           i128,
    round_deadline_ledgers: u32,
) -> Address
```

**Authorization:** permissionless.  `creator` must sign the invocation
(`creator.require_auth()` is called).

**What it does:**
1. Validates inputs (member count, uniqueness, `round_amount`, deadline bounds,
   overflow pre-checks).
2. Derives a unique deploy salt from `creator`, current `CircleCount`, and ledger
   entropy.
3. Deploys and initialises a new circle contract instance.
4. Registers the new circle as an authorized caller on the reputation contract.
5. Records the circle address in `DataKey::Circles` and increments
   `DataKey::CircleCount`.
6. Emits `factory/circle_created`.

The entire operation is atomic: if any step panics the host rolls back all state
writes and `CircleCount` is not incremented.

**Returns:** `Address` — the contract ID of the newly deployed circle.

**Errors:**

| Code | Name | Condition |
|------|------|-----------|
| 100 | `TooFewMembers` | `members.len() < 2` |
| 101 | `TooManyMembers` | `members.len() > 256` |
| 102 | `DuplicateMembers` | Same address appears more than once in `members` |
| 103 | `InvalidRoundAmount` | `round_amount ≤ 0` |
| 104 | `PotOverflow` | `round_amount × member_count` overflows `i128` |
| 105 | `PenaltyOverflow` | `round_amount × 2000` overflows `i128` |
| 106 | `DeadlineBelowMinimum` | `round_deadline_ledgers < 100` |
| 107 | `DeadlineAboveMaximum` | `round_deadline_ledgers > 1_036_800` |

**Events:** [`factory/circle_created`](EVENTS.md#factory--circle_created)

---

### `get_circle`

```
get_circle(env: Env, index: u32) -> Address
```

**Authorization:** read-only; no auth required.

**Returns:** the circle address at zero-based `index` in the factory registry.
Panics if `index ≥ CircleCount`.

---

### `get_circle_count`

```
get_circle_count(env: Env) -> u32
```

**Authorization:** read-only; no auth required.

**Returns:** total number of circles deployed by this factory.

---

## Circle contract

**Address:** per-instance address returned by `circle_factory.create_circle`.

**Lifecycle states:** `Pending → Active → Completed → (close called) → Closed`
or `Pending → Cancelled → (close called) → Closed`.  See
[`docs/LIFECYCLE_EVENT_MATRIX.md`](LIFECYCLE_EVENT_MATRIX.md) for the full
transition matrix.

**Pause:** any fund-moving entry-point (`join`, `contribute`, `payout`,
`mark_default`, `close`) panics with a diagnostic message if `DataKey::Paused`
is `true`.  Read-only views are unaffected.

---

### `initialize`

```
initialize(
    env:                    Env,
    creator:                Address,
    members:                Vec<Address>,
    round_amount:           i128,
    round_deadline_ledgers: u32,
    usdc_token:             Address,
    reputation_contract:    Address,
)
```

**Authorization:** called by the factory inside `create_circle`; permissionless
on first call, panics on repeat (`InitError::AlreadyInitialized`).

**What it does:** writes `Config`, `Status = Pending`, `CurrentRound`, sets
`DataKey::Admin` to `creator`, and clears the `Initializing` reentrancy guard.

**Returns:** nothing.

**Errors:** `InitError` variants 1–14 (see contract source for full list).
Notable codes:

| Code | Name | Condition |
|------|------|-----------|
| 1 | `AlreadyInitialized` | Called after a previous successful call |
| 2 | `TooFewMembers` | `members.len() < 2` |
| 3 | `TooManyMembers` | `members.len() > 256` |
| 4 | `DuplicateMembers` | Duplicate address in `members` |
| 5 | `InvalidRoundAmount` | `round_amount ≤ 0` |
| 10 | `InvalidTokenAddress` | `usdc_token == contract_address` |
| 11 | `InvalidReputationAddress` | `reputation_contract` conflicts with other addresses |
| 13 | `UnusableTokenContract` | `usdc_token` does not respond to the token interface |
| 14 | `InitializeInProgress` | Reentrant call |

**Events:** [`circle/initialized`](EVENTS.md#circle--initialized)

---

### `join`

```
join(env: Env, member: Address)
```

**Authorization:** `member` must sign (`member.require_auth()`).  `member` must
be in the configured rotation.  Circle must be `Pending` and not paused.

**What it does:** transfers `round_amount` USDC from `member` to the contract as
collateral.  Writes `DataKey::Collateral(member)`.  When all members have joined,
transitions status to `Active` and starts the round-0 deadline clock.

**Returns:** nothing.  Panics with a diagnostic message if preconditions fail.

**Events:**
- [`circle/joined`](EVENTS.md#circle--joined) — always emitted on success.
- [`circle/active`](EVENTS.md#circle--active) — emitted in the same transaction
  when the last member joins.

---

### `contribute`

```
contribute(env: Env, member: Address)
```

**Authorization:** `member.require_auth()`.  Circle must be `Active` and not
paused.  `member` must not have contributed for the current round already
(idempotency guard via `DataKey::Contributed(member, round)`).

**What it does:** transfers `round_amount` USDC from `member` to the contract.
Increments `contributions_received` for the current round in `DataKey::CurrentRound`.

**Returns:** nothing.

**Events:** [`circle/contributed`](EVENTS.md#circle--contributed)

---

### `payout`

```
payout(env: Env)
```

**Authorization:** permissionless once all members have contributed for the
current round.  Circle must be `Active` and not paused.

**What it does:** transfers the pot (`round_amount × member_count`) to the
scheduled recipient, increments `current_round`, and emits `circle/payout`.  If
this was the last round, transitions to `Completed` and emits `circle/completed`.
Also calls `reputation.increment(member)` for the recipient.

**Returns:** nothing.  Panics if contributions are incomplete for the current
round.

**Events:**
- [`circle/payout`](EVENTS.md#circle--payout) — always emitted on success.
- [`circle/completed`](EVENTS.md#circle--completed) — emitted when the last
  round is paid out.

---

### `mark_default`

```
mark_default(env: Env, member: Address)
```

**Authorization:** permissionless.  Circle must be `Active` and not paused.
The round deadline must have passed.  `member` must not have contributed for the
current round and must not already be flagged for this round
(`DataKey::Defaulted(member, round)`).

**What it does:** deducts `round_amount × PENALTY_BPS / BPS_DENOM` (20 %) from
`DataKey::Collateral(member)`, sets `DataKey::Defaulted(member, round)`, and
increments `DataKey::Defaults(member)`.

**Returns:** nothing.

**Events:** [`circle/default`](EVENTS.md#circle--default)

---

### `cancel`

```
cancel(env: Env, caller: Address)
```

**Authorization:** `caller.require_auth()`.  `caller` must be the admin or a
configured member.  Circle must be `Pending`.

**What it does:** transitions status to `Cancelled`.  Does not release
collateral — members must call `close` to reclaim their deposits.

**Returns:** nothing.

**Events:** [`circle/cancelled`](EVENTS.md#circle--cancelled)

---

### `close`

```
close(env: Env, caller: Address)
```

**Authorization:** `caller.require_auth()`.  `caller` must be the admin or a
configured member.  Circle must be `Completed` or `Cancelled`.  Can only be
called once (`DataKey::Closed` guard).

**What it does:** iterates all member collateral balances, transfers each
non-zero balance back to the member, zeroes the stored balance, and sets
`DataKey::Closed`.

**Returns:** nothing.

**Errors:**

| Code | Name | Condition |
|------|------|-----------|
| 1 | `AlreadyClosed` | Called after a previous successful `close` |
| 2 | `NotTerminalState` | Circle is `Active` or `Pending` |
| 3 | `Unauthorized` | Caller is neither admin nor a member |
| 4 | `RoundsIncomplete` | `Completed` status but `RoundsCompleted ≠ member_count` |

**Events:**
- [`circle/collateral_released`](EVENTS.md#circle--collateral_released) — once
  per member with non-zero remaining collateral.
- [`circle/closed`](EVENTS.md#circle--closed) — emitted once after all transfers
  complete.

---

### `pause`

```
pause(env: Env, admin: Address) -> Result<(), PauseError>
```

**Authorization:** `admin.require_auth()`.  `admin` must equal `DataKey::Admin`.

**What it does:** sets `DataKey::Paused = true`.

**Errors:**

| Code | Name | Condition |
|------|------|-----------|
| 1 | `Unauthorized` | Caller is not the stored admin |
| 2 | `AlreadyPaused` | Circle is already paused |
| 4 | `NotInitialized` | Called before `initialize` |

**Events:** [`circle/paused`](EVENTS.md#circle--paused)

---

### `resume`

```
resume(env: Env, admin: Address) -> Result<(), PauseError>
```

**Authorization:** `admin.require_auth()`.  `admin` must equal `DataKey::Admin`.

**What it does:** clears `DataKey::Paused`.

**Errors:**

| Code | Name | Condition |
|------|------|-----------|
| 1 | `Unauthorized` | Caller is not the stored admin |
| 3 | `NotPaused` | Circle is not currently paused |
| 4 | `NotInitialized` | Called before `initialize` |

**Events:** [`circle/resumed`](EVENTS.md#circle--resumed)

---

### `get_config`

```
get_config(env: Env) -> CircleConfig
```

**Returns:** `CircleConfig { members, round_amount, usdc_token,
reputation_contract, round_deadline_ledgers }`.

---

### `get_status`

```
get_status(env: Env) -> CircleStatus
```

**Returns:** `Pending | Active | Completed | Cancelled`.

---

### `get_current_round`

```
get_current_round(env: Env) -> RoundState
```

**Returns:** `RoundState { round_index, recipient, contributions_received,
deadline_ledger, paid_out }`.

---

### `get_collateral`

```
get_collateral(env: Env, member: Address) -> i128
```

**Returns:** remaining collateral for `member` in stroops.  Returns `0` if the
member has no stored collateral entry (e.g. after `close`).

---

### `get_defaults`

```
get_defaults(env: Env, member: Address) -> u32
```

**Returns:** number of rounds for which `member` has been marked defaulted.

---

### `has_contributed`

```
has_contributed(env: Env, member: Address, round_index: u32) -> bool
```

**Returns:** `true` if `member` contributed in `round_index`.

---

### `get_protocol_params`

```
get_protocol_params(env: Env) -> (i128, i128, i128, u32, u32, u32)
```

**Returns:** `(PENALTY_BPS, BPS_DENOM, COLLATERAL_MULTIPLIER,
MIN_ROUND_DEADLINE_LEDGERS, MAX_ROUND_DEADLINE_LEDGERS, MAX_MEMBERS)`.
Read-only; no auth required.  Use this instead of hard-coding constants in the
SDK or frontend.

---

## Reputation contract

**Address:** `REPUTATION_ADDRESS` (environment variable).

**Purpose:** tracks a monotonically increasing completed-rounds score per wallet.
Only factory-registered circle contracts may increment scores.

---

### `initialize`

```
initialize(env: Env, admin: Address)
```

**Authorization:** permissionless on first call.  `admin` becomes the only
address that may register or revoke authorized callers.  In the standard
deployment the factory contract is passed as `admin`.

**Returns:** nothing.

**Errors:** `ReputationError::AlreadyInitialized` (code 7),
`ReputationError::InitializeInProgress` (code 8).

**Events:** none.

---

### `add_authorized_caller`

```
add_authorized_caller(env: Env, caller: Address, admin: Address)
```

**Authorization:** `admin.require_auth()`.  `admin` must equal `DataKey::Admin`.
Idempotent: re-registering an already-authorized caller is a no-op (no event
emitted).

**What it does:** appends `caller` to `DataKey::AuthorizedCallers`.  Panics with
`ReputationError::CallerRevoked` if `caller` is in `DataKey::RevokedCallers`.

**Events:** [`reputation/caller_added`](EVENTS.md#reputation--caller_added) —
emitted only when the caller was not already authorized.

---

### `remove_authorized_caller`

```
remove_authorized_caller(env: Env, caller: Address, admin: Address)
```

**Authorization:** `admin.require_auth()`.  `admin` must equal `DataKey::Admin`.
Revocation is permanent — the address is added to `DataKey::RevokedCallers` and
can never be re-registered.

**Errors:** `ReputationError::CallerNotFound` (code 3) if `caller` is not
currently in the allowlist.

**Events:** [`reputation/caller_removed`](EVENTS.md#reputation--caller_removed)

---

### `increment`

```
increment(env: Env, circle: Address, member: Address) -> Result<(), ReputationError>
```

**Authorization:** `circle` must be in `DataKey::AuthorizedCallers` and must
not be in `DataKey::RevokedCallers`.  `circle.require_auth()` is called.

**What it does:** increments `DataKey::Score(member)` by 1.  Score is
monotonically non-decreasing; there is no decrement entry-point.

**Errors:**

| Code | Name | Condition |
|------|------|-----------|
| 1 | `UnauthorizedCaller` | `circle` is not authorized or is revoked |
| 6 | `ScoreOverflow` | Score would exceed `u32::MAX` |

**Events:** [`reputation/score_updated`](EVENTS.md#reputation--score_updated)

---

### `score`

```
score(env: Env, member: Address) -> u32
```

**Authorization:** read-only; no auth required.

**Returns:** member's current cumulative score.  Returns `0` for addresses with
no recorded score.

---

### `get_authorized_callers`

```
get_authorized_callers(env: Env) -> Vec<Address>
```

**Authorization:** read-only; no auth required.

**Returns:** current allowlist of circle addresses permitted to call `increment`.

---

### `get_revoked_callers`

```
get_revoked_callers(env: Env) -> Vec<Address>
```

**Authorization:** read-only; no auth required.

**Returns:** permanently revoked caller addresses.  This list is append-only.

---

## Protocol constants

These constants are defined in `contracts/circle/src/lib.rs` and exported via
`get_protocol_params`.  Do not hard-code them in the SDK or frontend.

| Constant | Value | Meaning |
|----------|-------|---------|
| `PENALTY_BPS` | 2 000 | Penalty per missed round (basis points; 20 %) |
| `BPS_DENOM` | 10 000 | Denominator for all basis-point calculations |
| `COLLATERAL_MULTIPLIER` | 1 | Collateral required as a multiple of `round_amount` |
| `MIN_ROUND_DEADLINE_LEDGERS` | 100 | Minimum deadline (~8 min at 5 s/ledger) |
| `MAX_ROUND_DEADLINE_LEDGERS` | 1 036 800 | Maximum deadline (~60 days at 5 s/ledger) |
| `MAX_MEMBERS` | 256 | Maximum members per circle |

---

## Related documents

| Document | When to read it |
|----------|-----------------|
| [`docs/EVENTS.md`](EVENTS.md) | Canonical event payload tables (topics, data tuples, invariants) |
| [`sdk/CONTRACT_FIXTURES.md`](../sdk/CONTRACT_FIXTURES.md) | XDR fixtures that detect argument-level signature drift in CI |
| [`docs/CONTRACT_SECURITY_CHECKLIST.md`](CONTRACT_SECURITY_CHECKLIST.md) | Structured review prompt for contract PRs |
| [`docs/LIFECYCLE_EVENT_MATRIX.md`](LIFECYCLE_EVENT_MATRIX.md) | Which event drives each user-visible status transition |
| [`docs/RUNBOOK.md`](RUNBOOK.md) | Environment variables, deployment order, troubleshooting |
