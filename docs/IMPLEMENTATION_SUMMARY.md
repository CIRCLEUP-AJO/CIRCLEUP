# Documentation and Test Coverage Summary

This document summarizes the documentation and tests added to address the requirements for:
1. Factory salt derivation and deterministic deployment
2. Compound operation event sequences
3. Reputation contract authorization model
4. Event schema catalog and compatibility

## Files Created/Modified

### Documentation

| File | Description |
|------|-------------|
| `docs/DEPLOYMENT_SALT_DERIVATION.md` | Salt inputs, address derivation, counter invariants, test coverage |
| `docs/EVENTS.md` | Complete event catalog for factory, circle, and reputation contracts |
| `docs/REPUTATION_OPERATIONAL_CHECKLIST.md` | Operator verification steps for reputation admin and authorization |

### Tests

| File | Description |
|------|-------------|
| `contracts/circle/src/payout_event_sequence_tests.rs` | Compound operation event ordering tests |
| `indexer/src/indexer.ordering.test.ts` | Indexer event ordering preservation tests |

---

## 1. Factory Salt Derivation (docs/DEPLOYMENT_SALT_DERIVATION.md)

### Salt Formula
```
salt = SHA256(creator.toXDR() || count.toXDR() || ledger.sequence.toXDR() || ledger.timestamp.toXDR())
```

### Salt Inputs
| Input | Type | Purpose |
|-------|------|---------|
| `creator` | Address | Different creators → different addresses |
| `count` | u32 | Monotonic counter; only increments on success |
| `ledger.sequence` | u64 | Extra entropy; prevents count-reset collisions |
| `ledger.timestamp` | u64 | Additional entropy for future-proofing |

### Counter Invariant
- Counter is read **before** deployment
- Counter is incremented **only after** successful deployment + init + reputation registration
- Failed deployments do NOT consume a counter slot
- Failed deployments do NOT add to the Circles registry

### Test Coverage (existing in `contracts/circle_factory/src/lib.rs`)
- `test_derive_circle_salt_is_stable_for_same_inputs`
- `test_derive_circle_salt_differs_by_count`
- `test_derive_circle_salt_differs_by_creator`
- `test_derive_circle_salt_differs_by_ledger_sequence`
- `test_545_derive_circle_salt_differs_by_timestamp`
- `test_545_derive_circle_salt_is_deterministic_given_fixed_ledger`
- `test_545_each_salt_input_independently_contributes`
- `test_545_failed_create_does_not_advance_salt_counter`
- `test_failed_create_does_not_increment_count`
- `test_failed_create_does_not_add_to_circles_list`
- `test_multiple_failed_creates_state_remains_clean`

---

## 2. Compound Operation Event Sequences

### Payout (Full Contributions)
```
payout → score_updated → round_started (or completed if final)
```

### Settle Round (Partial Contributions)
```
default* → exceptional_settlement → payout → score_updated → round_started/completed
```

### Close (Collateral Release)
```
collateral_released* → closed
```

### Join Activation
```
joined* → active
```

### Failed Transactions
- Emit NO events (Soroban host rolls back atomically)

### Test Coverage

**Contract Tests** (`contracts/circle/src/payout_event_sequence_tests.rs`):
- `test_payout_emits_events_in_documentated_order`
- `test_final_payout_emits_completed_not_round_started`
- `test_payout_event_carries_correct_data`
- `test_score_updated_event_carries_correct_data`
- `test_failed_payout_emits_no_events`
- `test_failed_contribute_emits_no_events`
- `test_settle_round_emits_default_events_before_settlement`
- `test_settle_round_with_all_defaulted`
- `test_close_emits_collateral_released_before_closed`
- `test_close_aggregates_correct_totals`
- `test_join_then_active_event_order`
- `test_pause_emits_paused_event`
- `test_resume_emits_resumed_event`
- `test_cancel_emits_cancelled_event`

**Indexer Tests** (`indexer/src/indexer.ordering.test.ts`):
- `payout event sequence` tests
- `settle round event sequence` tests
- `close event sequence` tests
- `join activation event sequence` tests
- `failed transaction event isolation` tests
- `pause/resume event ordering` tests
- `cancellation event ordering` tests

---

## 3. Reputation Contract Authorization

### Trust Model
| Role | Responsibility |
|------|----------------|
| **Admin** | Can add/remove authorized callers. Set once at `initialize`. |
| **Factory** | Automatically registered as admin; registers each new circle. |
| **Circles** | Only authorized circles can call `increment`. |
| **Members** | Cannot self-award points. |

### Revocation Semantics
- Revocation is **permanent**
- A revoked circle can **never** be re-authorized
- `add_authorized_caller` for a revoked circle returns `CallerRevoked`
- Points already awarded remain (scores are monotonic)

### Operational Checklist (`docs/REPUTATION_OPERATIONAL_CHECKLIST.md`)
1. Verify admin is factory
2. Verify no pre-existing authorized callers
3. Verify no revoked callers
4. After factory init: verify circle registered
5. Verify score increments after payout
6. Verify revocation works
7. Verify re-registration is blocked

### Test Coverage (existing in `contracts/reputation/src/lib.rs`)
- `test_add_authorized_caller_requires_stored_admin_identity`
- `test_add_authorized_caller_rejects_multiple_non_admins`
- `test_add_authorized_caller_by_admin_succeeds`
- `test_add_authorized_caller_is_idempotent`
- `test_remove_authorized_caller_by_admin_succeeds`
- `test_remove_authorized_caller_not_found_returns_error`
- `test_revoked_caller_cannot_increment`
- `test_revoked_caller_cannot_be_re_added`
- `test_stale_allowlist_entry_cannot_resurrect_revoked_caller`
- `test_integrated_factory_is_reputation_admin`
- `test_integrated_reputation_rejects_non_factory_caller_registration`
- `test_integrated_factory_can_register_circle_with_reputation`
- `test_integrated_failed_creates_never_mutate_reputation`

---

## 4. Event Schema Catalog (docs/EVENTS.md)

### Factory Events
| Event | Topics | Data | Version |
|-------|--------|------|---------|
| `circle_created` | `("factory", "circle_created")` | `(circle_address, creator, circle_index)` | 1 |

### Circle Events
| Event | Topics | Data | Version |
|-------|--------|------|---------|
| `initialized` | `("circle", "initialized")` | `(circle_address, member_count, round_amount, members?)` | 1, 2 |
| `joined` | `("circle", "joined")` | `(circle_address, member, join_order, collateral)` | 1 |
| `active` | `("circle", "active")` | `(circle_address, deadline_ledger)` | 1 |
| `contributed` | `("circle", "contributed")` | `(circle_address, member, round_index, amount)` | 1 |
| `payout` | `("circle", "payout")` | `(circle_address, recipient, amount, round_index)` | 1 |
| `default` | `("circle", "default")` | `(circle_address, member, penalty, round_index, new_collateral)` | 1 |
| `round_started` | `("circle", "round_started")` | `(circle_address, round_index, recipient, deadline_ledger)` | 1 |
| `exceptional_settlement` | `("circle", "exceptional_settlement")` | `(circle_address, recipient, pot, round_index, defaulted_count)` | 1 |
| `completed` | `("circle", "completed")` | `(circle_address, member_count)` | 1 |
| `cancelled` | `("circle", "cancelled")` | `(circle_address, caller, ledger)` | 1 |
| `collateral_released` | `("circle", "collateral_released")` | `(circle_address, member, collateral)` | 1 |
| `closed` | `("circle", "closed")` | `(circle_address, closer, total_released, total_expected, reason)` | 1 |
| `paused` | `("circle", "paused")` | `(circle_address, admin, ledger)` | 1 |
| `resumed` | `("circle", "resumed")` | `(circle_address, admin, ledger)` | 1 |

### Reputation Events
| Event | Topics | Data | Version |
|-------|--------|------|---------|
| `score_updated` | `("reputation", "score_updated")` | `(member, new_total_score)` | 1 |
| `increment` (legacy) | `("reputation", "increment", member)` | `(score)` | 1 |
| `caller_added` | `("reputation", "caller_added")` | `(circle)` | 1 |
| `caller_removed` | `("reputation", "caller_removed")` | `(circle)` | 1 |

### Compatibility Rules
1. Never remove existing data fields
2. Never reorder existing data fields
3. Never change the type of an existing field
4. Never change topic names for existing events
5. Appending new trailing fields is backward compatible
6. Breaking changes require a new event name

### Fixture Tests (existing in `indexer/src/fixtures/event-fixtures.ts`)
- 19 supported event fixtures (one per schema)
- 2 compatible variant fixtures (historical + forward-compatible)
- 8 quarantined variant fixtures (unknown + incompatible shapes)

---

## Acceptance Criteria Verification

### Factory Salt Derivation
✅ Salt inputs documented (creator, count, ledger.sequence, ledger.timestamp)
✅ Address derivation explained (SHA256 of XDR concatenation)
✅ Counter read/write sequence traced
✅ Tests cover identical inputs, changing creator, changing count
✅ Failed deployments verified to not consume counter slots
✅ Tests in `contracts/circle_factory/src/lib.rs` cover all cases

### Compound Operation Events
✅ Event sequences documented for payout, settle_round, close, join
✅ Transaction-level tests verify event ordering
✅ Failed transactions verified to emit no events
✅ Indexer ordering tests verify preservation of emission order
✅ Tests in `contracts/circle/src/payout_event_sequence_tests.rs`
✅ Tests in `indexer/src/indexer.ordering.test.ts`

### Reputation Authorization
✅ Admin responsibilities documented
✅ New circle authorization flow explained
✅ Revocation semantics explained (permanent)
✅ Operational checklist provided
✅ Verification commands included
✅ Tests in `contracts/reputation/src/lib.rs` cover registration and revocation

### Event Schema Catalog
✅ Complete catalog for factory, circle, reputation contracts
✅ Topic names, payload fields, release versions documented
✅ Historical fixtures continue to decode
✅ Compatibility rules established
✅ Fixture tests in `indexer/src/fixtures/event-fixtures.ts`
✅ Schema registry in `indexer/src/eventSchemas.ts`