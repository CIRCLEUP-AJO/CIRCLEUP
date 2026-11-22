# Circle Factory: Salt Derivation and Deterministic Deployment

This document describes how the CircleFactory contract derives deployment salts for new circle instances and guarantees unique, reproducible addresses.

## Overview

The factory uses a deterministic salt derivation function that combines four inputs:

```
salt = SHA256(creator.toXDR() || count.toXDR() || ledger.sequence.toXDR() || ledger.timestamp.toXDR())
```

## Salt Inputs

| Input | Type | Source | Purpose |
|-------|------|--------|---------|
| `creator` | `Address` | Caller of `create_circle` | Different creators produce different addresses for the same count |
| `count` | `u32` | Factory's `CircleCount` storage | Monotonic counter; only incremented on success |
| `ledger.sequence` | `u64` | Current ledger sequence | Extra entropy; prevents count-reset collisions after factory redeploy |
| `ledger.timestamp` | `u64` | Current ledger timestamp | Additional entropy for future-proofing |

## Address Derivation

The factory deploys using `env.deployer().with_current_contract(salt)`, which produces a contract address that is:

1. **Deterministic**: Same inputs → same address (within the same ledger state)
2. **Unique**: Different inputs → different address (collision-resistant via SHA-256)
3. **Reproducible**: Off-chain tooling can pre-compute expected addresses

## Counter Invariant

The factory maintains a strict invariant:

```
CircleCount == Circles.len()  (always)
```

The counter is read **before** any deployment attempt and only incremented **after** successful deployment + initialization + reputation registration. This means:

- **Failed deployments do NOT consume a counter slot**
- **Failed deployments do NOT add to the Circles registry**
- **Retry with identical inputs produces the same salt (same ledger state)**

## Deployment Sequence

```
1. creator.require_auth()
2. validate_create_inputs()      // Pure validation; no state reads
3. Load CircleCount, Circles     // Read counter BEFORE any mutation
4. derive_circle_salt()          // Compute salt from (creator, count, ledger)
5. env.deployer().deploy()       // Deploy contract; failure rolls back here
6. circle.initialize()           // Initialize; failure rolls back deploy
7. reputation.add_authorized_caller() // Register with reputation
8. registry::push()              // Append to Circles, increment CircleCount
9. Emit factory/circle_created   // Event with circle_index = count (pre-increment)
```

## Test Coverage

The factory test suite (`contracts/circle_factory/src/lib.rs`) includes:

- `test_derive_circle_salt_is_stable_for_same_inputs` — identical inputs produce identical salts
- `test_derive_circle_salt_differs_by_count` — different counts produce different salts
- `test_derive_circle_salt_differs_by_creator` — different creators produce different salts
- `test_derive_circle_salt_differs_by_ledger_sequence` — sequence changes affect salt
- `test_545_derive_circle_salt_differs_by_timestamp` — timestamp changes affect salt
- `test_545_derive_circle_salt_is_deterministic_given_fixed_ledger` — deterministic within ledger
- `test_545_each_salt_input_independently_contributes` — all four inputs matter
- `test_545_failed_create_does_not_advance_salt_counter` — failed creates don't burn slots
- `test_failed_create_does_not_increment_count` — counter unchanged after rejection
- `test_failed_create_does_not_add_to_circles_list` — registry unchanged after rejection
- `test_multiple_failed_creates_state_remains_clean` — five failures leave state at 0

## Operational Verification

To verify deterministic deployment on-chain:

```bash
# Get factory state
stellar contract invoke \
  --id FACTORY_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_circle_count

stellar contract invoke \
  --id FACTORY_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_circles

# Pre-compute expected address (pseudocode)
creator = "G..."
count = 0
ledger_seq = $(stellar ledger info --network testnet | grep "Sequence" | awk '{print $2}')
salt = sha256(creator.toXDR() + count.toXDR() + ledger_seq.toXDR() + ledger_ts.toXDR())
expected_address = "C" + base32(salt)
```

## Failure Modes

| Failure Point | Effect on Counter | Effect on Registry |
|--------------|-------------------|-------------------|
| Input validation (members, amount, deadline) | None | None |
| Missing CircleCount/Circles storage | Panic before deploy | None |
| `env.deployer().deploy()` failure | None | None |
| `circle.initialize()` failure | None | None (deploy rolled back) |
| `reputation.add_authorized_caller()` failure | None | None (all rolled back) |

## Trust Model

- **Factory admin**: Can initialize the factory once; cannot influence salt derivation
- **Creator**: Any address can create circles; salt includes their address
- **Counter**: Only advances on successful deployment; no front-running via counter manipulation
- **Registry**: Append-only; circles are never removed or reordered

## Compatibility Notes

- The salt derivation function is part of the factory's stable interface
- Adding new salt inputs would change all future addresses (documented as breaking)
- Ledger entropy (sequence, timestamp) ensures uniqueness even if counter management changes