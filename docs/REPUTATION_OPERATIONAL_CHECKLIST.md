# Reputation Contract: Operational Checklist

This document provides verification steps for operators deploying and managing the reputation contract.

## Overview

The reputation contract tracks completed-rounds scores for wallet addresses. Authorization is restricted to authorized circle contracts only.

## Trust Model

| Role | Responsibility |
|------|----------------|
| **Admin** | Can add/remove authorized callers (circles). Set once at `initialize`. |
| **Factory** | Automatically registered as admin; registers each new circle via `add_authorized_caller`. |
| **Circles** | Only authorized circles can call `increment`. |
| **Members** | Cannot self-award points; only receive via circle payouts. |

## Pre-Deployment Verification

### 1. Verify Factory → Reputation Relationship

```bash
# Get factory address from deployment
FACTORY="C..."

# Get reputation admin (should equal factory)
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_admin

# Verify: output should equal $FACTORY
```

### 2. Verify No Pre-Existing Authorized Callers

```bash
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_authorized_callers

# Expected: empty list [] (before any circles are created)
```

### 3. Verify No Revoked Callers

```bash
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_revoked_callers

# Expected: empty list []
```

## Post-Deployment Verification

### 4. After Factory Initialization

```bash
# Create a test circle
stellar contract invoke \
  --id FACTORY_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- create_circle \
  --creator GDEPLOYER... \
  --members '["GALICE...", "GBOB..."]' \
  --round_amount 1000000000 \
  --round_deadline_ledgers 120960
```

### 5. Verify Circle Was Registered

```bash
# Check authorized callers (should contain the new circle)
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_authorized_callers

# Expected: ["CCIRCLE_ADDRESS"]
```

### 6. Verify Circle Can Increment Score

```bash
# Simulate a payout (requires circle contract interaction)
# The circle will call reputation.increment() automatically

# Check score for a member
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- score \
  --member GALICE...

# Expected: 1 (after first payout)
```

## Administrative Operations

### Adding a New Authorized Caller (Manual)

```bash
# Only the admin (factory) can do this
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account factory \
  --network testnet \
  -- add_authorized_caller \
  --caller FACTORY_ADDRESS \
  --circle CCIRCLE_ADDRESS

# Verify
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_authorized_callers
```

### Revoking an Authorized Caller

```bash
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account factory \
  --network testnet \
  -- remove_authorized_caller \
  --caller FACTORY_ADDRESS \
  --circle CCIRCLE_ADDRESS

# Verify
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_authorized_callers  # Should not contain CCIRCLE_ADDRESS

stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_revoked_callers  # Should contain CCIRCLE_ADDRESS
```

### Revocation Semantics

**Important:** Revocation is **permanent**.

- A revoked circle can **never** be re-authorized
- `add_authorized_caller` for a revoked circle returns `CallerRevoked` error
- Points already awarded by the revoked circle remain (scores are monotonic)
- Future payouts by the revoked circle will fail with `UnauthorizedCaller`

## Verification Checklist

| Step | Check | Command |
|------|-------|---------|
| 1 | Admin is factory | `get_admin` equals factory address |
| 2 | No unauthorized callers | `get_authorized_callers` is empty initially |
| 3 | No revoked callers | `get_revoked_callers` is empty initially |
| 4 | Circle registered after create | Circle appears in `get_authorized_callers` |
| 5 | Score increments | `score(member)` increases after payout |
| 6 | Revocation works | Circle removed from authorized, added to revoked |
| 7 | Re-registration blocked | `add_authorized_caller` for revoked circle fails |

## Troubleshooting

### "UnauthorizedCaller" on Increment

**Cause:** Circle is not in `AuthorizedCallers` or is in `RevokedCallers`.

**Resolution:**
```bash
# Check if circle is revoked
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account deployer \
  --network testnet \
  -- get_revoked_callers

# If present: revocation is permanent, cannot fix
# If absent: manually add via factory
stellar contract invoke \
  --id REPUTATION_ADDRESS \
  --source-account factory \
  --network testnet \
  -- add_authorized_caller \
  --caller FACTORY_ADDRESS \
  --circle CCIRCLE_ADDRESS
```

### "NotAdmin" on add_authorized_caller

**Cause:** Caller is not the stored admin.

**Resolution:** Ensure the transaction is signed by the factory address (not the deployer wallet).

### Score Not Updating

**Cause:** Reputation increment failed during payout.

**Resolution:** Check circle is authorized, then retry payout.

## Security Considerations

1. **Admin immutability**: Once set, admin cannot be changed
2. **Revocation permanence**: Revoked circles can never regain authorization
3. **Score monotonicity**: Scores only increase; no decrement or reset
4. **Factory as admin**: Only the factory can register circles (no direct admin registration)

## Indexer Projection

The indexer projects reputation events as follows:

| Event | Projection |
|-------|------------|
| `score_updated` | Updates `reputation` table: `score = new_total_score` |
| `increment` (legacy) | Same as `score_updated` for replay compatibility |
| `caller_added` | Not projected (authorization read on-demand) |
| `caller_removed` | Not projected (revocation read on-demand) |

For accurate reputation data, the indexer reads `get_authorized_callers` and `get_revoked_callers` on-chain rather than relying solely on events.