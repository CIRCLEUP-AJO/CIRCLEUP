# CircleUp — Lifecycle-to-Event Matrix

Every user-visible lifecycle transition must trace back to an explicit
contract event or to a documented derivation rule. Without one, the indexer's
history is incomplete even when contract storage is correct. This matrix was
built from the `env.events().publish` calls in `contracts/` and the handlers
in `indexer/src/indexer.ts`. Payload schemas are in [EVENTS.md](EVENTS.md) and
versioning rules are in [EVENT_COMPATIBILITY.md](EVENT_COMPATIBILITY.md).

Projection agreement is tested for every row in
`indexer/src/eventSchemas.test.ts`: each fixture is encoded to XDR, decoded by
the indexer, and run through its handler, and the test asserts the written
SQL parameters against the event payload. The contract side of the new
`initialized` v2 payload is pinned by
`test_initialized_event_carries_rotation_as_trailing_field` in
`contracts/circle/src/tests.rs`.

---

## Matrix

| Transition | Contract entry point | Event(s) | Identifiers & values the projection needs | Projection | Status |
|---|---|---|---|---|---|
| **Create** | factory `create_circle` | `circle/initialized` then `factory/circle_created` (same tx) | circle address, creator, ledger | `circles` row (`Pending`) | ✅ creator back-filled when `initialized` created the row first (it fires first in the tx) |
| **Configure** | circle `initialize` | `circle/initialized` v2 | circle address, `member_count`, `round_amount`, **`members` (rotation)** | `circles.member_count / total_rounds / round_amount`; one `circle_members` row per slot (`payout_order` = index) | ✅ **fixed**: rotation added as trailing v2 field. Before this, no event carried the member list, so `circle_members` was never populated |
| **Join** | `join` | `circle/joined` | circle, member, `join_order`, collateral | `circle_members.join_order / collateral / joined_at` | ✅ fails visibly (`event_failures`) when no member row exists, instead of updating 0 rows |
| **Activation** | `join` (last member) | `circle/active` (same tx as last `joined`) | circle, `deadline_ledger` | `circles.status = 'Active'` | ✅ |
| **Contribution** | `contribute` | `circle/contributed` | circle, member, `round_index`, amount, tx hash, ledger | `contributions` row | ✅ |
| **Payout** | `payout`, `settle_round` | `circle/payout` | circle, recipient, amount, `round_index`, tx hash, ledger | `payouts` row; `circles.current_round = round_index + 1` | ✅ |
| **Next round** | `payout`, `settle_round` (not last round) | `circle/round_started` | circle, new `round_index`, recipient, deadline | `circles.current_round` | ✅ |
| **Exceptional settlement** | `settle_round` | `circle/exceptional_settlement` (before `payout`) + one `circle/default` per missing member | circle, recipient, pot, `round_index`, `defaulted_count` | `payouts.is_exceptional / defaulted_count` | ✅ |
| **Default** | `mark_default`, `settle_round` | `circle/default` | circle, member, penalty, `round_index`, new collateral, tx hash, ledger | `defaults` row; `circle_members.defaults += 1` | ✅ (depends on the member row created at *Configure*) |
| **Completion** | `payout`, `settle_round` (last round) | `circle/completed` (same tx as final `payout`) | circle | `circles.status = 'Completed'` | ✅ |
| **Cancellation** | `cancel` (Pending only) | `circle/cancelled` | circle, caller, ledger, tx hash | `circles.status = 'Cancelled'`; `circle_audit_events` (`cancelled`) | ✅ |
| **Pause** | `pause` | `circle/paused` | circle, admin, ledger | `circles.paused = TRUE` | ✅ **fixed**: the `paused` column was never created, so every event failed with SQLSTATE 42703. Added by migration 007 |
| **Resume** | `resume` | `circle/resumed` | circle, admin, ledger | `circles.paused = FALSE` | ✅ **fixed** (migration 007, as above) |
| **Close** | `close` | `circle/collateral_released` × N, then `circle/closed` | circle, closer, `total_released`, `total_expected_collateral`, reason | `circles.status = 'Closed' / total_released / close_reason`; `circle_audit_events` (`closed`) | ✅ **fixed**: `total_released` and `close_reason` columns added by migration 007 |
| **Reputation** | reputation `increment` (called by circle `payout`) | `reputation/score_updated` | member, new total score | `reputation` upsert | ✅ **fixed**: the indexer only handled `reputation/increment`, which the current contract never emits |

---

## Derivation rules

These transitions are visible to users but are deliberately not stored as
one-to-one event projections:

1. **`Closed` status.** The contract has no `Closed` variant in
   `CircleStatus`. After `close`, `get_status()` still returns `Completed` or
   `Cancelled`, and `is_closed()` returns `true`. The indexer sets
   `circles.status = 'Closed'` when it sees `circle/closed`, and keeps the
   original outcome in `close_reason`. The reconciliation diagnostic
   (`GET /circles/:address/reconciliation`) applies the same rule: `Closed` ⇔
   `is_closed()` and `get_status()` ∈ {Completed, Cancelled}.
2. **Per-member collateral release.** `circle/collateral_released` is
   classified `ignored`. The circle-level total comes from `circle/closed`
   `total_released`. Per-member release amounts equal each member's remaining
   `circle_members.collateral` at close time, which the projection already
   holds.
3. **Collateral after a default.** `circle/default` carries `new_collateral`,
   but the projection does not write it to `circle_members.collateral`.
   Reconciliation (`npm run reconcile`) compares that column with
   `get_collateral(member)` on-chain.
4. **Current round after completion.** `get_current_round()` errors for
   Completed and Cancelled circles. The indexer leaves `current_round` at
   `total_rounds` after the final payout, and reconciliation skips the field
   for those states.
5. **Reputation authorisation** (`caller_added` / `caller_removed`) is
   classified `ignored`. It is not user-visible history. The allowlist is read
   on-chain through `get_authorized_callers` / `get_revoked_callers`.

---

## Recovering history indexed before these fixes

- **Pause / resume / close** events skipped before migration 007: apply the
  migration, then run `npm run replay --workspace=indexer -- --retry-failed`.
  The events are in `event_failures`, so the retry re-ingests them.
- **Reputation** rows that were never written from `score_updated`: run a
  partial replay from the first ledger of interest (`--partial --from=<ledger>`)
  so those events are re-fetched.
- **Member rows** for circles initialized by a v1 contract build cannot be
  derived from events, because the v1 payload has no rotation. Their
  `circle/joined` events stay in `event_failures` until an operator backfills
  the rows from `get_config()` (compare them first with
  `npm run reconcile:circle -- <address>`) and then runs `--retry-failed`, or
  acknowledges the failures.
