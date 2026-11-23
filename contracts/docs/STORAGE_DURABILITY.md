# Storage Durability Classification

This document inventories every contract key across all three CircleUp contracts and classifies its storage durability, required lifetime, and TTL extension requirements.

## Soroban Storage Classes

| Class | Durability | TTL Behavior |
|-------|------------|--------------|
| **Instance** | Permanent for contract lifetime | Never expires; tied to contract instance |
| **Persistent** | Time-limited | Requires TTL extension or data is archived |
| **Temporary** | Single transaction | Cleared at transaction end |

---

## Circle Contract Storage Keys

### Instance Storage (Permanent)

| Key | Type | Lifetime | TTL Extension | Notes |
|-----|------|----------|---------------|-------|
| `Config` | CircleConfig | Contract lifetime | N/A | Immutable after initialize; required for all operations |
| `Status` | CircleStatus | Contract lifetime | N/A | Lifecycle state; changes but never expires |
| `CurrentRound` | RoundState | Active/Completed | N/A | Updated each round; instance storage |
| `RoundsCompleted` | u32 | Contract lifetime | N/A | Counter for close validation |
| `Admin` | Address | Contract lifetime | N/A | Pause/resume authority; set once at init |
| `UsdcToken` | Address | Contract lifetime | N/A | Immutable token selection |
| `Paused` | bool | Active circles | N/A | Additive key; absent = not paused |
| `Closed` | bool | Terminal state | N/A | Set after successful close; prevents re-entry |
| `Initializing` | bool | During init | N/A | Reentrancy guard; removed after init |

### Persistent Storage (Requires TTL Extension)

| Key | Type | Required Lifetime | TTL Extension | Notes |
|-----|------|-------------------|---------------|-------|
| `Collateral(member)` | i128 | Until close() | **Required** | Member's locked collateral; must survive until terminal state |
| `Contributed(member, round)` | bool | Until circle completes | **Required** | Proof of contribution; needed for default detection |
| `Defaults(member)` | u32 | Permanent | Recommended | Member's default count; used for reputation/history |
| `Defaulted(member, round)` | bool | Until circle completes | **Required** | Prevents double-penalization in same round |

### Temporary Storage

None. All circle contract storage is either instance or persistent.

---

## Circle Factory Contract Storage Keys

### Instance Storage (Permanent)

| Key | Type | Lifetime | TTL Extension | Notes |
|-----|------|----------|---------------|-------|
| `Admin` | Address | Contract lifetime | N/A | Factory administration authority |
| `CircleWasmHash` | BytesN<32> | Contract lifetime | N/A | WASM hash for new circle deployments |
| `ReputationContract` | Address | Contract lifetime | N/A | Reputation contract address |
| `UsdcToken` | Address | Contract lifetime | N/A | USDC token for new circles |
| `Circles` | Vec<Address> | Contract lifetime | N/A | Registry of deployed circles |
| `CircleCount` | u32 | Contract lifetime | N/A | Monotonic counter; equals Circles.len() |
| `Initializing` | bool | During init | N/A | Reentrancy guard |

### Persistent Storage

None. Factory stores all data in instance storage.

---

## Reputation Contract Storage Keys

### Instance Storage (Permanent)

| Key | Type | Lifetime | TTL Extension | Notes |
|-----|------|----------|---------------|-------|
| `Admin` | Address | Contract lifetime | N/A | Authorization authority for callers |
| `AuthorizedCallers` | Vec<Address> | Contract lifetime | N/A | Allowlist of circles that can increment |
| `RevokedCallers` | Vec<Address> | Contract lifetime | N/A | Permanently revoked callers |
| `Initializing` | bool | During init | N/A | Reentrancy guard |

### Persistent Storage (Requires TTL Extension)

| Key | Type | Required Lifetime | TTL Extension | Notes |
|-----|------|-------------------|---------------|-------|
| `Score(member)` | u32 | **Permanent** | **Required** | Member's reputation score; never expires |

---

## TTL Extension Requirements by Lifecycle Phase

### Active Circle (In Progress)

| Key | TTL Action | Rationale |
|-----|------------|-----------|
| `Collateral(member)` | Extend to circle completion + 30 days | Members may delay close() |
| `Contributed(member, round)` | Extend to circle completion | Needed for default detection |
| `Defaulted(member, round)` | Extend to circle completion | Prevents double-penalization |
| `Defaults(member)` | Extend to circle completion | Tracks member history |

### Completed Circle (Awaiting Close)

| Key | TTL Action | Rationale |
|-----|------------|-----------|
| `Collateral(member)` | Extend 90 days | Members may take time to claim |
| `Contributed(member, round)` | No action needed | Circle is complete |
| `Defaulted(member, round)` | No action needed | Circle is complete |
| `Defaults(member)` | **Extend permanently** | Reputation history |

### Closed Circle (Settled)

| Key | TTL Action | Rationale |
|-----|------------|-----------|
| `Collateral(member)` | Can expire | All collateral released |
| `Contributed(member, round)` | Can expire | Circle complete |
| `Defaulted(member, round)` | Can expire | Circle complete |
| `Defaults(member)` | **Extend permanently** | Reputation history |

### Reputation Scores

| Key | TTL Action | Rationale |
|-----|------------|-----------|
| `Score(member)` | **Extend to max (200,000 ledgers)** | Scores represent permanent reputation |

---

## TTL Extension API

```rust
// Extend TTL for a key (min, max ledgers to extend)
env.storage().persistent().extend_ttl(&key, min_ledgers, max_ledgers);
```

### Recommended Extension Values

| Use Case | Min TTL | Max TTL |
|----------|---------|---------|
| Active circle continuation | 50,000 | 100,000 |
| Completed circle (before close) | 100,000 | 200,000 |
| Reputation scores | 100,000 | 200,000 |
| Permanent retention | 200,000 | 200,000 (max) |

---

## Protocol-Level TTL Management

CircleUp does **not** automatically extend TTLs in the contract code. Operators must:

1. **Monitor TTLs** using the RPC API (`getLedgerEntry` response includes `expirationLedger`)
2. **Extend before expiry** by calling contract entry-points that access the keys
3. **Use the indexer** to track TTL state and alert operators

---

## Storage Cost Implications

| Storage Type | Rent (per ledger) | Write Cost |
|--------------|-------------------|------------|
| Instance | N/A (permanent) | Higher one-time |
| Persistent | ~0.1 XLM/ledger/KB | Lower one-time |

---

## Compatibility Notes

- **L1 → L3 upgrade**: No TTL changes required; instance keys are permanent
- **Persistent keys**: TTL extension is the operator's responsibility
- **No automatic expiration**: Contracts don't auto-expire data; operators must manage

---

## Summary Table

| Contract | Instance Keys | Persistent Keys | Auto-Extend | Operator Action |
|----------|---------------|-----------------|-------------|-----------------|
| Circle | 9 | 4 | No | Extend Collateral/Contributed during active phase |
| Factory | 7 | 0 | N/A | None required |
| Reputation | 4 | 1 | No | Extend Score permanently |