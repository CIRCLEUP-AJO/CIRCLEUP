# Privileged Contract Controls and Key Custody

**Status**: Documented for Issue #682  
**Last Updated**: October 17, 2026

## Overview

CircleUp contracts employ a trust boundary enforced by privileged operations that only authorized addresses can invoke. This document enumerates all privileged methods, their controlling addresses, initialization procedures, custody model, rotation constraints, and recovery limitations to ensure operators and auditors can understand who controls pause, authorization, configuration, and fund movement.

---

## Privileged Methods by Contract

### Circle Contract

#### 1. pause(admin: Address)

**Access Control**: Only the stored `admin` address may call this.

**Implementation**:
```rust
pub fn pause(env: Env, admin: Address) -> Result<(), PauseError> {
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(PauseError::NotInitialized)?;

    admin.require_auth();  // Admin must sign

    if admin != stored_admin {
        return Err(PauseError::Unauthorized);
    }
    // ... set Paused flag to true
}
```

**Effect**: Blocks all fund-moving operations (join, contribute, payout, settle_round, mark_default, close). Read-only views remain available.

**Guard**: `admin.require_auth()` ensures the admin's signature is in the transaction envelope.

**Recovery Limitation**: If the admin address loses its key, the circle cannot be unpaused. No key rotation is supported.

---

#### 2. resume(admin: Address)

**Access Control**: Only the stored `admin` address may call this.

**Implementation**: Identical authorization to `pause()` with `admin.require_auth()`.

**Effect**: Unblocks all fund-moving operations by removing the `Paused` flag.

**Rotation Limitation**: Same as pause — no key rotation supported.

---

#### 3. initialize(env, members, round_amount, usdc_token, reputation_contract, round_deadline_ledgers)

**Access Control**: Anyone can call this, but only once per contract.

**Initialization Sequence**:
1. All validation passes without any state mutation (except reentrancy guard).
2. If validation passes:
   - `Config` key is written with the provided parameters.
   - `Status` is set to `Pending`.
   - `CurrentRound` is initialized with round_index=0, recipient=members[0], contributions_received=0.
   - `RoundsCompleted` is set to 0.
   - `Admin` is set to the **caller address** (not a parameter).
   - `UsdcToken` is set to the immutable `usdc_token` address.
   - Reentrancy guard (`Initializing`) is cleared.

**Key Custody Decision**: The caller becomes the admin. Typically:
- In factory deployments: Factory sets itself as admin and later transfers admin authority to a governance contract or multisig.
- In direct deployments: The deployer is the admin until transferred via a governance or manual coordination mechanism.

**No Transfer Mechanism**: There is **no `set_admin()` or `transfer_admin()`** entry-point. The admin address is locked at initialization and cannot be changed.

**Recovery Limitation**: If the deployer loses the initialization key, the circle's admin is "locked in" and cannot be changed. Deployers **must** use governance multisigs or deployment automation that ensures the admin address is correct before initialization.

---

#### 4. cancel(member: Address)

**Access Control**: Only a member of the circle (in the `members` list) may call this.

**Implementation**:
```rust
fn assert_member(env: &Env, members: &Vec<Address>, who: &Address) {
    for m in members.iter() {
        if m == who {
            return;  // OK, caller is a member
        }
    }
    panic!("caller is not a member of this circle");
}
```

**Effect**: Transitions circle from `Pending` → `Cancelled`, preventing further joins. Collateral is not released; it is released via `close()` later.

**Guard**: Caller must be in the immutable `members` list.

**Access Limitation**: Any single member can cancel a Pending circle. There is no multi-sig or consensus requirement.

---

#### 5. close(caller: Address)

**Access Control**: Either:
- The caller is a member of the circle, **OR**
- The caller is the stored `admin`.

**Implementation**:
```rust
let is_member = members.iter().any(|m| m == caller);
let is_admin = caller == env
    .storage()
    .instance()
    .get(&DataKey::Admin)
    .unwrap_or_else(|| Address::generate(&env));  // dummy fallback

if !is_member && !is_admin {
    panic!("caller must be a member or the admin");
}
```

**Effect**: Releases all collateral and marks circle as `Closed`. Idempotent — calling twice is safe.

**Guard**: Dual access (member OR admin). Allows any member to trigger settlement if the admin is unavailable.

---

### CircleFactory Contract

#### 1. create_circle(deployer, members, round_amount, usdc_token, reputation_contract, round_deadline_ledgers)

**Access Control**: Anyone can call this, but the factory **registers itself as the admin** of each deployed circle.

**Implementation**:
```rust
fn create_circle(env: Env, params: ...) -> Address {
    let circle_contract = deploy_contract(env, &WASM_HASH);
    
    let circle = CircleClient::new(&env, &circle_contract);
    circle.initialize(
        members,
        round_amount,
        usdc_token,
        reputation_contract,
        round_deadline_ledgers,
    );
    // Factory's own address becomes the admin (via initialize's caller check)
    
    circle_contract
}
```

**Consequence**: The **factory contract** holds pause/resume authority over all circles it creates.

**Custody Model**: Typically, the factory itself is governed by a multisig or DAO, so pause authority is delegated to governance consensus.

---

### Reputation Contract

#### 1. add_authorized_caller(admin, caller: Address)

**Access Control**: Only the stored `admin` address may call this.

**Implementation**:
```rust
pub fn add_authorized_caller(
    env: Env,
    admin: Address,
    caller: Address,
) -> Result<(), ReputationError> {
    admin.require_auth();
    
    let stored_admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ReputationError::NotInitialized)?;
    
    if admin != stored_admin {
        return Err(ReputationError::Unauthorized);
    }
    
    // Add caller to authorized list
    let mut authorized: Vec<Address> = env
        .storage()
        .instance()
        .get(&DataKey::AuthorizedCallers)
        .unwrap_or_else(|| Vec::new(&env));
    authorized.push_back(caller);
    env.storage().instance().set(&DataKey::AuthorizedCallers, &authorized);
    
    Ok(())
}
```

**Effect**: Allows a circle contract to call `increment()` and award reputation.

**Guard**: `admin.require_auth()` ensures the signature is present.

**Custody**: Typically, the reputation contract admin is a governance multisig or the factory itself.

---

#### 2. remove_authorized_caller(admin, caller: Address)

**Access Control**: Only the stored `admin` address may call this.

**Implementation**: Similar to `add_authorized_caller()`.

**Effect**: Revokes a circle's ability to call `increment()`. Permanent — no "suspend" mechanism.

**Guard**: Same `admin.require_auth()`.

**Recovery Limitation**: If a circle is revoked, it cannot award reputation. The circle's admin (likely the factory) must request re-authorization from the reputation contract admin (likely governance).

---

## Initialization and Custody Model

### Deployment Procedure

1. **Deploy factory contract** (or circles directly).
2. **Deploy reputation contract** (typically by governance or a deployment script).
3. **Register factory as authorized caller** on reputation:
   ```
   reputation.add_authorized_caller(governance_multisig, factory_address)
   ```
4. **Factory creates circle instances** via `create_circle()`:
   - Factory becomes the admin of each circle.
   - Circle attempts to register itself with reputation contract.
   - If registration fails, circle deployment fails (Soroban rolls back).

### Key Custody Assignments

| Component | Admin | Custodian | Rotation | Recovery |
|---|---|---|---|---|
| **Circle** | Deployer (or factory) | Governance multisig (typically) | None | None — locked at init |
| **Reputation** | Governance multisig | Governance multisig | None | None — locked at init |
| **Factory** | Governance multisig | Governance multisig | None | None — locked at init |

### Custodian Responsibility Matrix

| Operation | Who Can Do It | Responsible Party | Approval Process |
|---|---|---|---|
| Pause circle | Circle admin (factory) | Factory governance | Governance vote |
| Resume circle | Circle admin (factory) | Factory governance | Governance vote |
| Authorize new circle | Reputation admin | Reputation governance | Governance vote |
| Revoke circle reputation | Reputation admin | Reputation governance | Governance vote |

---

## Authorization Events and Auditability

### Circle Pause/Resume Events

Every privileged operation emits an event for audit trail:

**Pause Event**:
```rust
env.events().publish(
    event_topics(&env, "paused"),
    (circle_address, admin, ledger),
);
```

**Resume Event**:
```rust
env.events().publish(
    event_topics(&env, "resumed"),
    (circle_address, admin, ledger),
);
```

**Indexer Implication**: All pause/resume activities are recorded in the ledger and can be queried to audit who paused when.

---

### Reputation Authorization Events

**Add Authorized Caller Event**:
```rust
env.events().publish(
    event_topics(&env, "authorized_caller_added"),
    (reputation_address, admin, caller, ledger),
);
```

**Remove Authorized Caller Event**:
```rust
env.events().publish(
    event_topics(&env, "authorized_caller_removed"),
    (reputation_address, admin, caller, ledger),
);
```

**Audit Trail**: All authorization changes are recorded in the ledger.

---

## Control Change Observability

### What Changes Are Observable Through Events?

✓ Pause/resume (with ledger timestamp)  
✓ Reputation authorization add/remove (with ledger timestamp)  
✓ Fund transfers (join, contribute, payout, settle_round, close) — emitted as `circle/joined`, `circle/contributed`, etc.  

### What Changes Are NOT Observable?

✗ Admin address rotation (no mechanism exists)  
✗ Token address changes (immutable after init)  
✗ Member list changes (immutable after init)  
✗ Round amount changes (immutable after init)  

**Design Rationale**: Immutability prevents silent authority changes. Any change to critical parameters requires redeploying a new contract. This forces explicit, on-chain visibility.

---

## Rotation Constraints

### No Admin Key Rotation

**Constraint**: The `Admin` address is set at initialization and cannot be changed.

**Rationale**: 
- Prevents silent authority transfer attacks.
- Forces explicit contract redeployment if admin needs to change.
- Ensures on-chain auditability: anyone can query the current admin.

**Mitigation**: Deploy new contracts with the correct admin address before the first one is needed. Use governance multisigs for initialization to distribute key custody.

---

### No Authorized Caller Rotation for Reputation

**Constraint**: A circle cannot be "re-authorized" after revocation. A new circle must be deployed.

**Rationale**:
- Prevents replay attacks where a revoked circle regains authorization through state manipulation.
- Ensures permanent, irreversible revocation for security incidents.

**Mitigation**: If a circle is revoked accidentally, deploy a new circle and re-register it. The old circle's collateral can be released via `close()` by the admin.

---

## Recovery Limitations

### Scenario 1: Admin Key Lost

**Problem**: The circle admin loses access to its signing key. The circle cannot be paused or resumed.

**Impact**:
- Circle remains operational (or frozen in a paused state).
- No governance authority can intervene.

**Mitigation**:
- Use multisig wallets (e.g., Stellar multisig) for the admin address so no single key loss causes lockout.
- Pre-coordinate with governance to authorize admin key rotation via multisig amendment.

---

### Scenario 2: Factory Key Lost

**Problem**: The factory admin loses access to its signing key. No new circles can be created, and existing circles cannot be paused/resumed.

**Impact**:
- Governance is unable to exercise pause/resume authority.
- Existing circles operate independently until naturally completed.

**Mitigation**:
- Deploy the factory with a multisig as the admin address.
- Maintain key escrow or split knowledge across governance members.

---

### Scenario 3: Reputation Contract Revokes Circle Accidentally

**Problem**: The reputation contract admin revokes a circle by mistake.

**Impact**:
- Circle cannot call `increment()` to award reputation.
- Payout and settle_round fail (reputation increment failures panic).

**Mitigation**:
- Deploy a new circle and re-register it.
- The old circle's collateral can be released via `close()`.
- Request re-authorization if appropriate (requires reputation admin approval).

---

### Scenario 4: Unauthorized Admin Attempts Pause

**Problem**: A non-admin account attempts to pause a circle.

**Impact**:
- Transaction panics with `PauseError::Unauthorized`.
- No state change occurs; transaction rolls back.

**Guard**: `admin.require_auth()` ensures the transaction fails at the host level before any contract logic runs.

---

## Test Coverage for Privilege Checks

All privileged operations are tested against unauthorized callers:

| Test | File | Purpose |
|---|---|---|
| `test_334_non_admin_cannot_pause` | `tests.rs` | Non-admin pause rejection. |
| `test_334_non_admin_cannot_resume` | `tests.rs` | Non-admin resume rejection. |
| `test_334_stranger_cannot_pause` | `tests.rs` | Unrelated account pause rejection. |
| `test_adversarial_pause_not_authorized` | `adversarial_tests.rs` | Adversarial pause attempt. |
| `test_adversarial_mark_default_by_stranger` | `adversarial_tests.rs` | Stranger mark_default rejection. |
| `test_adversarial_close_not_authorized` | `adversarial_tests.rs` | Non-member close rejection. |
| `test_reputation_increments_only_from_registered_circles` | `tests.rs` | Unregistered circle rejected. |
| `test_reputation_remove_authorized_caller_blocks_increment` | `tests.rs` | Revocation blocks reputation. |

---

## Best Practices for Operators

### 1. Initialization

- **Use a multisig wallet** as the deployer/factory admin to distribute key custody.
- **Verify the admin address** before calling `initialize()` — it cannot be changed afterward.
- **Record initialization parameters** (members, round_amount, admin, reputation_contract address) for auditability.

### 2. Governance and Pause Authority

- **Authorize pause/resume only through governance votes**.
- **Require multi-sig approval** for pause/resume transactions (use Stellar multisig or threshold signers).
- **Log pause/resume reasons** off-chain (in a separate audit log or governance system) for operational context.

### 3. Reputation Management

- **Register circles with reputation contract** after deployment.
- **Revoke circles only after governance review** — revocation is permanent.
- **Maintain an allowlist** of authorized circles and verify it regularly.

### 4. Incident Response

- **Monitor for unauthorized pause attempts** in transaction logs.
- **Set up alerts** when pause/resume events are emitted.
- **Document incident response procedures** for admin key loss, factory lockout, or reputation revocation.

### 5. Auditability

- **Query is_paused() regularly** to detect unplanned pauses.
- **Monitor ledger events** for pause/resume/authorization changes.
- **Verify get_admin() matches expected address** to catch misconfigurations.
- **Maintain off-chain records** of governance approvals that led to privileged operations.

---

## Summary Table: Privileged Operations

| Operation | Entry-Point | Admin | Authorization | Immutable After Init? | Auditable? | Can Rotate? |
|---|---|---|---|---|---|---|
| **Pause** | `pause(admin)` | Circle admin | `admin.require_auth()` | Yes | ✓ Events | No |
| **Resume** | `resume(admin)` | Circle admin | `admin.require_auth()` | Yes | ✓ Events | No |
| **Initialize** | `initialize(...)` | Deployer → becomes admin | Caller address | Yes | ✓ Ledger | No |
| **Close** | `close(caller)` | Member OR admin | Membership check | Yes | ✓ Events | N/A |
| **Add Auth Caller** | `add_authorized_caller(admin, caller)` | Reputation admin | `admin.require_auth()` | Yes | ✓ Events | No |
| **Remove Auth Caller** | `remove_authorized_caller(admin, caller)` | Reputation admin | `admin.require_auth()` | Yes | ✓ Events | No |

---

## Conclusion

CircleUp employs a **trust boundary** enforced through:

1. **Centralized admin authority** — pause/resume via a single immutable admin address.
2. **Role-based access** — authorization checks at the entry-point level.
3. **Event logging** — all privileged operations emit events for audit.
4. **Immutable configuration** — critical parameters (admin, token, members) cannot be changed after initialization, preventing silent authority shifts.

**Key Design Decisions**:
- **No key rotation** — forces explicit redeployment if admin address must change (transparent, auditable).
- **Permanent revocation** — once a circle is revoked from reputation, it cannot regain authorization without governance consensus.
- **Dual access for close** — allows member recovery if admin is unavailable.

**Operator Responsibilities**:
- Use multisigs for admin addresses.
- Gate all pause/resume behind governance votes.
- Monitor events and ledger state for unauthorized access attempts.
- Maintain off-chain records of authorization decisions.

This design ensures that **control paths are observable and changes are auditable**, enabling operators to verify who controls pause, authorization, and fund movement at any point in time.
