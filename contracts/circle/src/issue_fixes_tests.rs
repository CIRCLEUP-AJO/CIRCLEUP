//! Targeted regression tests for issues #552, #553, #554, and #555.
//!
//! # Coverage map
//!
//! | Issue | Area | Guard | Key test(s) |
//! |-------|------|-------|-------------|
//! | #552  | `join` | Duplicate-collateral prevention via CEI + `has` check | Re-join after collateral zeroed, re-join after penalty drain, re-join mid-transfer simulation |
//! | #553  | `join` | `Active` transition only when ALL members have joined | Partial-join stays Pending, exact-member-count triggers Active, deadline clock set at activation not at init |
//! | #554  | `contribute` | Rejects late (past-deadline) and out-of-order (wrong-round) contributions | Past-deadline, exactly-at-deadline accepted, out-of-order round keys don't confuse the guard |
//! | #555  | `mark_default` | Only flags misses in the CURRENT round; cross-round isolation | Cannot default for future round, prior-round key absent, round-index used is always CurrentRound |

#[cfg(test)]
mod issue_fixes_tests {
    extern crate std;

    use crate::{
        CircleContract, CircleContractClient, CircleStatus, DataKey,
        COLLATERAL_MULTIPLIER, MIN_ROUND_DEADLINE_LEDGERS, PENALTY_BPS, BPS_DENOM,
    };
    use reputation::{ReputationContract, ReputationContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger, Events as _},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env, Vec,
    };

    const ROUND_AMOUNT: i128 = 100_000_000; // 10 USDC in stroops
    const ROUND_DEADLINE: u32 = 1_000;

    // ── Shared fixture ────────────────────────────────────────────────────────

    struct Setup<'a> {
        env: Env,
        circle: CircleContractClient<'a>,
        circle_id: Address,
        token: TokenClient<'a>,
        alice: Address,
        bob: Address,
        carol: Address,
        dave: Address,
        circle_admin: Address,
    }

    impl<'a> Setup<'a> {
        fn activate(&self) {
            self.circle.join(&self.alice);
            self.circle.join(&self.bob);
            self.circle.join(&self.carol);
            self.circle.join(&self.dave);
        }

        fn contribute_all(&self) {
            self.circle.contribute(&self.alice);
            self.circle.contribute(&self.bob);
            self.circle.contribute(&self.carol);
            self.circle.contribute(&self.dave);
        }

        fn advance_past_deadline(&self) {
            self.env.ledger().with_mut(|l| {
                l.sequence_number += ROUND_DEADLINE + 1;
            });
        }

        fn force_collateral(&self, member: &Address, amount: i128) {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .set(&DataKey::Collateral(member.clone()), &amount);
            });
        }

        fn has_defaulted_key(&self, member: &Address, round_index: u32) -> bool {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .has(&DataKey::Defaulted(member.clone(), round_index))
            })
        }

        fn has_contributed_key(&self, member: &Address, round_index: u32) -> bool {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .has(&DataKey::Contributed(member.clone(), round_index))
            })
        }

        fn complete_round(&self) {
            self.contribute_all();
            self.circle.payout();
        }
    }

    fn setup() -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token = TokenClient::new(&env, &token_id.address());
        let token_asset = StellarAssetClient::new(&env, &token_id.address());

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);
        let dave = Address::generate(&env);

        // Fund: 1× collateral + 4× contributions per member
        for m in [&alice, &bob, &carol, &dave] {
            token_asset.mint(m, &(ROUND_AMOUNT * (COLLATERAL_MULTIPLIER + 4)));
        }

        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let rep_id = env.register_contract(None, ReputationContract);
        let rep_client = ReputationContractClient::new(&env, &rep_id);
        let rep_admin = Address::generate(&env);
        rep_client.initialize(&rep_admin);
        rep_client.add_authorized_caller(&rep_admin, &circle_id);

        let circle_admin = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(alice.clone());
        members.push_back(bob.clone());
        members.push_back(carol.clone());
        members.push_back(dave.clone());

        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_id.address(),
            &rep_id,
            &ROUND_DEADLINE,
        );

        Setup {
            env,
            circle,
            circle_id,
            token,
            alice,
            bob,
            carol,
            dave,
            circle_admin,
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #552 — Protect join against duplicate collateral transfer edge cases
    //
    // The contract guards against duplicate collateral deposits using:
    //   1. CEI pattern: writes `Collateral(member)` to storage BEFORE the token
    //      transfer, so a reentrant join sees the key and panics.
    //   2. `env.storage().persistent().has(&collateral_key)` — checks key
    //      existence, NOT value > 0, so a zeroed collateral balance cannot be
    //      used to bypass the guard.
    //
    // Acceptance criteria:
    //   • A member whose collateral was zeroed (via penalty drain) cannot rejoin.
    //   • A second join call by the same member is always rejected regardless of
    //     the current on-chain collateral balance.
    //   • The collateral amount stored and transferred is exactly
    //     round_amount × COLLATERAL_MULTIPLIER (no silent overflow to 0).
    //   • A member who cancelled (no Collateral key) can never re-join an Active
    //     circle (status gate fires before the collateral check).
    // ══════════════════════════════════════════════════════════════════════════

    /// The `has` check (not `value > 0`) blocks re-join even when collateral
    /// was zeroed by multiple penalty rounds. The key presence is the gate,
    /// not the value stored under it.
    #[test]
    #[should_panic]
    fn test_552_rejoin_after_collateral_zeroed_by_penalties_panics() {
        let s = setup();
        s.circle.join(&s.alice);

        // Simulate full collateral drain via repeated penalty application
        s.force_collateral(&s.alice, 0i128);
        assert_eq!(s.circle.get_collateral(&s.alice), 0,
            "pre-condition: collateral must be 0 before re-join attempt");

        // Even with zero collateral the Collateral key still EXISTS in storage,
        // so the `has` guard must fire before any token transfer attempt.
        s.circle.join(&s.alice);
    }

    /// The second `join` call by the same member is rejected at the `has` guard
    /// before any token transfer occurs. Alice's wallet balance must be unchanged
    /// between the first and the (rejected) second join call.
    #[test]
    fn test_552_second_join_rejected_before_transfer() {
        let s = setup();
        s.circle.join(&s.alice);

        let bal_after_first_join = s.token.balance(&s.alice);

        // Attempt a second join — it must panic
        let result = s.circle.try_join(&s.alice);
        assert!(result.is_err(), "second join must be rejected");

        // Balance must be unchanged — no transfer occurred
        assert_eq!(
            s.token.balance(&s.alice), bal_after_first_join,
            "wallet balance must not change on a rejected second join attempt"
        );
    }

    /// Collateral stored and transferred on a successful join must equal
    /// round_amount × COLLATERAL_MULTIPLIER. The checked_mul in join panics on
    /// overflow — it never silently returns 0.
    #[test]
    fn test_552_collateral_amount_is_exact_and_nonzero() {
        let s = setup();
        let expected = ROUND_AMOUNT
            .checked_mul(COLLATERAL_MULTIPLIER)
            .expect("test: overflow unexpected for standard fixture");
        assert!(expected > 0, "expected collateral must be positive");

        let bal_before = s.token.balance(&s.alice);
        s.circle.join(&s.alice);
        let bal_after = s.token.balance(&s.alice);

        let transferred = bal_before - bal_after;
        assert_eq!(transferred, expected,
            "tokens transferred must equal round_amount × COLLATERAL_MULTIPLIER");
        assert_eq!(s.circle.get_collateral(&s.alice), expected,
            "stored collateral must equal round_amount × COLLATERAL_MULTIPLIER");
        assert_ne!(s.circle.get_collateral(&s.alice), 0,
            "stored collateral must not be zero after a valid join");
    }

    /// After `cancel`, the circle's status is `Cancelled` (not `Pending`), so
    /// any further `join` attempt is rejected by the status gate ("circle not
    /// accepting members"), not the collateral key gate. Members who never joined
    /// cannot have their join re-attempted on a non-Pending circle.
    #[test]
    #[should_panic]
    fn test_552_join_on_cancelled_circle_rejected_by_status_gate() {
        let s = setup();
        // Alice joins then cancels the circle; Dave never joined
        s.circle.join(&s.alice);
        s.circle.cancel(&s.alice);
        assert_eq!(s.circle.get_status(), CircleStatus::Cancelled);

        // Dave has no Collateral key, but the status gate fires first
        s.circle.join(&s.dave);
    }

    /// After the circle goes Active, further `join` calls are rejected by the
    /// status gate, not by a missing collateral key for a new member.
    #[test]
    #[should_panic]
    fn test_552_join_on_active_circle_rejected_by_status_gate() {
        let s = setup();
        s.activate(); // all four join → Active
        // Alice tries to join again — status gate fires before the collateral check
        s.circle.join(&s.alice);
    }

    /// Every successfully joining member produces exactly one persistent
    /// `Collateral` key. Calling join twice for the same member must leave the
    /// count of Collateral keys unchanged (second call panics, storage not mutated).
    #[test]
    fn test_552_collateral_key_written_exactly_once_per_member() {
        let s = setup();

        // No collateral key before join
        let bal_before = s.circle.get_collateral(&s.bob);
        assert_eq!(bal_before, 0, "collateral must be 0 before join");

        s.circle.join(&s.bob);
        assert_eq!(
            s.circle.get_collateral(&s.bob),
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "collateral must be set after join"
        );

        // Reject second join — collateral must be unchanged
        let _ = s.circle.try_join(&s.bob);
        assert_eq!(
            s.circle.get_collateral(&s.bob),
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "collateral must not change after a rejected second join"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #553 — Add active status transition only after all members have joined
    //
    // The contract transitions to `Active` exactly once: when the last configured
    // member calls `join`. The join-order counter is derived from persistent
    // `Collateral` keys (not from a mutable counter) so it cannot be forged.
    //
    // Acceptance criteria:
    //   • Status stays `Pending` until every configured member has joined.
    //   • Status becomes `Active` the instant the last member joins.
    //   • The round-0 deadline is set at the moment of activation (not at init).
    //   • The `circle/active` event is emitted exactly once, only at activation.
    //   • Subsequent join calls are rejected by the status gate.
    // ══════════════════════════════════════════════════════════════════════════

    /// The circle remains `Pending` after N-1 joins and transitions to `Active`
    /// on the Nth join — not before.
    #[test]
    fn test_553_status_stays_pending_until_all_members_joined() {
        let s = setup();

        assert_eq!(s.circle.get_status(), CircleStatus::Pending);
        s.circle.join(&s.alice);
        assert_eq!(s.circle.get_status(), CircleStatus::Pending,
            "status must be Pending after 1 of 4 joins");
        s.circle.join(&s.bob);
        assert_eq!(s.circle.get_status(), CircleStatus::Pending,
            "status must be Pending after 2 of 4 joins");
        s.circle.join(&s.carol);
        assert_eq!(s.circle.get_status(), CircleStatus::Pending,
            "status must be Pending after 3 of 4 joins");
        s.circle.join(&s.dave); // 4th and final join
        assert_eq!(s.circle.get_status(), CircleStatus::Active,
            "status must become Active only after all 4 members join");
    }

    /// The round-0 deadline is computed at the activation ledger (last join),
    /// not at `initialize` time. This prevents the join window from eating into
    /// the contribution window.
    #[test]
    fn test_553_round_deadline_set_at_activation_not_at_init() {
        let s = setup();

        // Record the deadline set at initialize time
        let init_round = s.circle.get_current_round();
        let deadline_at_init = init_round.deadline_ledger;

        // Advance some ledgers during the join window (simulating real-world delay)
        s.env.ledger().with_mut(|l| {
            l.sequence_number += 500;
        });

        // All members join; activation happens at ledger ~500
        let seq_before_last_join = s.env.ledger().sequence();
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.join(&s.carol);
        s.circle.join(&s.dave);

        let active_round = s.circle.get_current_round();
        assert_eq!(
            active_round.deadline_ledger,
            seq_before_last_join as u64 + ROUND_DEADLINE as u64,
            "round-0 deadline must be set from the activation ledger, not the init ledger"
        );
        assert!(
            active_round.deadline_ledger > deadline_at_init,
            "activation deadline must be later than the initial deadline set at init time"
        );
    }

    /// Contribute before all members have joined must fail with "circle is not
    /// active" — the active-transition gate protects the contribution path.
    #[test]
    #[should_panic]
    fn test_553_contribute_blocked_until_all_members_joined() {
        let s = setup();
        // Only 3 of 4 members join
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.join(&s.carol);
        assert_eq!(s.circle.get_status(), CircleStatus::Pending);

        // Contribution attempt on a Pending circle must be rejected
        s.circle.contribute(&s.alice);
    }

    /// Payout before all members have joined must fail with "circle is not active".
    #[test]
    #[should_panic]
    fn test_553_payout_blocked_until_all_members_joined() {
        let s = setup();
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.payout();
    }

    /// mark_default before all members have joined must fail with "circle is not
    /// active" — the active-transition gate protects the default path.
    #[test]
    #[should_panic]
    fn test_553_mark_default_blocked_until_all_members_joined() {
        let s = setup();
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.advance_past_deadline();
        s.circle.mark_default(&s.carol);
    }

    /// The `circle/active` event must be emitted exactly once — when the last
    /// member joins — and not at any earlier join.
    #[test]
    fn test_553_active_event_emitted_exactly_once_on_last_join() {
        let s = setup();

        // Helper to count `active` events
        let count_active = |env: &Env| -> usize {
            let target = soroban_sdk::Symbol::new(env, "active");
            let tv: soroban_sdk::Val =
                soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&target, env);
            let bits = soroban_sdk::Val::get_payload(tv);
            env.events()
                .all()
                .into_iter()
                .filter(|(_, topics, _)| {
                    topics.get(1)
                        .map(|v| soroban_sdk::Val::get_payload(v) == bits)
                        .unwrap_or(false)
                })
                .count()
        };

        s.circle.join(&s.alice);
        assert_eq!(count_active(&s.env), 0, "no active event after 1st join");

        s.circle.join(&s.bob);
        assert_eq!(count_active(&s.env), 0, "no active event after 2nd join");

        s.circle.join(&s.carol);
        assert_eq!(count_active(&s.env), 0, "no active event after 3rd join");

        s.circle.join(&s.dave); // activating join
        assert_eq!(count_active(&s.env), 1,
            "exactly one active event must be emitted on the final join");
    }

    /// Once `Active`, any additional `join` attempt (even by a listed member)
    /// must be rejected by the status gate with "circle not accepting members".
    #[test]
    #[should_panic]
    fn test_553_join_after_active_rejected_by_status_gate() {
        let s = setup();
        s.activate();
        assert_eq!(s.circle.get_status(), CircleStatus::Active);
        // Even alice (who already joined) triggers the status gate
        s.circle.join(&s.alice);
    }

    /// The join-order counter is derived from Collateral key presence, not from
    /// a separately maintained mutable counter. Four members joining in any order
    /// must each have a 1-based order in [1, 4].
    #[test]
    fn test_553_join_order_derived_from_collateral_key_count() {
        let s = setup();

        // Join in reverse declaration order to verify counting is independent of order
        s.circle.join(&s.dave);
        s.circle.join(&s.carol);
        s.circle.join(&s.bob);

        assert_eq!(s.circle.get_status(), CircleStatus::Pending,
            "status must be Pending after 3 joins");

        s.circle.join(&s.alice); // 4th join — triggers Active
        assert_eq!(s.circle.get_status(), CircleStatus::Active,
            "4th join (in any order) must trigger Active transition");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #554 — Ensure contribute rejects late or out-of-order round actions
    //
    // `contribute` is guarded by the centralized `deadline_passed` predicate:
    //   - `env.ledger().sequence() > round.deadline_ledger` (strict greater-than)
    //   - The deadline is per-round; each new round refreshes `deadline_ledger`.
    //   - The contribution key is `Contributed(member, CurrentRound.round_index)`,
    //     so members always contribute to the current round — there is no
    //     caller-supplied round index that could be forged.
    //
    // Acceptance criteria:
    //   • Contribution at the exact deadline ledger is accepted (inclusive boundary).
    //   • Contribution one ledger past the deadline is rejected.
    //   • Contribution for a "future" round index cannot be manufactured via the
    //     public API — the round index always comes from CurrentRound.
    //   • Contribution for a "past" round (already paid out) is not possible
    //     because CurrentRound.round_index has advanced.
    //   • A member who already contributed cannot contribute again in the same round.
    // ══════════════════════════════════════════════════════════════════════════

    /// Contribution exactly at the deadline ledger (sequence == deadline_ledger)
    /// must be accepted — the boundary is inclusive for contributions.
    #[test]
    fn test_554_contribution_at_exact_deadline_is_accepted() {
        let s = setup();
        s.activate();

        let round = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32;
        });

        // Must not panic
        s.circle.contribute(&s.alice);
        assert!(s.has_contributed_key(&s.alice, 0),
            "Contributed key must exist after on-time contribution at exact deadline");
    }

    /// Contribution one ledger past the deadline must be rejected with the
    /// canonical "round deadline passed" message.
    #[test]
    #[should_panic]
    fn test_554_contribution_one_ledger_past_deadline_panics() {
        let s = setup();
        s.activate();

        let round = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });

        s.circle.contribute(&s.alice);
    }

    /// Late contribution is rejected even when only some members have contributed
    /// (the pot is incomplete and no payout has run). The deadline gate is
    /// independent of the contribution count.
    #[test]
    #[should_panic]
    fn test_554_late_contribution_rejected_before_payout_runs() {
        let s = setup();
        s.activate();

        // Alice contributes on time
        s.circle.contribute(&s.alice);

        // Advance past the deadline before others contribute
        s.advance_past_deadline();

        // Bob's late contribution must be rejected even though payout has not run
        s.circle.contribute(&s.bob);
    }

    /// Contributions always target `CurrentRound.round_index`. After a payout
    /// advances the round, the new round has a fresh index and a fresh deadline;
    /// contributing for the new round is valid. This verifies no "out-of-order"
    /// carry-over from a prior round affects the contribution path.
    #[test]
    fn test_554_contribution_for_new_round_after_payout_uses_fresh_round_index() {
        let s = setup();
        s.activate();

        // Complete round 0
        s.complete_round();

        // Now in round 1 — Alice has NOT contributed to round 1 yet
        let round1 = s.circle.get_current_round();
        assert_eq!(round1.round_index, 1,
            "pre-condition: must be in round 1 after first payout");
        assert!(!s.has_contributed_key(&s.alice, 1),
            "pre-condition: Alice must not have a round-1 contribution key yet");

        // Contribution for round 1 must succeed
        s.circle.contribute(&s.alice);
        assert!(s.has_contributed_key(&s.alice, 1),
            "Contributed(alice, 1) key must exist after round-1 contribution");
        // Round-0 key must still be present (not overwritten)
        assert!(s.has_contributed_key(&s.alice, 0),
            "Contributed(alice, 0) key must persist after round-1 contribution");
    }

    /// A member cannot contribute twice in the same round — the duplicate
    /// contribution guard fires with "already contributed this round".
    #[test]
    #[should_panic]
    fn test_554_duplicate_contribution_same_round_panics() {
        let s = setup();
        s.activate();
        s.circle.contribute(&s.alice);
        s.circle.contribute(&s.alice); // second contribution same round
    }

    /// A member cannot contribute to a round that has already been paid out.
    /// After payout, CurrentRound advances so the old round index is no longer
    /// the current one; the "already contributed this round" guard fires for the
    /// new round because the member's key for round N is absent.
    /// (Contributing for the new round after payout is valid — this test checks
    /// attempting to re-contribute for the old round is impossible.)
    #[test]
    #[should_panic]
    fn test_554_cannot_contribute_twice_in_same_round_even_after_other_members_contribute() {
        let s = setup();
        s.activate();

        // Alice contributes first
        s.circle.contribute(&s.alice);
        // Others contribute too
        s.circle.contribute(&s.bob);
        s.circle.contribute(&s.carol);
        s.circle.contribute(&s.dave);

        // Alice tries to contribute again before payout runs
        s.circle.contribute(&s.alice);
    }

    /// Non-members are rejected from contributing with "not a member",
    /// providing clear feedback rather than a silent failure.
    #[test]
    #[should_panic]
    fn test_554_contribute_by_non_member_panics_with_clear_message() {
        let s = setup();
        s.activate();
        let outsider = Address::generate(&s.env);
        s.circle.contribute(&outsider);
    }

    /// Contributing on a Pending circle is rejected with "circle is not active"
    /// before the deadline or member-membership checks run.
    #[test]
    #[should_panic]
    fn test_554_contribute_on_pending_circle_rejected_before_member_check() {
        let s = setup();
        // Only partial joins — still Pending
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.contribute(&s.alice);
    }

    /// Deadline boundary for round N is independent of round N-1.
    /// After payout resets the deadline, the prior round's deadline cannot be
    /// used to accept a contribution that is "late" by the new round's clock.
    #[test]
    fn test_554_per_round_deadline_is_independent_of_prior_round_deadline() {
        let s = setup();
        s.activate();

        // Advance to just before round-0 deadline
        let round0 = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round0.deadline_ledger as u32 - 1;
        });

        // Complete round 0 at this ledger; payout resets the deadline for round 1
        s.contribute_all();
        s.circle.payout();

        // Round 1's deadline is NOW + ROUND_DEADLINE, computed from payout ledger
        let round1 = s.circle.get_current_round();
        assert_eq!(round1.round_index, 1);
        // We are at ledger round0.deadline_ledger - 1 after payout;
        // round1.deadline_ledger should be (round0.deadline_ledger - 1) + ROUND_DEADLINE
        let expected_round1_deadline =
            (round0.deadline_ledger - 1) + ROUND_DEADLINE as u64;
        assert_eq!(round1.deadline_ledger, expected_round1_deadline,
            "round-1 deadline must be anchored to the payout ledger, independent of round-0 deadline");

        // Contributing to round 1 right now (well before deadline) must succeed
        s.circle.contribute(&s.alice);
        assert!(s.has_contributed_key(&s.alice, 1));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #555 — Improve mark_default to only flag current-round misses
    //
    // `mark_default` uses `CurrentRound.round_index` (not a caller-supplied index)
    // for both the `Contributed` lookup and the `Defaulted` idempotency key.
    // This means:
    //   • A member can only be flagged for the round currently in progress.
    //   • Flagging for a prior paid-out round is structurally impossible because
    //     CurrentRound has advanced.
    //   • Flagging for a future round is impossible for the same reason.
    //   • The idempotency guard (`Defaulted(member, round_index)`) fires if the
    //     same member is flagged twice for the same current round.
    //
    // Acceptance criteria:
    //   • `mark_default` only creates a `Defaulted(member, CURRENT_round_index)` key.
    //   • Cross-round isolation: default keys for previous rounds are not mutated.
    //   • Double-flagging the same member in the same round is rejected.
    //   • A member who contributed in the current round cannot be flagged.
    //   • Defaults accumulate correctly across rounds (each round is independent).
    //   • Default counter and collateral penalty are applied per-round without
    //     leaking across rounds.
    // ══════════════════════════════════════════════════════════════════════════

    /// `mark_default` writes a `Defaulted(member, current_round_index)` key.
    /// After calling mark_default for round 0, the round-0 key exists but
    /// round-1 and round-2 keys must be absent.
    #[test]
    fn test_555_defaulted_key_only_written_for_current_round() {
        let s = setup();
        s.activate();
        s.advance_past_deadline();

        s.circle.mark_default(&s.carol);

        // Round-0 key must exist
        assert!(s.has_defaulted_key(&s.carol, 0),
            "Defaulted(carol, 0) key must exist after mark_default in round 0");

        // Keys for other rounds must NOT exist
        assert!(!s.has_defaulted_key(&s.carol, 1),
            "Defaulted(carol, 1) must not exist — not in round 1 yet");
        assert!(!s.has_defaulted_key(&s.carol, 2),
            "Defaulted(carol, 2) must not exist — not in round 2 yet");
        assert!(!s.has_defaulted_key(&s.carol, 99),
            "Defaulted(carol, 99) must not exist — round 99 never started");
    }

    /// After payout advances to round 1, mark_default writes a `Defaulted` key
    /// for round 1 — not round 0. The round-0 key must remain absent (carol was
    /// not defaulted in round 0 in this scenario).
    #[test]
    fn test_555_mark_default_uses_current_round_index_after_payout() {
        let s = setup();
        s.activate();

        // Complete round 0 with all members contributing (no defaults)
        s.complete_round();

        // Now in round 1 — advance past its deadline
        let round1 = s.circle.get_current_round();
        assert_eq!(round1.round_index, 1);
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round1.deadline_ledger as u32 + 1;
        });

        // Carol did not contribute in round 1 — mark her default
        s.circle.mark_default(&s.carol);

        // Only the round-1 key must exist; round-0 key must be absent
        assert!(s.has_defaulted_key(&s.carol, 1),
            "Defaulted(carol, 1) key must exist after mark_default in round 1");
        assert!(!s.has_defaulted_key(&s.carol, 0),
            "Defaulted(carol, 0) must not exist — carol was not defaulted in round 0");
    }

    /// Double-flagging the same member in the same round must panic with
    /// "already marked default this round".
    #[test]
    #[should_panic]
    fn test_555_double_default_same_round_panics() {
        let s = setup();
        s.activate();
        s.advance_past_deadline();

        s.circle.mark_default(&s.carol);
        s.circle.mark_default(&s.carol); // second flag same round — must panic
    }

    /// A member who contributed in the current round cannot be flagged as
    /// defaulted — "member did contribute" fires before any state mutation.
    #[test]
    #[should_panic]
    fn test_555_contributor_cannot_be_marked_default() {
        let s = setup();
        s.activate();
        s.circle.contribute(&s.carol);
        s.advance_past_deadline();

        s.circle.mark_default(&s.carol);
    }

    /// Defaults in round 0 and round 1 are independent — the default counter
    /// increments correctly across rounds and the `Defaulted` keys are distinct.
    #[test]
    fn test_555_defaults_accumulate_independently_per_round() {
        let s = setup();
        s.activate();

        // Round 0: carol defaults
        s.advance_past_deadline();
        s.circle.mark_default(&s.carol);

        let collateral_after_round0 = s.circle.get_collateral(&s.carol);
        assert_eq!(s.circle.get_defaults(&s.carol), 1,
            "default count must be 1 after first default");

        // Complete round 0: others contribute + payout (carol already penalized)
        s.circle.contribute(&s.alice);
        s.circle.contribute(&s.bob);
        s.circle.contribute(&s.carol); // carol can still contribute even after default
        s.circle.contribute(&s.dave);
        s.circle.payout();

        // Round 1: carol defaults again
        let round1 = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round1.deadline_ledger as u32 + 1;
        });
        s.circle.mark_default(&s.carol);

        let collateral_after_round1 = s.circle.get_collateral(&s.carol);
        assert_eq!(s.circle.get_defaults(&s.carol), 2,
            "default count must be 2 after second default");

        // Second penalty is 20% of post-round-0 balance, not original balance
        let expected_penalty_r1 = collateral_after_round0 * PENALTY_BPS / BPS_DENOM;
        assert_eq!(
            collateral_after_round0 - collateral_after_round1,
            expected_penalty_r1,
            "round-1 penalty must be 20% of remaining balance after round-0 penalty"
        );

        // Both Defaulted keys must exist and be independent
        assert!(s.has_defaulted_key(&s.carol, 0),
            "Defaulted(carol, 0) must persist after round-1 default");
        assert!(s.has_defaulted_key(&s.carol, 1),
            "Defaulted(carol, 1) must exist after round-1 default");
    }

    /// The `Contributed` and `Defaulted` keys for the same member and same round
    /// are mutually exclusive. If a member contributed, no Defaulted key exists;
    /// if a member defaulted, no Contributed key exists.
    #[test]
    fn test_555_contributed_and_defaulted_keys_are_mutually_exclusive() {
        let s = setup();
        s.activate();

        s.circle.contribute(&s.alice); // alice contributes on time
        s.advance_past_deadline();

        s.circle.mark_default(&s.carol); // carol misses deadline

        // Alice: Contributed key present, Defaulted key absent
        assert!(s.has_contributed_key(&s.alice, 0),
            "alice must have a Contributed key for round 0");
        assert!(!s.has_defaulted_key(&s.alice, 0),
            "alice must not have a Defaulted key for round 0 (she contributed)");

        // Carol: Defaulted key present, Contributed key absent
        assert!(s.has_defaulted_key(&s.carol, 0),
            "carol must have a Defaulted key for round 0");
        assert!(!s.has_contributed_key(&s.carol, 0),
            "carol must not have a Contributed key for round 0 (she defaulted)");
    }

    /// mark_default before the round deadline is rejected with
    /// "round deadline not yet passed" — the deadline must have strictly passed
    /// before a default can be recorded.
    #[test]
    #[should_panic]
    fn test_555_mark_default_before_deadline_panics() {
        let s = setup();
        s.activate();
        // Deadline has not passed yet
        s.circle.mark_default(&s.carol);
    }

    /// mark_default at exactly the deadline ledger is also rejected — the
    /// boundary is strict: `sequence > deadline_ledger`, not `>=`.
    #[test]
    #[should_panic]
    fn test_555_mark_default_at_exact_deadline_panics() {
        let s = setup();
        s.activate();

        let round = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32; // exactly at deadline
        });

        s.circle.mark_default(&s.carol);
    }

    /// mark_default at deadline + 1 succeeds — the first ledger strictly past
    /// the deadline is the earliest moment a default can be recorded.
    #[test]
    fn test_555_mark_default_at_deadline_plus_one_succeeds() {
        let s = setup();
        s.activate();

        let round = s.circle.get_current_round();
        s.env.ledger().with_mut(|l| {
            l.sequence_number = round.deadline_ledger as u32 + 1;
        });

        s.circle.mark_default(&s.carol);
        assert_eq!(s.circle.get_defaults(&s.carol), 1,
            "carol's default count must be 1 after mark_default at deadline+1");
        assert!(s.has_defaulted_key(&s.carol, 0));
    }

    /// A member who has not joined (no Collateral key) cannot be marked default.
    /// The guard "member has not joined" fires before any state mutation.
    #[test]
    #[should_panic]
    fn test_555_unjoined_member_cannot_be_defaulted() {
        let s = setup();

        // Only alice, bob, carol join — dave does NOT join
        s.circle.join(&s.alice);
        s.circle.join(&s.bob);
        s.circle.join(&s.carol);

        // Dave has no Collateral key — should not be defaultable
        // But the circle is still Pending so the status gate fires first.
        // To test the collateral guard, force the circle to Active state and
        // manually set the deadline past.
        s.env.as_contract(&s.circle_id, || {
            s.env.storage().instance().set(&DataKey::Status, &CircleStatus::Active);
            let mut round: crate::RoundState = s.env.storage().instance()
                .get(&DataKey::CurrentRound).unwrap();
            round.deadline_ledger = s.env.ledger().sequence() as u64 - 1;
            s.env.storage().instance().set(&DataKey::CurrentRound, &round);
        });

        // Dave is a listed member but has 0 collateral (no Collateral key)
        // The "member has not joined" guard must fire
        s.circle.mark_default(&s.dave);
    }

    /// Collateral penalty from mark_default is exactly 20% of the current
    /// balance (not a fixed amount), ensuring repeated defaults compound correctly.
    #[test]
    fn test_555_penalty_is_percentage_of_current_balance_not_fixed() {
        let s = setup();
        s.activate();
        s.advance_past_deadline();

        let initial = s.circle.get_collateral(&s.carol);
        let expected_penalty = initial * PENALTY_BPS / BPS_DENOM;
        let expected_remaining = initial - expected_penalty;

        s.circle.mark_default(&s.carol);

        assert_eq!(s.circle.get_collateral(&s.carol), expected_remaining,
            "collateral after default must be initial - (initial * PENALTY_BPS / BPS_DENOM)");
        assert_eq!(initial - s.circle.get_collateral(&s.carol), expected_penalty,
            "penalty deducted must equal initial * PENALTY_BPS / BPS_DENOM");
    }
}
////! Reputation contract — tracks completed-rounds score per wallet address.
//!
//! # Authorization model
//!
//! `increment` may only be called by an **authorized circle contract** — not
//! by the member whose score is being updated.  This prevents any wallet from
//! self-awarding reputation points outside of a legitimate ROSCA payout.
//!
//! The factory registers each newly deployed circle by calling
//! `add_authorized_caller` (admin-only).  The factory itself is set as `admin`
//! during `initialize`.
//!
//! ```text
//!   factory.create_circle()
//!     └─► reputation.add_authorized_caller(circle_address)   [admin = factory]
//!         └─► circle.payout()
//!               └─► reputation.increment(member)             [caller = circle]
//! ```
//!
//! # Authorization invariants
//!
//! The allowlist is the trust boundary for every point ever awarded, so the
//! following hold in **every** state this contract can reach:
//!
//! 1. **Admin-only management** — only the address stored under
//!    [`DataKey::Admin`] can register or revoke a caller.
//! 2. **Uniqueness** — [`DataKey::AuthorizedCallers`] holds each address at
//!    most once.  `add_authorized_caller` is idempotent and
//!    `remove_authorized_caller` filters out *every* matching entry, so no
//!    sequence of admin calls can leave a duplicate behind.
//! 3. **Revocation is permanent** — a revoked address is recorded in
//!    [`DataKey::RevokedCallers`] and can never be authorized again on this
//!    contract instance; re-registration fails with
//!    [`ReputationError::CallerRevoked`].
//! 4. **Revocation outranks the allowlist** — `increment` rejects a revoked
//!    address *before* it consults the allowlist, so a stale entry left by a
//!    partially applied factory reconfiguration cannot resurrect a revoked
//!    circle's ability to award points.
//! 5. **Scores are monotonic** — `increment` is the only writer of
//!    [`DataKey::Score`] and only ever adds 1.  There is no decrement or reset
//!    entry point, so revoking a circle freezes the points it awarded instead
//!    of rewriting history.
//!
//! Both caller lists live in instance storage, so their TTL is bound to the
//! contract instance itself and a revocation cannot lapse the way an expiring
//! persistent entry could.
//!
//! # Events
//!
//! All events use the two-symbol topic prefix `("reputation", <event_name>)` so
//! the indexer can filter with `topic0 == "reputation"`.
//!
//! Every authorization transition emits exactly one event, and a call that
//! changes nothing (re-registering an already-authorized circle) emits none, so
//! an off-chain replay of these events reproduces the on-chain allowlist
//! exactly.  Storage stays the source of truth regardless: the current state is
//! also readable directly via `get_authorized_callers` and
//! `get_revoked_callers`.
//!
//! ## `reputation` / `score_updated`
//!
//! Emitted after every successful `increment` call.
//!
//! | Part | Shape | Meaning |
//! |------|-------|---------|
//! | **Topics** | `(Symbol("reputation"), Symbol("score_updated"))` | Stable filter keys |
//! | **Data** | `(Address, u32)` | `(member, new_total_score)` |
//!
//! ## `reputation` / `caller_added`
//!
//! Emitted when admin registers a caller that was not already authorized.
//!
//! | **Data** | `Address` | The newly authorized circle contract address |
//!
//! ## `reputation` / `caller_removed`
//!
//! Emitted when admin revokes an authorized caller.  Revocation is permanent,
//! so at most one of these is emitted per address.
//!
//! | **Data** | `Address` | The revoked circle contract address |

#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Symbol, Vec};

// ─── Events ───────────────────────────────────────────────────────────────────

/// Topic-0 namespace shared by every event this contract publishes.
///
/// Mirrors `circle::EVENT_NAMESPACE`: topics are `(EVENT_NAMESPACE, <name>)`.
pub const EVENT_NAMESPACE: &str = "reputation";

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    /// Completed-rounds score for a wallet.
    Score(Address),
    /// Admin address — the only address allowed to manage authorized callers.
    /// Set once at `initialize` time; typically the factory contract.
    Admin,
    /// Vec<Address> of circle contracts permitted to call `increment`.
    AuthorizedCallers,
    /// Vec<Address> of circle contracts permanently barred from calling
    /// `increment`.  Append-only: entries are written by
    /// `remove_authorized_caller` and never cleared.
    RevokedCallers,
    /// Reentrancy guard held for the duration of `initialize`.
    ///
    /// Set as the very first storage write in `initialize` and cleared once
    /// all setup fully commits.  If a reentrant call lands mid-initialize
    /// (e.g. a future cross-contract call is added here) the flag is already
    /// present and the call panics immediately, before any partial state is
    /// visible to the reentrant path.  The `Admin` key absence alone is not a
    /// safe guard because a reentrant call would also see `Admin` absent.
    Initializing,
}

// ─── Contract errors ──────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ReputationError {
    /// `increment` was called by an address that is revoked, or that is not in
    /// `AuthorizedCallers`.
    UnauthorizedCaller = 1,
    /// `add_authorized_caller` or `remove_authorized_caller` was called by a
    /// non-admin address.
    NotAdmin = 2,
    /// `remove_authorized_caller` was asked to remove an address that is not
    /// currently in the authorized list.
    CallerNotFound = 3,
    /// A mutating entry-point was called before `initialize`.
    NotInitialized = 4,
    /// `add_authorized_caller` was asked to re-register an address that has
    /// already been revoked.  Revocation cannot be undone.
    CallerRevoked = 5,
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Current allowlist, or an empty list if none has been stored yet.
fn authorized_callers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::AuthorizedCallers)
        .unwrap_or_else(|| Vec::new(env))
}

/// Addresses that have been permanently revoked.
fn revoked_callers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::RevokedCallers)
        .unwrap_or_else(|| Vec::new(env))
}

/// Assert that `caller` signed this invocation **and** is the stored admin.
///
/// Both allowlist mutations go through here so the two paths cannot drift apart
/// on who is allowed to move the trust boundary.
fn require_admin(env: &Env, caller: &Address) -> Result<(), ReputationError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ReputationError::NotInitialized)?;

    caller.require_auth();
    if *caller != admin {
        return Err(ReputationError::NotAdmin);
    }

    Ok(())
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    // ── Initialization ────────────────────────────────────────────────────────

    /// Called once by the deployer.
    ///
    /// `admin` is the only address permitted to register or revoke authorized
    /// callers via `add_authorized_caller` / `remove_authorized_caller`.  In
    /// the standard CircleUp deployment the factory contract is passed as admin
    /// so it can register each circle it deploys.
    ///
    /// # Reentrancy guard
    ///
    /// Sets `DataKey::Initializing` as the very first storage write and clears
    /// it once all setup commits.  This prevents a reentrant call from racing
    /// through a second initialize mid-flight and observing a partially
    /// initialized state.  The `Admin` key absence alone is not a sufficient
    /// guard because a reentrant call would also see `Admin` absent.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }

        // Reentrancy guard: set the Initializing flag before any other write.
        // A reentrant call arriving mid-initialize (e.g. if a future change
        // introduces a cross-contract call here) sees this flag and panics
        // immediately, preventing partial state from being observed or committed.
        if env.storage().instance().has(&DataKey::Initializing) {
            panic!("initialize already in progress");
        }
        env.storage().instance().set(&DataKey::Initializing, &true);

        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);

        let empty: Vec<Address> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &empty);
        env.storage()
            .instance()
            .set(&DataKey::RevokedCallers, &empty);

        // Clear the reentrancy guard once all setup commits successfully.
        env.storage().instance().remove(&DataKey::Initializing);
    }

    // ── Authorized-caller management ──────────────────────────────────────────

    /// Register `circle` as a contract that may call `increment`.
    ///
    /// Only the admin (typically the factory) may call this.  The call is
    /// idempotent: re-registering an already-authorized circle succeeds without
    /// appending a duplicate entry and without emitting a second event.
    ///
    /// # Errors
    /// - [`ReputationError::NotInitialized`] — called before `initialize`.
    /// - [`ReputationError::NotAdmin`] — caller is not the admin.
    /// - [`ReputationError::CallerRevoked`] — `circle` was previously revoked.
    pub fn add_authorized_caller(
        env: Env,
        caller: Address,
        circle: Address,
    ) -> Result<(), ReputationError> {
        require_admin(&env, &caller)?;

        // Revocation is permanent.  Refusing re-registration here is what stops
        // a factory-level reconfiguration or a re-deploy sequence from quietly
        // restoring a circle that was taken out of the trust boundary on
        // purpose.
        if revoked_callers(&env).contains(&circle) {
            return Err(ReputationError::CallerRevoked);
        }

        let mut callers = authorized_callers(&env);
        if callers.contains(&circle) {
            return Ok(());
        }

        callers.push_back(circle.clone());
        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &callers);

        env.events().publish(
            (
                Symbol::new(&env, EVENT_NAMESPACE),
                Symbol::new(&env, "caller_added"),
            ),
            circle,
        );

        Ok(())
    }

    /// Permanently revoke `circle`'s permission to call `increment`.
    ///
    /// Only the admin may call this.  `circle` is dropped from the allowlist
    /// and recorded as revoked; it can never be registered again.
    ///
    /// # Errors
    /// - [`ReputationError::NotInitialized`] — called before `initialize`.
    /// - [`ReputationError::NotAdmin`] — caller is not the admin.
    /// - [`ReputationError::CallerNotFound`] — `circle` was not in the list.
    pub fn remove_authorized_caller(
        env: Env,
        caller: Address,
        circle: Address,
    ) -> Result<(), ReputationError> {
        require_admin(&env, &caller)?;

        // Rebuild the allowlist without `circle`.  Filtering instead of
        // removing a single index means that if the list ever holds the address
        // more than once, one call clears all of them — a partial removal would
        // leave the circle authorized.
        let callers = authorized_callers(&env);
        let mut remaining: Vec<Address> = Vec::new(&env);
        for addr in callers.iter() {
            if addr != circle {
                remaining.push_back(addr);
            }
        }

        if remaining.len() == callers.len() {
            return Err(ReputationError::CallerNotFound);
        }

        env.storage()
            .instance()
            .set(&DataKey::AuthorizedCallers, &remaining);

        // Tombstone the address.  `increment` consults this list first, so the
        // circle stays locked out even if a stale allowlist entry survives.
        let mut revoked = revoked_callers(&env);
        revoked.push_back(circle.clone());
        env.storage()
            .instance()
            .set(&DataKey::RevokedCallers, &revoked);

        env.events().publish(
            (
                Symbol::new(&env, EVENT_NAMESPACE),
                Symbol::new(&env, "caller_removed"),
            ),
            circle,
        );

        Ok(())
    }

    // ── Mutation ──────────────────────────────────────────────────────────────

    /// Increment `member`'s completed-rounds score by 1.
    ///
    /// `circle` must be an address registered via `add_authorized_caller` and
    /// never revoked.  The Soroban host **automatically authorizes**
    /// `circle.require_auth()` when the call originates from the circle
    /// contract itself (Contract Invoker rule), so no external signature is
    /// required in cross-contract calls.  A wallet calling this directly would
    /// have to produce a signature for the circle's address, which it cannot do
    /// — effectively blocking direct calls.
    ///
    /// # Authorization flow
    ///
    /// ```text
    /// circle.payout()
    ///   └─► reputation.increment(circle_address, member)
    ///             ├─► circle.require_auth()  — auto-granted by Soroban host
    ///             ├─► rejects if circle is in RevokedCallers
    ///             └─► requires circle to be in AuthorizedCallers
    /// ```
    ///
    /// # Errors
    /// - [`ReputationError::NotInitialized`] — called before `initialize`.
    /// - [`ReputationError::UnauthorizedCaller`] — `circle` is revoked, or is
    ///   not in the `AuthorizedCallers` list.
    pub fn increment(env: Env, circle: Address, member: Address) -> Result<(), ReputationError> {
        // Verify the contract has been initialized before doing anything else.
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(ReputationError::NotInitialized);
        }

        // Require auth from the circle address.  When called from within a
        // circle contract via a cross-contract call, Soroban's Contract Invoker
        // rule auto-grants this — no external signature needed.  A direct call
        // from a wallet would require the wallet to hold the circle's key,
        // which is impossible in practice.
        circle.require_auth();

        // Revocation is checked first, and independently of the allowlist, so
        // authorization never depends on the allowlist being clean.
        if revoked_callers(&env).contains(&circle) {
            return Err(ReputationError::UnauthorizedCaller);
        }

        if !authorized_callers(&env).contains(&circle) {
            return Err(ReputationError::UnauthorizedCaller);
        }

        // Load current score; default to 0 for first-time members.
        let current: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::Score(member.clone()))
            .unwrap_or(0);

        // `overflow-checks` is on for the release profile, so an overflow traps
        // and aborts the transaction rather than wrapping the score back to 0.
        let new_score = current + 1;

        env.storage()
            .persistent()
            .set(&DataKey::Score(member.clone()), &new_score);

        // Extend TTL so scores survive well beyond the circle's lifetime.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Score(member.clone()), 100_000, 200_000);

        // Emit (member, new_total_score) so indexers and frontends can show
        // both *who* received the point and *what their total score is now*
        // without a separate `score` query.
        env.events().publish(
            (
                Symbol::new(&env, EVENT_NAMESPACE),
                Symbol::new(&env, "score_updated"),
            ),
            (member, new_score),
        );

        Ok(())
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /// Returns the number of completed rounds for `member` (0 if none on record).
    pub fn score(env: Env, member: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Score(member))
            .unwrap_or(0)
    }

    /// Returns the list of currently authorized circle contracts.
    pub fn get_authorized_callers(env: Env) -> Vec<Address> {
        authorized_callers(&env)
    }

    /// Returns the list of permanently revoked circle contracts.
    ///
    /// Exposed so auditors and indexers can read the whole authorization state
    /// straight from storage instead of replaying `caller_added` /
    /// `caller_removed` events to work out which addresses are barred.
    pub fn get_revoked_callers(env: Env) -> Vec<Address> {
        revoked_callers(&env)
    }

    /// Returns the admin address.
    ///
    /// Panics with a clear message if called before `initialize`.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("reputation: get_admin called before initialize"))
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events};
    use soroban_sdk::{Env, FromVal, TryFromVal, Val};

    // ── Fixture ───────────────────────────────────────────────────────────────

    struct Setup<'a> {
        env: Env,
        admin: Address,
        client: ReputationContractClient<'a>,
        contract_id: Address,
    }

    fn setup() -> Setup<'static> {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        Setup {
            env,
            admin,
            client,
            contract_id,
        }
    }

    /// How many times `addr` appears in `list`.
    fn occurrences(list: &Vec<Address>, addr: &Address) -> u32 {
        let mut n = 0;
        for entry in list.iter() {
            if entry == *addr {
                n += 1;
            }
        }
        n
    }

    /// Overwrite the stored allowlist directly, simulating state left behind by
    /// a corrupted migration or a partially applied reconfiguration.  No public
    /// entry point can produce such a list, which is exactly why the defensive
    /// paths have to be reached this way.
    fn force_authorized_callers(s: &Setup, entries: &[&Address]) {
        let mut list: Vec<Address> = Vec::new(&s.env);
        for entry in entries {
            list.push_back((*entry).clone());
        }
        s.env.as_contract(&s.contract_id, || {
            s.env
                .storage()
                .instance()
                .set(&DataKey::AuthorizedCallers, &list);
        });
    }

    /// Force a member's score directly in persistent storage, bypassing the
    /// `increment` entry point.  Used to exercise boundary and overflow cases
    /// that would otherwise require running `increment` u32::MAX times.
    fn force_score(s: &Setup, member: &Address, score: u32) {
        s.env.as_contract(&s.contract_id, || {
            s.env
                .storage()
                .persistent()
                .set(&DataKey::Score(member.clone()), &score);
        });
    }

    /// Data payloads of every emitted event whose second topic is `name`.
    ///
    /// Topic symbols longer than nine characters are host objects rather than
    /// small values, so they have to be converted back to `Symbol` before
    /// comparing — comparing the raw `Val` payloads matches on object handle
    /// and never finds anything.
    fn events_named(env: &Env, name: &str) -> std::vec::Vec<Val> {
        let target = Symbol::new(env, name);
        env.events()
            .all()
            .into_iter()
            .filter(|(_contract, topics, _data)| {
                topics
                    .get(1)
                    .and_then(|topic| Symbol::try_from_val(env, &topic).ok())
                    .map(|topic| topic == target)
                    .unwrap_or(false)
            })
            .map(|(_contract, _topics, data)| data)
            .collect()
    }

    /// The address carried by the single event named `name`.
    fn only_address_event(env: &Env, name: &str) -> Address {
        let events = events_named(env, name);
        assert_eq!(events.len(), 1, "expected exactly one '{}' event", name);
        Address::from_val(env, &events[0])
    }

    // ── initialize ────────────────────────────────────────────────────────────

    #[test]
    fn test_score_starts_at_zero() {
        let s = setup();
        let member = Address::generate(&s.env);
        assert_eq!(s.client.score(&member), 0);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let s = setup();
        s.client.initialize(&s.admin);
    }

    #[test]
    fn test_get_admin_returns_initialized_admin() {
        let s = setup();
        assert_eq!(s.client.get_admin(), s.admin);
    }

    #[test]
    fn test_initialize_starts_with_empty_caller_lists() {
        let s = setup();
        assert_eq!(s.client.get_authorized_callers().len(), 0);
        assert_eq!(s.client.get_revoked_callers().len(), 0);
    }

    // ── initialize: reentrancy guard ──────────────────────────────────────────

    /// The reentrancy guard (DataKey::Initializing) is set before any other
    /// storage write in `initialize`.  Simulating a reentrant call by
    /// pre-setting the flag must cause initialize to panic with
    /// "initialize already in progress" rather than proceeding.
    #[test]
    #[should_panic(expected = "initialize already in progress")]
    fn test_initialize_reentrancy_guard_fires() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);

        // Pre-set the Initializing flag to simulate a reentrant call landing
        // mid-initialize (e.g. from a future cross-contract call added there).
        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });

        // Must panic: Initializing flag already set.
        client.initialize(&Address::generate(&env));
    }

    /// After a reentrancy-guard failure the Admin key must remain absent,
    /// confirming the guard fires before any committed state.
    #[test]
    fn test_initialize_reentrancy_guard_leaves_no_admin_state() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);

        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });

        let result = client.try_initialize(&Address::generate(&env));
        assert!(result.is_err(), "initialize with Initializing flag set must fail");

        // Admin key must not have been written — verify directly via storage.
        let admin_present = env.as_contract(&contract_id, || {
            env.storage().instance().has(&DataKey::Admin)
        });
        assert!(!admin_present, "Admin key must be absent after reentrancy-guard failure");
    }

    /// A reentrancy-guard failure must leave the caller lists absent (not
    /// written as empty vecs), so a retry with a correct admin succeeds cleanly.
    #[test]
    fn test_initialize_reentrancy_guard_allows_retry() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);

        // First attempt: fail via reentrancy guard simulation.
        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::Initializing, &true);
        });
        let bad = client.try_initialize(&Address::generate(&env));
        assert!(bad.is_err(), "first initialize must fail");

        // Clear the simulated flag so a retry can proceed.
        env.as_contract(&contract_id, || {
            env.storage().instance().remove(&DataKey::Initializing);
        });

        // Second attempt with a correct admin must succeed.
        let good_admin = Address::generate(&env);
        client.initialize(&good_admin);
        assert_eq!(client.get_admin(), good_admin, "retry must store the correct admin");
        assert_eq!(client.get_authorized_callers().len(), 0);
        assert_eq!(client.get_revoked_callers().len(), 0);
    }

    // ── initialize: admin immutability ────────────────────────────────────────

    /// The admin stored at initialize time must be exactly the address passed in.
    /// Re-initializing with a different admin must be rejected and leave the
    /// original admin unchanged.
    #[test]
    fn test_admin_immutable_after_initialize() {
        let s = setup();
        let original_admin = s.client.get_admin();

        // Attempt to overwrite with a different admin — must fail.
        let attacker = Address::generate(&s.env);
        let result = s.client.try_initialize(&attacker);
        assert!(result.is_err(), "second initialize must be rejected");

        // Admin must still be the original.
        assert_eq!(
            s.client.get_admin(),
            original_admin,
            "admin must be immutable after initialize"
        );
    }

    /// get_admin before initialize must panic with a clear message.
    #[test]
    #[should_panic(expected = "reputation: get_admin called before initialize")]
    fn test_get_admin_before_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        client.get_admin(); // must panic
    }

    // ── admin-auth: add_authorized_caller ─────────────────────────────────────

    /// Only the stored admin may add an authorized caller.  Any other address
    /// must receive NotAdmin regardless of whether mock_all_auths is active
    /// (the guard checks the stored admin address, not just the signature).
    #[test]
    fn test_add_authorized_caller_requires_stored_admin_identity() {
        let s = setup();
        let circle = Address::generate(&s.env);

        // A brand-new address that has not been set as admin must be rejected.
        let non_admin = Address::generate(&s.env);
        let result = s.client.try_add_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "add_authorized_caller must reject any address that is not the stored admin"
        );

        // The list must remain empty after the rejected call.
        assert_eq!(
            s.client.get_authorized_callers().len(), 0,
            "authorized callers must be empty after rejected add"
        );
    }

    /// A series of different non-admin addresses must all be rejected.
    /// This confirms the check is against the stored admin identity,
    /// not merely the absence of a signature.
    #[test]
    fn test_add_authorized_caller_rejects_multiple_non_admins() {
        let s = setup();
        let circle = Address::generate(&s.env);

        for _ in 0..5 {
            let stranger = Address::generate(&s.env);
            let result = s.client.try_add_authorized_caller(&stranger, &circle);
            assert_eq!(
                result,
                Err(Ok(ReputationError::NotAdmin)),
                "every non-admin address must be rejected by add_authorized_caller"
            );
        }

        assert_eq!(s.client.get_authorized_callers().len(), 0);
    }

    /// add_authorized_caller called before initialize must return NotInitialized
    /// (the require_admin helper checks for Admin key absence first).
    #[test]
    fn test_add_authorized_caller_before_initialize_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let result = client.try_add_authorized_caller(
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotInitialized)),
            "add_authorized_caller before initialize must return NotInitialized"
        );
    }

    // ── admin-auth: remove_authorized_caller ──────────────────────────────────

    /// Only the stored admin may remove an authorized caller.
    #[test]
    fn test_remove_authorized_caller_requires_stored_admin_identity() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);

        let non_admin = Address::generate(&s.env);
        let result = s.client.try_remove_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "remove_authorized_caller must reject any address that is not the stored admin"
        );

        // The circle must remain in the authorized list.
        assert!(
            s.client.get_authorized_callers().contains(&circle),
            "circle must remain authorized after rejected remove"
        );
        // And must not appear in the revoked list.
        assert!(
            !s.client.get_revoked_callers().contains(&circle),
            "circle must not be revoked after a rejected remove"
        );
    }

    /// remove_authorized_caller called before initialize must return NotInitialized.
    #[test]
    fn test_remove_authorized_caller_before_initialize_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let result = client.try_remove_authorized_caller(
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotInitialized)),
            "remove_authorized_caller before initialize must return NotInitialized"
        );
    }

    // ── admin-auth: increment ─────────────────────────────────────────────────

    /// increment called before initialize must return NotInitialized — the
    /// contract must check for Admin key presence before any other logic.
    #[test]
    fn test_increment_before_initialize_returns_not_initialized_detailed() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let result = client.try_increment(
            &Address::generate(&env),
            &Address::generate(&env),
        );
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotInitialized)),
            "increment before initialize must return NotInitialized"
        );
    }

    /// After revocation, the admin is still the stored admin and can still
    /// manage the allowlist for other circles — revocation of one circle
    /// must not affect admin identity or other circles' authorization.
    #[test]
    fn test_admin_auth_unaffected_by_revocation() {
        let s = setup();
        let circle_a = Address::generate(&s.env);
        let circle_b = Address::generate(&s.env);

        s.client.add_authorized_caller(&s.admin, &circle_a);
        s.client.add_authorized_caller(&s.admin, &circle_b);

        // Revoke circle_a
        s.client.remove_authorized_caller(&s.admin, &circle_a);

        // Admin identity must be unchanged.
        assert_eq!(s.client.get_admin(), s.admin, "admin must be unchanged after revocation");

        // Admin must still be able to manage circle_b.
        let new_circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &new_circle);
        assert!(
            s.client.get_authorized_callers().contains(&new_circle),
            "admin must still be able to add new callers after revoking another"
        );

        // circle_a is revoked; circle_b is still authorized.
        assert!(!s.client.get_authorized_callers().contains(&circle_a));
        assert!(s.client.get_authorized_callers().contains(&circle_b));
    }

    // ── initialize: state written atomically ──────────────────────────────────

    /// After a successful initialize the contract must expose all four expected
    /// storage entries: Admin, AuthorizedCallers (empty), RevokedCallers (empty),
    /// and score queries return 0 for any unknown address.
    #[test]
    fn test_initialize_writes_all_expected_state() {
        let s = setup();

        // Admin is the provided address.
        assert_eq!(s.client.get_admin(), s.admin);

        // Both caller lists start empty.
        let authorized = s.client.get_authorized_callers();
        let revoked = s.client.get_revoked_callers();
        assert_eq!(authorized.len(), 0, "AuthorizedCallers must be empty after initialize");
        assert_eq!(revoked.len(), 0, "RevokedCallers must be empty after initialize");

        // Any member score query returns 0.
        let unknown = Address::generate(&s.env);
        assert_eq!(s.client.score(&unknown), 0, "score for unknown member must be 0");
    }

    /// The admin address is stored exactly as passed — not hashed, normalized,
    /// or transformed.  Verifying identity with `==` must succeed.
    #[test]
    fn test_initialize_stores_admin_address_verbatim() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(
            client.get_admin(),
            admin,
            "stored admin must be byte-identical to the address passed to initialize"
        );
    }

    // ── add_authorized_caller ─────────────────────────────────────────────────

    #[test]
    fn test_add_authorized_caller_by_admin_succeeds() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        assert!(s.client.get_authorized_callers().contains(&circle));
    }

    /// Re-registering the same circle must leave the allowlist unique.
    #[test]
    fn test_add_authorized_caller_is_idempotent() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.add_authorized_caller(&s.admin, &circle);
        let callers = s.client.get_authorized_callers();
        assert_eq!(occurrences(&callers, &circle), 1);
        assert_eq!(callers.len(), 1);
    }

    #[test]
    fn test_add_authorized_caller_non_admin_returns_not_admin_error() {
        let s = setup();
        let non_admin = Address::generate(&s.env);
        let circle = Address::generate(&s.env);
        let result = s.client.try_add_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "non-admin must receive NotAdmin error"
        );
        assert_eq!(s.client.get_authorized_callers().len(), 0);
    }

    // ── remove_authorized_caller ──────────────────────────────────────────────

    #[test]
    fn test_remove_authorized_caller_by_admin_succeeds() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);
        assert!(!s.client.get_authorized_callers().contains(&circle));
        assert!(s.client.get_revoked_callers().contains(&circle));
    }

    #[test]
    fn test_remove_authorized_caller_not_found_returns_error() {
        let s = setup();
        let circle = Address::generate(&s.env);
        let result = s.client.try_remove_authorized_caller(&s.admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::CallerNotFound)),
            "removing unknown caller must return CallerNotFound"
        );
        assert_eq!(
            s.client.get_revoked_callers().len(),
            0,
            "a failed removal must not tombstone anything"
        );
    }

    #[test]
    fn test_remove_authorized_caller_non_admin_returns_not_admin_error() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        let non_admin = Address::generate(&s.env);
        let result = s.client.try_remove_authorized_caller(&non_admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotAdmin)),
            "non-admin must receive NotAdmin error on remove"
        );
        assert!(
            s.client.get_authorized_callers().contains(&circle),
            "a rejected removal must leave the allowlist untouched"
        );
    }

    /// One removal must clear every copy of the address, so a list corrupted
    /// with duplicates cannot leave the circle partially authorized.
    #[test]
    fn test_remove_clears_every_duplicate_allowlist_entry() {
        let s = setup();
        let circle = Address::generate(&s.env);
        let other = Address::generate(&s.env);
        force_authorized_callers(&s, &[&circle, &other, &circle]);

        s.client.remove_authorized_caller(&s.admin, &circle);

        let callers = s.client.get_authorized_callers();
        assert_eq!(occurrences(&callers, &circle), 0);
        assert_eq!(
            occurrences(&callers, &other),
            1,
            "removal must not disturb other entries"
        );
    }

    // ── revocation is permanent ───────────────────────────────────────────────

    #[test]
    fn test_revoked_caller_cannot_increment() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);

        s.client.remove_authorized_caller(&s.admin, &s.contract_id);

        let result = s.client.try_increment(&s.contract_id, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::UnauthorizedCaller)),
            "a revoked circle must not be able to award points"
        );
        assert_eq!(
            s.client.score(&member),
            1,
            "revocation freezes the score, it does not rewrite it"
        );
    }

    #[test]
    fn test_revoked_caller_cannot_be_re_added() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);

        let result = s.client.try_add_authorized_caller(&s.admin, &circle);
        assert_eq!(
            result,
            Err(Ok(ReputationError::CallerRevoked)),
            "revocation must be irreversible"
        );
        assert!(!s.client.get_authorized_callers().contains(&circle));
    }

    // ── Monotonicity: overflow and boundary ───────────────────────────────────

    /// Score can grow up to u32::MAX without unexpected clamping or wrapping.
    /// This verifies the happy path right at the boundary: MAX - 1 → MAX.
    #[test]
    fn test_score_at_u32_max_minus_one_increments_to_max() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        force_score(&s, &member, u32::MAX - 1);
        s.client.increment(&s.contract_id, &member);
        assert_eq!(
            s.client.score(&member),
            u32::MAX,
            "score must be able to reach u32::MAX without wrapping or clamping"
        );
    }

    /// Incrementing from u32::MAX must trap rather than silently wrap back to 0.
    /// The release profile sets overflow-checks = true; in the test environment
    /// Rust's debug overflow checks also fire, so this panic is deterministic.
    #[test]
    fn test_score_overflow_at_u32_max_traps() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        force_score(&s, &member, u32::MAX);
        // The increment must fail (overflow trap) rather than wrap to 0.
        let result = s.client.try_increment(&s.contract_id, &member);
        assert!(
            result.is_err(),
            "score must not silently wrap past u32::MAX — the operation must trap"
        );
        // The failed call must leave the score unchanged at u32::MAX.
        assert_eq!(
            s.client.score(&member),
            u32::MAX,
            "score must remain at u32::MAX after the failed increment"
        );
    }

    /// One authorized `increment` call creates exactly one score point.
    /// This pin-tests the "one qualifying circle completion = one defined increment"
    /// requirement from Issue 89.
    #[test]
    fn test_one_authorized_completion_adds_exactly_one_point() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        let before = s.client.score(&member);
        s.client.increment(&s.contract_id, &member);
        let after = s.client.score(&member);
        assert_eq!(
            after,
            before + 1,
            "one authorized increment must add exactly one point"
        );
    }

    /// Score for a member with no recorded history must be zero — not an error,
    /// not None, not a missing-key panic.  The contract must return 0 for any
    /// unknown address.
    #[test]
    fn test_unknown_member_score_is_deterministically_zero() {
        let s = setup();
        let unknown = Address::generate(&s.env);
        assert_eq!(
            s.client.score(&unknown),
            0,
            "score for an address with no history must be deterministically 0"
        );
    }

    /// The core stale-permission case: even if the allowlist is corrupted so
    /// that a revoked circle appears in it again — twice, at that — `increment`
    /// must still refuse, because revocation is checked independently.
    #[test]
    fn test_stale_allowlist_entry_cannot_resurrect_revoked_caller() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.remove_authorized_caller(&s.admin, &s.contract_id);

        force_authorized_callers(&s, &[&s.contract_id, &s.contract_id]);

        let result = s.client.try_increment(&s.contract_id, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::UnauthorizedCaller)),
            "a stale allowlist entry must not re-authorize a revoked circle"
        );
        assert_eq!(s.client.score(&member), 0);
    }

    /// Repeated admin churn must not accumulate duplicates or reopen access.
    #[test]
    fn test_repeated_admin_updates_keep_lists_consistent() {
        let s = setup();
        let kept = Address::generate(&s.env);
        let revoked = Address::generate(&s.env);

        s.client.add_authorized_caller(&s.admin, &kept);
        s.client.add_authorized_caller(&s.admin, &revoked);
        s.client.remove_authorized_caller(&s.admin, &revoked);

        // Three further attempts to bring the revoked circle back.
        for _ in 0..3 {
            assert_eq!(
                s.client.try_add_authorized_caller(&s.admin, &revoked),
                Err(Ok(ReputationError::CallerRevoked))
            );
            s.client.add_authorized_caller(&s.admin, &kept);
        }

        let callers = s.client.get_authorized_callers();
        assert_eq!(callers.len(), 1, "allowlist must hold only the kept circle");
        assert_eq!(occurrences(&callers, &kept), 1);
        assert_eq!(occurrences(&s.client.get_revoked_callers(), &revoked), 1);
    }

    // ── increment: authorization ──────────────────────────────────────────────

    #[test]
    fn test_increment_by_unauthorized_caller_returns_error() {
        let s = setup();
        let member = Address::generate(&s.env);
        let unregistered_circle = Address::generate(&s.env);
        // No circle registered — increment must be rejected.
        let result = s.client.try_increment(&unregistered_circle, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::UnauthorizedCaller)),
            "unregistered caller must receive UnauthorizedCaller error"
        );
    }

    #[test]
    fn test_increment_by_authorized_caller_succeeds() {
        let s = setup();
        let member = Address::generate(&s.env);
        // Register the reputation contract itself as an authorized caller
        // so we can exercise the happy path from within the test environment.
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);
        assert_eq!(s.client.score(&member), 1);
    }

    #[test]
    fn test_increment_multiple_times() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);
        s.client.increment(&s.contract_id, &member);
        s.client.increment(&s.contract_id, &member);
        assert_eq!(s.client.score(&member), 3);
    }

    #[test]
    fn test_independent_scores_across_members() {
        let s = setup();
        let alice = Address::generate(&s.env);
        let bob = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &alice);
        s.client.increment(&s.contract_id, &alice);
        s.client.increment(&s.contract_id, &bob);
        assert_eq!(s.client.score(&alice), 2);
        assert_eq!(s.client.score(&bob), 1);
    }

    /// Every accepted increment adds exactly one, and every rejected one adds
    /// nothing — the score only ever moves up, and only for a valid circle.
    #[test]
    fn test_score_is_monotonic_and_only_moves_for_valid_circles() {
        let s = setup();
        let member = Address::generate(&s.env);
        let impostor = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);

        let mut expected = 0u32;
        for _ in 0..5 {
            assert_eq!(
                s.client.try_increment(&impostor, &member),
                Err(Ok(ReputationError::UnauthorizedCaller))
            );
            assert_eq!(s.client.score(&member), expected);

            s.client.increment(&s.contract_id, &member);
            expected += 1;
            assert_eq!(s.client.score(&member), expected);
        }
    }

    #[test]
    fn test_increment_before_initialize_returns_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationContract);
        let client = ReputationContractClient::new(&env, &contract_id);
        let circle = Address::generate(&env);
        let member = Address::generate(&env);
        let result = client.try_increment(&circle, &member);
        assert_eq!(
            result,
            Err(Ok(ReputationError::NotInitialized)),
            "increment before initialize must return NotInitialized"
        );
    }

    // ── event semantics ───────────────────────────────────────────────────────

    #[test]
    fn test_score_updated_event_carries_member_and_new_total() {
        let s = setup();
        let member = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &s.contract_id);
        s.client.increment(&s.contract_id, &member);

        let events = events_named(&s.env, "score_updated");
        assert_eq!(
            events.len(),
            1,
            "expected exactly one 'score_updated' event"
        );

        let (evt_member, evt_score): (Address, u32) = FromVal::from_val(&s.env, &events[0]);
        assert_eq!(evt_member, member, "event must carry the member address");
        assert_eq!(evt_score, 1u32, "event must carry the new total score");
    }

    #[test]
    fn test_rejected_increment_emits_no_event() {
        let s = setup();
        let member = Address::generate(&s.env);
        let impostor = Address::generate(&s.env);
        let _ = s.client.try_increment(&impostor, &member);
        assert_eq!(events_named(&s.env, "score_updated").len(), 0);
    }

    #[test]
    fn test_caller_added_event_carries_circle_address() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        assert_eq!(only_address_event(&s.env, "caller_added"), circle);
    }

    #[test]
    fn test_caller_removed_event_carries_circle_address() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);
        assert_eq!(only_address_event(&s.env, "caller_removed"), circle);
    }

    /// An idempotent re-registration is not a state transition, so replaying
    /// the event stream must not show it as one.
    #[test]
    fn test_duplicate_add_emits_only_one_caller_added_event() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.add_authorized_caller(&s.admin, &circle);
        assert_eq!(events_named(&s.env, "caller_added").len(), 1);
    }

    /// A rejected re-registration must leave no trace in the event stream
    /// either, so an off-chain replay never resurrects the circle.
    #[test]
    fn test_rejected_re_add_emits_no_caller_added_event() {
        let s = setup();
        let circle = Address::generate(&s.env);
        s.client.add_authorized_caller(&s.admin, &circle);
        s.client.remove_authorized_caller(&s.admin, &circle);
        let _ = s.client.try_add_authorized_caller(&s.admin, &circle);

        assert_eq!(events_named(&s.env, "caller_added").len(), 1);
        assert_eq!(events_named(&s.env, "caller_removed").len(), 1);
    }
}
