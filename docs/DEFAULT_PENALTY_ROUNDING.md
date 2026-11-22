# Default Penalty Rounding

Issue #874. This is the single statement of how a missed-round penalty is
computed in base units, shared by the contract, SDK and app.

## Rule

All amounts are i128 **stroops** (1 USDC = 10,000,000 stroops).

```text
penalty        = collateral × PENALTY_BPS / BPS_DENOM    // integer division
               = floor(collateral × 2 000 / 10 000)
               = floor(collateral / 5)
new_collateral = collateral − penalty
```

- **Floor.** `collateral` is never negative, so truncating division is a floor.
  Fractional stroops are dropped in the member's favour. Nothing is rounded
  up, and no amount is rejected for being indivisible.
- **Remaining balance.** The penalty is taken from the member's *current*
  collateral, not the original deposit, so repeated misses decay
  geometrically.
- **At most once per (member, round).** `mark_default` writes
  `Defaulted(member, round)`. A second `mark_default` for the same round fails
  with `AlreadyDefaulted` (13) and changes nothing. `settle_round` skips
  members who already carry the marker.
- **Never negative, never zero.** For any `c ≥ 1`, `floor(c/5) < c`, so
  positive collateral stays ≥ 1. A stored balance of 0 is rejected with
  `MemberNotJoined` (12).
- **No token movement.** A penalty only reduces the stored collateral. The
  forfeited tokens stay in the circle contract and are not paid to other
  members (see [TERMINAL_CLOSE_SEMANTICS.md](./TERMINAL_CLOSE_SEMANTICS.md)).
- **Deadline boundary.** A default is allowed only when
  `ledger > deadline_ledger`. At the deadline ledger itself it fails with
  `DeadlineNotPassed` (9).

## Derived boundary values

| Collateral (stroops) | Penalty | Remaining | Note |
|---:|---:|---:|---|
| 1 | 0 | 1 | smallest supported contribution (`round_amount ≥ 1`) |
| 4 | 0 | 4 | largest zero-penalty balance |
| 5 | 1 | 4 | first non-zero penalty |
| 9 | 1 | 8 | 1.8 → 1 |
| 10 | 2 | 8 | exact |
| 9 999 | 1 999 | 8 000 | 1 999.8 → 1 999 |
| 10 000 | 2 000 | 8 000 | exact `BPS_DENOM` multiple |
| 10 001 | 2 000 | 8 001 | 2 000.2 → 2 000 |
| 10 000 000 (1 USDC) | 2 000 000 | 8 000 000 | |
| 100 000 000 (10 USDC) | 20 000 000 | 80 000 000 | |

Repeated misses from 100 stroops: 100 → 80 → 64 → 52 → 42 (12.8 → 12,
10.4 → 10). From 1 stroop: 1 → 1 → 1 → 1 (the default counter still
increments every time).

## Where the rule lives

| Layer | Location |
|---|---|
| Contract | `mark_default` and `settle_round` in `contracts/circle/src/lib.rs` |
| Contract tests | `contracts/circle/tests/default_penalty_boundary_tests.rs` (table, deadline boundary, repeat/settle double-charge guards, depleted balance, decay sequences, property tests) |
| SDK | `computeDefaultPenalty`, `projectCollateralAfterDefaults`, `PENALTY_ROUNDING = "floor"` in `sdk/src/penalty.ts` |
| App | `previewDefaultPenalty`, `PENALTY_RULE_TEXT` in `app/src/lib/penalty.ts`, shown in the mark-default confirmation dialog |

The SDK and app tests use the same table.

## Changing the rule

Changing `PENALTY_BPS`, the rounding direction, or the "remaining balance"
basis is a protocol change. Update the contract, this table, both mirrors and
all three test suites in one PR, and call it out in release notes.
