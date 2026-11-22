# Pause and Resume Recovery Semantics

**Status**: Documented for Issue #681  
**Last Updated**: October 17, 2026

## Overview

The CircleUp circle contract supports pausing fund-moving operations to enable emergency recovery, operational maintenance, or member coordination. This document defines the pause/resume lifecycle, recovery semantics, and state guarantees to ensure paused circles can safely resume operations without data loss or invariant violation.

---

## Pause and Resume Lifecycle

### Authorization

- **Admin Role**: Only the `Admin` address written once by `initialize` may call `pause()` or `resume()`. There is no setter, no second role, and no upgrade entrypoint; this document does not introduce any.
- **Authorization Mechanism**: Both functions require `admin.require_auth()`, meaning the admin must sign the transaction.
- **Check order** (both functions): `Admin` missing → `NotInitialized`; `require_auth`; caller ≠ admin → `Unauthorized`; then the flag check (`AlreadyPaused` / `NotPaused`). A rejected call writes nothing and emits nothing.

#### Who actually holds pause authority (#876)

| Deployment path | Stored `Admin` | Can anyone pause? |
|---|---|---|
| `circle_factory.create_circle` (the app's path) | the **factory contract address** | **No.** The factory has no `pause`/`resume` or forwarding entrypoint, and a contract address can only authorize calls it makes itself. Pinned by `contracts/circle_factory/tests/pause_authority_tests.rs`. |
| Direct `initialize` by an operator | whatever account was passed | Yes — that account (ideally a multisig). |

Giving factory-deployed circles a working pause would mean adding a factory entrypoint and choosing who may call it. That is a **new emergency authority** and needs an explicit governance decision; it is deliberately not part of this change.

### Pause Entry-Point

```rust
pub fn pause(env: Env, admin: Address) -> Result<(), PauseError>
```

**Preconditions**:
- Circle must be initialized (Admin key must exist).
- Circle must not already be paused.

**Postconditions**:
- `Paused` flag set to `true` in instance storage.
- Event `circle/paused` emitted with `(circle_address, admin, ledger)`.
- All fund-moving operations blocked immediately.
- All read-only views remain available.

**Errors**:
- `PauseError::NotInitialized` — called before `initialize`.
- `PauseError::Unauthorized` — caller is not the stored admin.
- `PauseError::AlreadyPaused` — circle is already paused (idempotent guard).

### Resume Entry-Point

```rust
pub fn resume(env: Env, admin: Address) -> Result<(), PauseError>
```

**Preconditions**:
- Circle must be initialized.
- Circle must currently be paused.

**Postconditions**:
- `Paused` flag removed from instance storage entirely (not set to `false`).
- Event `circle/resumed` emitted with `(circle_address, admin, ledger)`.
- All fund-moving operations unblocked immediately.
- All prior state (members, collateral, contribution records, round progress) remains intact.

**Errors**:
- `PauseError::NotInitialized` — called before `initialize`.
- `PauseError::Unauthorized` — caller is not the stored admin.
- `PauseError::NotPaused` — circle is not currently paused.

---

## State Preservation During Pause

A pause/resume cycle preserves all circle state intact:

| State Component | Preserved? | Notes |
|---|---|---|
| Members list | ✓ Yes | Immutable after `initialize`; cannot be modified. |
| Collateral balances per member | ✓ Yes | Persisted across pause; no decay or loss. |
| Contribution records | ✓ Yes | All prior contributions remain; no retroactive erasure. |
| Current round number | ✓ Yes | Paused circles do not advance rounds; resume at the same position. |
| Deadline ledger | ✓ Yes | Deadline does not advance during pause; members get the same time window. |
| Default penalties | ✓ Yes | Persisted; defaults marked before pause are not reset. |
| Reputation awards | ✓ Yes | Persisted; no score rollback on pause. |

---

## Blocked and Allowed Operations While Paused

### Fund-Moving Operations (Blocked)

The following entry-points panic with the message `"circle is paused: no fund-moving operations are allowed until an admin resumes it"`:

1. **`join(member: Address)`** — Cannot lock collateral.
2. **`contribute(member: Address)`** — Cannot transfer round contribution.
3. **`payout()`** — Cannot disburse round pot or award reputation.
4. **`settle_round()`** — Cannot settle exceptional rounds or transfer partial pots.
5. **`mark_default(member: Address)`** — Cannot deduct penalties or advance default counters.
6. **`close()`** — Cannot release collateral or mark circle as closed.
7. **`cancel()`** — Cannot cancel a Pending circle.

### Read-Only Views (Always Available)

The following views remain accessible while paused:

- `get_config()` — Returns members, round_amount, usdc_token, reputation_contract, deadline.
- `get_status()` — Returns current lifecycle status (Pending, Active, Completed, or Cancelled).
- `get_current_round()` — Returns round index, recipient, contributions_received, deadline_ledger, paid_out.
- `get_collateral(member)` — Returns locked collateral for a member.
- `get_defaults(member)` — Returns missed-round count.
- `has_contributed(member, round)` — Returns whether member contributed in a specific round.
- `get_protocol_params()` — Returns penalty rate and other constants.
- `get_pot_amount()` — Returns the current pot balance.
- `get_admin()` — Returns the stored admin address.
- `get_usdc_token()` — Returns the immutable USDC token address.
- `is_closed()` — Returns whether circle has been closed.
- **`is_paused()`** — Returns whether circle is currently paused (does NOT require initialization).

This design allows indexers and front-ends to:
- Display current circle state to members.
- Explain why operations are blocked (by checking `is_paused()`).
- Provide a pause reason or timeline for recovery (admin responsibility).

---

## Recovery Scenarios

### Scenario 1: Pause Before Circle Activation

**Situation**: Circle is Pending (not all members have joined), and admin calls `pause()`.

**Recovery**:
1. Members may not join while paused.
2. Admin resumes the circle via `resume()`.
3. Members can join as if the pause never occurred; all prior joins remain.

**Invariants**:
- No loss of prior joins.
- Circle activation happens when the last member joins (after resume).

---

### Scenario 2: Pause During Active Round

**Situation**: Circle is Active, members are contributing to round N, and the admin pauses mid-round.

**Recovery**:
1. No new contributions can be recorded; existing contributions for round N are safe.
2. The deadline for round N does NOT advance during pause.
3. Admin resumes the circle.
4. Members can resume contributing to round N until the deadline passes.
5. Settling (via `settle_round()` or automatic timeout) proceeds normally.

**Invariants**:
- Members receive the full contribution window (deadline unchanged).
- Contributions made before pause are not lost.
- Partial contributions before pause are safe; round can settle normally after resume.

---

### Scenario 3: Pause After Deadline Passed (Settlement Pending)

**Situation**: Round N deadline has passed; neither all members contributed nor settle_round was called. Circle is paused.

**Recovery**:
1. `settle_round()` cannot be called while paused.
2. Admin resumes the circle.
3. `settle_round()` can be called immediately; defaults and penalties apply normally.
4. Circle advances to round N+1.

**Invariants**:
- No "zombie" penalties applied while paused.
- Settlement logic is unchanged; admin does not need to manually reset state.

---

### Scenario 4: Pause With Partially Released Collateral (Post-Payout)

**Situation**: Circle has completed some rounds; members' collateral has been partially reduced by penalties or payout cycles.

**Recovery**:
1. Collateral balances are frozen as-is during pause.
2. Admin resumes.
3. Remaining rounds proceed; collateral is only released via `close()` at the end.

**Invariants**:
- No additional penalties applied during pause.
- Collateral release logic is unchanged.

---

### Scenario 5: Network or Deployment Issues (Emergency Hold)

**Situation**: A token contract is unavailable, or there is an index synchronization issue; admin pauses to prevent further state mutations.

**Recovery**:
1. Admin pauses the circle (using a multisig or governance approval if appropriate).
2. Indexer and front-end display `is_paused() == true` to users.
3. Once the underlying issue is resolved, admin resumes.
4. Operations proceed normally.

**Invariants**:
- Read views remain available so users see the pause status.
- No data loss during the hold period.

---

## Deadline Semantics While Paused

### Does the deadline advance during a pause?

**The stored deadline does not move, but time keeps running against it.** `deadline_ledger` is an absolute ledger sequence. Pause does not rewrite it, and the network keeps closing ledgers while the circle is paused.

**Implication** (corrected for #876): if a circle is paused with 1 day left in a round and stays paused for 2 days, the deadline has **passed** when it resumes. Members cannot contribute (`DeadlinePassed`), and they can be marked in default (`mark_default` / `settle_round`) right after `resume`. Members **do** lose the paused time. Pinned by `ledgers_closed_during_a_pause_count_against_the_deadline` in `contracts/circle/tests/pause_semantics_tests.rs`.

Admins should therefore keep pauses short, or announce that the round will be settled once it resumes. The contract offers no deadline extension, and this document does not add one.

---

## Transition Constraints

### Pause State Transitions

```
Unpaused → [admin calls pause()] → Paused
Paused → [admin calls resume()] → Unpaused
```

The state machine is simple:
- Once paused, all fund-moving calls fail until resumed.
- Resume clears the flag entirely (idempotent — calling resume when not paused returns `PauseError::NotPaused`).

### Paused Circles and Lifecycle Status

Pause is an **overlay** on lifecycle status. `pause` and `resume` never read or write `Status`, `Closed`, rounds, collateral or defaults, and they are accepted in **every** status (corrected for #876; the earlier text claimed Completed and Cancelled circles could not be paused):

| Base state | `pause` | Effect while paused |
|---|---|---|
| Pending | Allowed | `join`, `cancel` → `CirclePaused` |
| Active | Allowed | `contribute`, `payout`, `mark_default`, `settle_round` → `CirclePaused` |
| Completed (not closed) | Allowed | `close` → `CirclePaused`: **collateral cannot be released until `resume`** |
| Cancelled (not closed) | Allowed | `close` → `CirclePaused`: same as above |
| Closed | Allowed | No fund-moving call remains; `close` reports `CirclePaused` instead of `AlreadyClosed` |

While paused, `CirclePaused` (contract error 7) is raised **before** any status check, so a paused circle reports it even where the unpaused circle would give another error. The full matrix is `contracts/circle/src/transition.rs` (`TRANSITION_MATRIX`, `paused_overlay`).

Read availability: every view stays available while paused, including `get_status`, `get_config`, `get_current_round`, `get_collateral`, `get_defaults`, `has_contributed`, `get_pot_amount`, `get_admin`, `get_usdc_token`, `get_protocol_params`, `is_paused` and `is_closed`.

---

## Events

### Pause Event

**Topic**: `circle` / `paused`  
**Data**: `(circle_address: Address, admin: Address, ledger: u32)`

```rust
env.events().publish(
    event_topics(&env, "paused"),
    (env.current_contract_address(), admin, env.ledger().sequence()),
);
```

**Indexer Implications**:
- Records the pause moment (ledger) for audit trail.
- Allows clients to reconstruct pause/resume timeline.

### Resume Event

**Topic**: `circle` / `resumed`  
**Data**: `(circle_address: Address, admin: Address, ledger: u32)`

```rust
env.events().publish(
    event_topics(&env, "resumed"),
    (env.current_contract_address(), admin, env.ledger().sequence()),
);
```

---

## SDK and UI Guidance

### Frontend Responsibility

1. **Display Pause Status**: Call `is_paused()` before rendering action buttons (join, contribute, payout, close).
2. **Show Block Reason**: If paused, display a clear message: *"This circle is paused. No contributions or payouts are allowed until the admin resumes it."*
3. **Allow Reads**: Always let users view current collateral, contribution records, and round progress, even if paused.
4. **Link to Admin**: If possible, link to the admin's address so users know who has control.

### SDK Responsibility

Current behaviour, aligned for #876:

1. **Errors**: `PauseError` codes 1–4 map to SDK diagnostics in `sdk/src/simulationHelpers.ts`: "only the circle admin may pause or resume", "already paused", "not paused", "not initialized". `CirclePaused` (contract code 7) from any fund-moving call maps to "the circle is paused".
2. **No pause methods**: the SDK does not wrap `pause`/`resume`. Factory-deployed circles cannot be paused, and operators of directly deployed circles invoke them with their own admin key.
3. **Reads**: all SDK read methods work while paused.

### Indexer projection

- `circle/paused` → `UPDATE circles SET paused = TRUE …`; `circle/resumed` → `… paused = FALSE …`.
- Neither touches `status`, round data or settlement columns. Lifecycle status is preserved (pinned in `indexer/src/eventSchemas.test.ts`). Reconciliation compares `circles.paused` against on-chain `is_paused()`.
- The `paused` column is **not yet exposed** by the HTTP API, so the app learns about a pause from the `CirclePaused` transaction error. Exposing it is a follow-up that needs an OpenAPI and HTTP-contract change.

### Admin Responsibility

1. **Communicate Pause Reason**: Post-off-chain to members why a pause was initiated (token issue, network degradation, governance vote, etc.).
2. **Publish Timeline**: Provide an estimated resumption time.
3. **Resume Promptly**: Once the root cause is resolved, resume the circle via a signed transaction.
4. **Use Events**: Emit pause/resume events on-chain for audit; monitor off-chain for compliance.

---

## Test Coverage

All pause/resume semantics are covered by the test suite:

| Test | File | Purpose |
|---|---|---|
| `test_is_paused_lifecycle` | `lifecycle_invariant_tests.rs` | Pause → Resume state machine. |
| `test_pause_blocks_contribute` | `lifecycle_invariant_tests.rs` | Verify contribute panics while paused. |
| `test_pause_blocks_settle_round` | `lifecycle_invariant_tests.rs` | Verify settle_round panics while paused. |
| `test_resume_unblocks_contribute` | `lifecycle_invariant_tests.rs` | Verify operations resume after resume(). |
| `test_334_is_paused_false_by_default` | `tests.rs` | Default unpaused state. |
| `test_334_admin_can_pause` | `tests.rs` | Authorization check for pause. |
| `test_334_non_admin_cannot_pause` | `tests.rs` | Privilege isolation. |
| `test_334_double_pause_returns_error` | `tests.rs` | Idempotency guard. |
| `test_334_admin_can_resume` | `tests.rs` | Authorization check for resume. |
| `test_334_join_blocked_while_paused` | `tests.rs` | Blocking for join. |
| `test_334_contribute_blocked_while_paused` | `tests.rs` | Blocking for contribute. |
| `test_334_payout_blocked_while_paused` | `tests.rs` | Blocking for payout. |
| `test_334_mark_default_blocked_while_paused` | `tests.rs` | Blocking for mark_default. |
| `test_334_close_blocked_while_paused` | `tests.rs` | Blocking for close. |
| `test_334_cancel_blocked_while_paused` | `tests.rs` | Blocking for cancel. |
| `test_334_reads_available_while_paused` | `tests.rs` | Read-only views available. |
| `test_334_resume_restores_join` | `tests.rs` | State preservation. |
| `test_334_multiple_pause_resume_cycles_work` | `tests.rs` | Multi-cycle robustness. |
| `test_334_pause_emits_paused_event` | `tests.rs` | Event emission for pause. |
| `test_334_resume_emits_resumed_event` | `tests.rs` | Event emission for resume. |
| `only_the_stored_admin_can_pause_or_resume` | `tests/pause_semantics_tests.rs` | Member, stranger and the circle's own address rejected; no mutation, no event (#876). |
| `repeated_pause_resume_transitions_are_strictly_alternating` | `tests/pause_semantics_tests.rs` | `AlreadyPaused` / `NotPaused` and event sequence. |
| `pause_preserves_lifecycle_status_in_every_state` | `tests/pause_semantics_tests.rs` | Pending, Active, Completed, Closed. |
| `pause_on_cancelled_circle_blocks_close_until_resume` | `tests/pause_semantics_tests.rs` | Terminal interaction. |
| `every_mutation_is_blocked_while_paused_and_state_is_untouched` | `tests/pause_semantics_tests.rs` | All seven mutations; snapshot unchanged. |
| `ledgers_closed_during_a_pause_count_against_the_deadline` | `tests/pause_semantics_tests.rs` | Deadline semantics. |
| `factory_has_no_pause_or_resume_entrypoint` | `circle_factory/tests/pause_authority_tests.rs` | No hidden authority. |

---

## Summary

Pause/resume is a transparent emergency control that:
- **Blocks all fund-moving operations** with a clear error message.
- **Preserves all state** (collateral, contributions, round progress, deadlines, penalties).
- **Allows all read-only views** so users and indexers see the pause status.
- **Does not move the stored deadline**, but ledgers keep closing during a pause, so paused time counts against the round.
- **Is an overlay in every status**, including Completed, Cancelled and Closed. A pause on a terminal circle blocks `close` until `resume`.
- **Has exactly one authority**, the stored `Admin`. For factory-deployed circles that is the factory contract, which cannot exercise it.
- **Is tested** across all lifecycle stages and recovery scenarios.

The mechanism is safe for use in production to handle network outages, token unavailability, governance decisions, and emergency holds without data loss or invariant violation.
