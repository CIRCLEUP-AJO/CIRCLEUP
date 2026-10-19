# Protocol Invariant Evidence

This reference covers the protocol properties listed below. A guarantee is
included only where both the enforcing code and executable test evidence are
identified. Test names are searchable symbols in the linked modules. Other
behavior, including untested assumptions, is not asserted here.

| Area | Enforcing code | Executable evidence |
|---|---|---|
| Authorization | [`circle/src/lib.rs`](../contracts/circle/src/lib.rs) (`join`, `contribute`, `mark_default`, `pause`, `resume`, `close`); [`reputation/src/lib.rs`](../contracts/reputation/src/lib.rs) (`require_admin`, caller allowlist); [`circle_factory/src/lib.rs`](../contracts/circle_factory/src/lib.rs) (`create_circle`) | [`circle/adversarial_tests.rs`](../contracts/circle/src/adversarial_tests.rs) (`adv_circle_join_stranger_rejected`, `adv_circle_contribute_stranger_rejected`, `adv_rep_non_admin_cannot_add_caller`, `adv_rep_non_admin_cannot_remove_caller`); [`reputation/src/lib.rs`](../contracts/reputation/src/lib.rs) (`test_add_authorized_caller_requires_stored_admin_identity`, `test_revoked_caller_cannot_increment`); [`circle_factory/src/lib.rs`](../contracts/circle_factory/src/lib.rs) (`test_create_circle_requires_creator_auth`) |
| Collateral | [`circle/src/lib.rs`](../contracts/circle/src/lib.rs) (`join`, `close`, transfer helpers) | [`circle/src/tests.rs`](../contracts/circle/src/tests.rs) (`test_join_locks_collateral`, `test_close_returns_collateral`); [`circle/prop_tests.rs`](../contracts/circle/src/prop_tests.rs) (`prop_collateral_never_negative`, `prop_balance_conservation_full_lifecycle`) |
| Contribution order and payout rotation | [`circle/src/lib.rs`](../contracts/circle/src/lib.rs) (`initialize`, `contribute`, `payout`) | [`circle/join_order_tests.rs`](../contracts/circle/src/join_order_tests.rs) (`reverse_join_order_keeps_configured_rotation`, `interleaved_join_order_keeps_configured_rotation`); [`circle/src/tests.rs`](../contracts/circle/src/tests.rs) (`test_payout_correct_rotation_order`, `test_payout_before_all_contribute_panics`) |
| Deadlines and defaults | [`circle/src/lib.rs`](../contracts/circle/src/lib.rs) (`mark_default`, `settle_round`) | [`circle/src/tests.rs`](../contracts/circle/src/tests.rs) (`test_mark_default_at_exact_deadline_panics`, `test_mark_default_at_deadline_plus_one_succeeds`); [`circle/lifecycle_invariant_tests.rs`](../contracts/circle/src/lifecycle_invariant_tests.rs) (`test_settle_round_before_deadline_panics`, `test_settle_round_partial_pot_one_defaulter`) |
| Payout | [`circle/src/lib.rs`](../contracts/circle/src/lib.rs) (`payout`, `settle_round`, reputation award) | [`circle/mutation_guards.rs`](../contracts/circle/src/mutation_guards.rs) (`guard_payout_single_use_settled_marker`, `guard_payout_requires_full_contribution_counter`); [`circle/error_path_tests.rs`](../contracts/circle/src/error_path_tests.rs) (`failed_reputation_increment_rolls_back_payout`) |
| Pause | [`circle/src/lib.rs`](../contracts/circle/src/lib.rs) (`pause`, `resume`, `assert_not_paused`) | [`circle/src/tests.rs`](../contracts/circle/src/tests.rs) (`test_334_admin_can_pause`, `test_334_non_admin_cannot_pause`, `test_334_admin_can_resume`); [`circle/mutation_guards.rs`](../contracts/circle/src/mutation_guards.rs) (`guard_settle_round_blocked_while_paused`) |
| Cancellation | [`circle/src/lib.rs`](../contracts/circle/src/lib.rs) (`cancel`) | [`circle/cancellation_invariants_tests.rs`](../contracts/circle/src/cancellation_invariants_tests.rs) (`test_cancel_pending_succeeds_and_sets_cancelled_status`, `test_cancel_after_active_rejected`, `test_cancel_with_several_joiners_refunds_joined_members_and_leaves_unjoined_intact`) |
| Close | [`circle/src/lib.rs`](../contracts/circle/src/lib.rs) (`close`) | [`circle/src/tests.rs`](../contracts/circle/src/tests.rs) (`test_179_close_rejected_on_active_circle`, `test_179_close_completed_returns_each_member_collateral_once`, `test_179_close_cancelled_returns_only_joined_member_collateral`) |

## Known Gaps and Assumptions

- Standard factory-created circles store the factory contract as their admin,
  but the factory exposes no pause/resume forwarding method. The `pause`
  entry point's tested behavior does not establish that operators can call it
  for those deployed circles.
- Circle instance and persistent keys have no application-level TTL renewal.
  Do not infer indefinite retention from the lifecycle tests.
- Reputation score renewal is covered by
  `issue_713_increment_renews_persistent_score_ttl` in
  [`reputation/src/lib.rs`](../contracts/reputation/src/lib.rs); this does not
  establish renewal for circle data or inactive reputation scores.
- Network TTL limits, archival windows, and restoration availability are
  network configuration, not guarantees made by these contracts.

## Maintenance

When a protocol rule or entry point changes, update this reference and link a
test that would fail if the guarantee regressed. Add missing tests before
promoting assumptions or open questions to guarantees. Run the relevant Rust
contract test module and review `docs/API_INVARIANTS.md` for consistency.