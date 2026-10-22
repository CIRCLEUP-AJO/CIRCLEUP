# Factory Deployment Salt and Address Guarantees

## Overview

The CircleFactory contract uses a deterministic salt-derivation scheme to generate unique deploy addresses. This document specifies the salt inputs, uniqueness guarantees, and the role of the monotonic counter in preventing collisions and replay attacks.

## Salt Derivation Function

The `derive_circle_salt` function combines four inputs via SHA-256:

```
salt = SHA256(creator || count || ledger_sequence || ledger_timestamp)
```

| Input | Type | Purpose | Uniqueness |
|-------|------|---------|-----------|
| `creator` | Address | Wallet that initiated `create_circle` | Different creators → different salt |
| `count` | u32 | Factory monotonic counter | Incremented only on success; never reused |
| `ledger_sequence` | u32 | Soroban ledger sequence number at deploy | Different ledger blocks → different salt |
| `ledger_timestamp` | u64 | Soroban ledger timestamp at deploy | Different block times → different salt |

## Uniqueness Guarantees

### Same Creator, Same Ledger Block

Within a single ledger block (`sequence_number` and `timestamp` fixed), the same creator **cannot** produce two distinct circles because:

- The `count` is immutable until `create_circle` completes and commits (step 7).
- A failed `create_circle` does not increment `count` (rollback on any error in steps 1–6).
- The next successful `create_circle` from the same creator receives `count + 1`, producing a different salt.

**Guarantee:** Successful creates in one factory instance do not collide.

### Different Creators, Any Ledger State

Two different creators will always produce different salts because:

- Each creator's Address is hashed into the salt.
- Even if `count`, `ledger_sequence`, and `ledger_timestamp` are identical, different creators hash to different pre-images.

**Guarantee:** No two wallets can create circles with identical addresses, regardless of timing.

### Ledger Advance

When `ledger_sequence` or `ledger_timestamp` changes, the salt changes, even if creator and count are held constant. This provides additional entropy that guards against:

- Factory redeploys that reset the counter to 0.
- Retry logic after a transaction abort.

**Guarantee:** A retry of a failed create in a different ledger block will produce a different address than the original attempt.

## Counter Semantics

### Monotonic Increment

The `CircleCount` is a u32 that increments by 1 on each successful `create_circle`. It is never decremented.

- **Initialization:** `CircleCount = 0` at factory `initialize`.
- **Successful create:** `CircleCount = count → count + 1` (step 7).
- **Failed create:** `CircleCount` unchanged; the transaction rolls back before step 7.

### Counter Never Wraps

The u32 counter can hold values from 0 to 4,294,967,295. Once `CircleCount` reaches u32::MAX, the factory will panic on the next increment attempt because:

```rust
env.storage().instance().set(&DataKey::CircleCount, &(count + 1));
```

will attempt to store a value that exceeds u32::MAX.

**Practical limit:** A factory can safely deploy up to 4,294,967,295 circles before exhaustion.

### Counter is Mixed into Salt

The counter is XORed into the salt derivation as a u32. Even a single bit flip in the counter produces a completely different 256-bit SHA-256 output (avalanche effect).

**Guarantee:** Each unique count value is guaranteed to produce a different salt (holding other inputs constant).

## Deployment Order and Atomicity

The factory ensures atomicity by deferring counter increment until the end:

```
1. Validate inputs                              [no state change]
2. Load config                                  [read-only]
3. Read count + registry                        [read-only]
4. Deploy circle                                [transaction live]
5. Initialize circle                            [transaction live]
6. Add reputation caller                        [transaction live]
7. Increment count + append to registry         [only write]
8. Emit event
```

A failure **anywhere** in steps 1–6 aborts the entire transaction. The counter is only incremented in step 7, so:

- Failed deploys never burn a counter slot.
- Registry and counter are always in sync: `CircleCount == Circles.len()`.
- A retry with the same creator and ledger state uses the same salt as the original attempt (proving the counter was not incremented).

## Non-Guarantees (Cross-Factory Determinism)

Different factory contracts **cannot** rely on consistent address derivation because:

1. They do not share a counter — each factory has its own monotonic sequence.
2. They likely have different WASM hashes — the deployed circle address depends on the salt and the WASM hash.
3. If one factory is re-deployed, its counter resets to 0, reusing salts in a fresh ledger state.

**Implication:** Each factory maintains a separate address space. The same creator and ledger state in two different factories may produce different circle addresses due to different starting counters and WASM versions.

## Tested Properties

- **Determinism:** Same inputs (creator, count, ledger state) always produce the same salt.
- **Uniqueness:** Each distinct creator produces a different salt for the same count.
- **Counter drift:** Each distinct count produces a different salt for the same creator.
- **Ledger entropy:** Ledger sequence and timestamp contribute independent entropy.
- **Counter atomicity:** Failed creates do not increment the counter, so a retry uses the same salt.
- **Registry consistency:** After each successful create, `CircleCount == Circles.len()`.

## References

- `derive_circle_salt()` implementation in `contracts/circle_factory/src/lib.rs`
- `create_circle()` transaction flow and step ordering
- Test cases: `test_545_*` and atomicity-related tests in `circle_factory/src/lib.rs`
- Issue #684: Specify factory deployment salt and address guarantees
