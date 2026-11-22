# Contract Upgrade, Storage, and Authorization Tests

This document summarizes the test modules and documentation added to verify contract behavior across upgrades, storage durability, reputation overflow handling, and authorization invariants.

## Files Created

### 1. Contract Upgrade Path Tests
**File:** `contracts/circle/tests/upgrade_path_tests.rs`

Tests that upgraded contract instances can correctly read existing storage and preserve lifecycle invariants.

**Supported Upgrade Paths:**
| From Layout | To Layout | Supported | Notes |
|-------------|-----------|-----------|-------|
| L1 (initial) | L3 (current) | Yes | Admin/UsdcToken added; L1 instances need migration |
| L2 | L3 | Yes | Closed key added; compatible |
| L3 | L3 | Yes | Same version; no-op upgrade |

**Unsupported Jumps:**
- L1 → L2: Requires Admin key for `close()`. L1 instances must be migrated by writing the Admin key before upgrading.

**Tests:**
- `upgrade_l1_to_l3_pending_preserves_state_and_returns_typed_errors`
- `upgrade_l1_to_l3_active_mid_round_continues_lifecycle`
- `upgrade_l1_to_l3_completed_requires_admin_migration`
- `upgrade_l2_to_l3_closed_preserves_all_state`
- `upgrade_l2_to_l3_active_preserves_pause_capability`
- `upgrade_l3_to_l3_preserves_everything`
- `upgrade_preserves_collateral_invariant`
- `upgrade_preserves_recipient_invariant`
- `upgrade_preserves_status_transition_invariants`
- `document_l1_migration_requirement`

---

### 2. Storage Durability Documentation
**File:** `contracts/docs/STORAGE_DURABILITY.md`

Comprehensive inventory of every contract key with storage classification, required lifetime, and TTL extension requirements.

**Storage Classes:**
| Class | Durability | TTL Behavior |
|-------|------------|--------------|
| **Instance** | Permanent | Never expires |
| **Persistent** | Time-limited | Requires TTL extension |
| **Temporary** | Single transaction | Cleared at tx end |

**Circle Contract Keys:**

*Instance Storage (Permanent):*
- Config, Status, CurrentRound, RoundsCompleted, Admin, UsdcToken, Paused, Closed, Initializing

*Persistent Storage (Requires TTL Extension):*
- Collateral(member), Contributed(member, round), Defaults(member), Defaulted(member, round)

**Reputation Contract Keys:**

*Instance Storage (Permanent):*
- Admin, AuthorizedCallers, RevokedCallers, Initializing

*Persistent Storage (Requires TTL Extension):*
- Score(member) - **Required to extend permanently**

**TTL Extension Requirements by Phase:**
- Active Circle: Extend Collateral/Contributed to completion + 30 days
- Completed Circle: Extend Collateral 90 days, Defaults permanently
- Closed Circle: Defaults permanently
- Reputation Scores: Extend to max (200,000 ledgers)

---

### 3. Reputation Overflow Tests
**File:** `contracts/reputation/tests/overflow_tests.rs`

Tests for reputation score overflow behavior at u32::MAX.

**Overflow Policy:**
- `increment` returns `Err(ReputationError::ScoreOverflow)` when at u32::MAX
- The score remains unchanged (no wrapping)
- Payouts that would trigger overflow fail atomically

**Tests:**
- `score_at_max_minus_one_increments_to_max`
- `score_overflow_at_max_returns_typed_error`
- `failed_increment_preserves_max_score`
- `overflow_failure_emits_no_event`
- `payout_fails_atomically_on_reputation_overflow`
- `multiple_members_can_reach_max_independently`
- `overflow_on_one_member_does_not_affect_others`
- `ttl_extended_even_on_overflow_failure`
- `score_updated_event_carries_max_value`
- `document_overflow_policy`

---

### 4. Authorization Invariants Tests
**File:** `contracts/reputation/tests/authorization_invariants_tests.rs`

Tests that authorized and revoked caller collections maintain their invariants after administrative operations.

**Collection Invariants:**
1. **Uniqueness**: Each address appears at most once in AuthorizedCallers
2. **Revocation permanence**: Once in RevokedCallers, never returns to AuthorizedCallers
3. **Authorization outranks absence**: Address is authorized iff in AuthorizedCallers AND NOT in RevokedCallers
4. **Event consistency**: Events emitted only for state-changing operations

**Event Policy:**
| Operation | Condition | Event Emitted |
|-----------|-----------|---------------|
| add_authorized_caller | Not in list, not revoked | `caller_added` |
| add_authorized_caller | Already authorized | No event (idempotent) |
| add_authorized_caller | Revoked | `CallerRevoked` error, no event |
| remove_authorized_caller | Address in list | `caller_removed` |
| remove_authorized_caller | Not in list | `CallerNotFound` error, no event |

**Tests:**
- `add_same_caller_twice_keeps_unique`
- `add_multiple_callers_keeps_all_unique`
- `remove_and_readd_does_not_duplicate`
- `remove_clears_all_duplicates_from_corrupted_list`
- `revoked_caller_cannot_be_reauthorized`
- `revocation_works_on_stale_allowlist`
- `multiple_revocation_attempts_are_idempotent`
- `revoked_caller_rejected_even_if_in_allowlist`
- `authorization_decision_is_allowlist_minus_revoked`
- `remove_nonexistent_caller_returns_caller_not_found`
- `add_already_authorized_is_idempotent`
- `successful_add_emits_one_event`
- `idempotent_add_emits_no_event`
- `successful_remove_emits_one_event`
- `failed_remove_emits_no_event`
- `rejected_readd_emits_no_event`
- `caller_added_event_carries_address`
- `caller_removed_event_carries_address`
- `complex_sequence_maintains_invariants`
- `rapid_add_remove_sequence_keeps_consistent_state`
- `admin_can_manage_others_after_many_revocations`
- `getters_match_event_replay_after_each_operation`

---

## Integration with Existing Code

### Circle Contract
Added to `contracts/circle/src/lib.rs`:
```rust
#[cfg(test)]
mod upgrade_path_tests; // contract upgrade path tests
```

### Reputation Contract
Added to `contracts/reputation/src/lib.rs`:
```rust
#[cfg(test)]
mod overflow_tests;

#[cfg(test)]
mod authorization_invariants_tests;
```

---

## Running the Tests

```bash
# Run all contract tests
cd contracts
cargo test

# Run specific test modules
cargo test --test overflow_tests
cargo test --test authorization_invariants_tests
cargo test --test upgrade_path_tests
```

---

## Acceptance Criteria Coverage

### Contract Upgrades
✅ Identified upgradeable instances (circle contract)
✅ Defined supported source and target versions (L1→L3, L2→L3, L3→L3)
✅ Added tests preserving initialized state with read and mutation assertions
✅ Documented unsupported upgrade jumps and migration procedures

### Storage Durability
✅ Inventoried every contract key across all three contracts
✅ Classified as instance, persistent, or temporary storage
✅ Stated required lifetime for each value
✅ Documented TTL extension requirements for ongoing circles, terminal claims, and reputation
✅ Tests cover TTL extension behavior

### Reputation Overflow
✅ Reviewed overflow behavior during payout
✅ Chose typed error rejection policy (not saturation or wrap)
✅ Tests at MAX-1 and MAX with payout state assertions
✅ Updated error mapping and event expectations

### Authorization Invariants
✅ Defined collection invariants for authorized and revoked callers
✅ Generated operation sequences (duplicate adds, removal of absent, revocation, re-addition)
✅ Asserted membership, uniqueness, authorization outcomes, and event count
✅ Added event contract documentation for SDK/indexer