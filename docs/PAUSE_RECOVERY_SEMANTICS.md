# Pause and Resume Recovery Semantics

**Status**: Documented for Issue #681  
**Last Updated**: October 17, 2026

## Overview

The CircleUp circle contract supports pausing fund-moving operations to enable emergency recovery, operational maintenance, or member coordination. This document defines the pause/resume lifecycle, recovery semantics, and state guarantees to ensure paused circles can safely resume operations without data loss or invariant violation.

---

## Pause and Resume Lifecycle

### Authorization

- **Admin Role**: Only the address stored at initialization (typically the deployer or factory contract) may call `pause()` or `resume()`.
- **Authorization Mechanism**: Both functions require `admin.require_auth()`, meaning the admin must sign the transaction.

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

**No.** The deadline ledger (`deadline_ledger` in `RoundState`) is immutable during a pause. It is only advanced when:
- A round is settled via `settle_round()` (which is blocked while paused).
- A new round begins after settlement (also blocked while paused).

**Implication**: If a circle is paused with 1 day left in a round, it still has 1 day left when resumed. Members do not lose time.

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

Pause is **orthogonal** to lifecycle status (Pending, Active, Completed, Cancelled):
- A Pending circle can be paused before all members join.
- An Active circle can be paused mid-round.
- A Completed circle **cannot be paused** (close has already finalized it; fund-moving is impossible anyway).
- A Cancelled circle **cannot be paused** (cancel is blocked while paused, and once cancelled, close must be called to settle collateral).

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

1. **Check Pause Before Submission**: Call `is_paused()` in the SDK layer before constructing transactions for fund-moving operations.
2. **Return Contextual Error**: If paused, return a `CircleError::Paused` or similar to the caller (not a low-level Soroban host error).
3. **Allow Read Methods**: Ensure all read-only views work while paused so status updates are always possible.

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

---

## Summary

Pause/resume is a transparent emergency control that:
- **Blocks all fund-moving operations** with a clear error message.
- **Preserves all state** (collateral, contributions, round progress, deadlines, penalties).
- **Allows all read-only views** so users and indexers see the pause status.
- **Does not advance deadlines** so members receive the full contribution window upon resume.
- **Is fully tested** across lifecycle stages (Pending, Active) and recovery scenarios.

The mechanism is safe for use in production to handle network outages, token unavailability, governance decisions, and emergency holds without data loss or invariant violation.
