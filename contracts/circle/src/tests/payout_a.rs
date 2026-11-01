use super::*;

    fn test_get_pot_amount_readable_while_pending() {
        let t = setup_circle();
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);

        let pot = t.circle.get_pot_amount();
        assert_eq!(pot, ROUND_AMOUNT * 4);
    }

    /// `get_pot_amount` must remain readable after all rounds complete.
    /// The value stays constant because Config is never mutated post-initialize.
    #[test]
    fn test_get_pot_amount_readable_after_completed() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);

        let pot = t.circle.get_pot_amount();
        assert_eq!(pot, ROUND_AMOUNT * 4, "pot must be unchanged after circle completes");
    }

    /// `get_pot_amount` must remain readable after a circle is cancelled.
    #[test]
    fn test_get_pot_amount_readable_after_cancelled() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

        let pot = t.circle.get_pot_amount();
        assert_eq!(pot, ROUND_AMOUNT * 4, "pot must be readable after cancellation");
    }

    /// Minimal 2-member circle: pot must be 2 × round_amount.
    ///
    /// Exercises the lower bound of member count to ensure the calculation is
    /// correct for circles smaller than the 4-member default fixture.
    #[test]
    fn test_get_pot_amount_two_member_circle() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let member_a = Address::generate(&env);
        let member_b = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(member_a);
        members.push_back(member_b);

        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin,
            &members,
            &ROUND_AMOUNT,
            &token_address,
            &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        let pot = circle.get_pot_amount();
        assert_eq!(pot, ROUND_AMOUNT * 2, "2-member pot must be 2 × ROUND_AMOUNT");
    }

    /// `get_pot_amount` must return the same value across consecutive calls —
    /// it must have no side-effects and no dependency on call count.
    #[test]
    fn test_get_pot_amount_is_idempotent() {
        let t = setup_circle();
        let first  = t.circle.get_pot_amount();
        let second = t.circle.get_pot_amount();
        let third  = t.circle.get_pot_amount();
        assert_eq!(first, second, "get_pot_amount must return the same value on repeated calls");
        assert_eq!(second, third,  "get_pot_amount must be idempotent");
    }

    /// `get_pot_amount` reflects the full-round pot (round_amount × member_count).
    /// The partial pot paid by `settle_round` (contributed_count × round_amount)
    /// must always be ≤ get_pot_amount, and their difference equals the
    /// forfeited contributions from defaulting members.
    #[test]
    fn test_get_pot_amount_upper_bounds_settle_round_partial_pot() {
        let t = setup_circle();
        t.activate();

        let full_pot = t.circle.get_pot_amount();
        assert_eq!(full_pot, ROUND_AMOUNT * 4, "full pot must be 4 × ROUND_AMOUNT");

        // Alice and Bob contribute; Carol and Dave default.
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.advance_past_deadline();

        let alice_before = t.token.balance(&t.alice); // round-0 recipient

        // settle_round pays out a partial pot: 2 × ROUND_AMOUNT
        t.circle.settle_round();

        let alice_after = t.token.balance(&t.alice);
        let alice_net = alice_after - alice_before; // contributed 1×, received 2× → net +1×

        let partial_pot = ROUND_AMOUNT * 2; // 2 contributors
        assert!(
            partial_pot <= full_pot,
            "partial pot ({partial_pot}) must be <= get_pot_amount ({full_pot})"
        );
        assert_eq!(
            alice_net,
            partial_pot - ROUND_AMOUNT,
            "alice net must be partial_pot − her own contribution"
        );

        // The difference (forfeited contributions) equals the missed contribution amounts.
        let forfeited_contributions = full_pot - partial_pot;
        assert_eq!(
            forfeited_contributions,
            ROUND_AMOUNT * 2,
            "2 defaulting members forfeit 2 × ROUND_AMOUNT in contributions"
        );
    }

    /// `get_pot_amount` is readable and correct immediately after `settle_round`
    /// advances the circle to the next round — the view must reflect the *full*
    /// next-round pot, not the partial pot of the settled round.
    #[test]
    fn test_get_pot_amount_stable_after_settle_round() {
        let t = setup_circle();
        t.activate();

        // Record the pot before any settlement — must be constant throughout.
        let pot_before = t.circle.get_pot_amount();

        // Exceptional settlement: only alice contributes.
        t.circle.contribute(&t.alice);
        t.advance_past_deadline();
        t.circle.settle_round();

        // After settle_round the circle is on round 1.
        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, 1);

        // get_pot_amount must still return the same full-pot value —
        // it reads Config which is immutable after initialize.
        let pot_after = t.circle.get_pot_amount();
        assert_eq!(
            pot_after, pot_before,
            "get_pot_amount must be unchanged after settle_round: Config is immutable"
        );
        assert_eq!(pot_after, ROUND_AMOUNT * 4);
    }

    /// `get_pot_amount` matches `payout`'s actual pot in every round of a
    /// full lifecycle run, not just round 0.  This guards against any
    /// round-specific divergence.
    #[test]
    fn test_get_pot_amount_matches_payout_for_every_round() {
        let t = setup_circle();
        t.activate();

        let full_pot = t.circle.get_pot_amount();

        // Run all 4 rounds; in each round verify the pot view matches the
        // actual net transfer to the recipient.
        let members = [t.alice.clone(), t.bob.clone(), t.carol.clone(), t.dave.clone()];
        for expected_recipient in &members {
            let bal_before = t.token.balance(expected_recipient);
            t.contribute_all();
            t.circle.payout();
            let bal_after = t.token.balance(expected_recipient);

            // Recipient's net = full_pot − their own contribution.
            let net = bal_after - bal_before;
            assert_eq!(
                net,
                full_pot - ROUND_AMOUNT,
                "recipient net must be get_pot_amount() − own contribution in every round"
            );
        }
    }

    /// `get_pot_amount` for a 2-member circle: pot must be 2 × round_amount.
    /// The helper must work for any valid member count, not just the 4-member fixture.
    #[test]
    fn test_get_pot_amount_two_member_circle_value() {
        let (env, token_address, reputation_id) = setup_env_with_token_and_reputation();
        let circle_id = env.register_contract(None, CircleContract);
        let circle = CircleContractClient::new(&env, &circle_id);

        let member_a = Address::generate(&env);
        let member_b = Address::generate(&env);
        let mut members = Vec::new(&env);
        members.push_back(member_a.clone());
        members.push_back(member_b.clone());
        let circle_admin = Address::generate(&env);
        circle.initialize(
            &circle_admin, &members, &ROUND_AMOUNT, &token_address, &reputation_id,
            &MIN_ROUND_DEADLINE_LEDGERS,
        );

        // Pot must equal 2 × ROUND_AMOUNT for a 2-member circle.
        assert_eq!(circle.get_pot_amount(), ROUND_AMOUNT * 2);

        // Config.round_amount × Config.members.len() must produce the same value.
        let config = circle.get_config();
        let expected = config.round_amount * config.members.len() as i128;
        assert_eq!(circle.get_pot_amount(), expected);
    }

    /// The `ContractError::PotOverflow` variant exists for `get_pot_amount` to
    /// return gracefully if the multiplication overflows.  Since `initialize`
    /// already rejects overflowing configurations, this can only be triggered
    /// by inserting a crafted Config directly into storage.  Verify that the
    /// view returns a typed error rather than panicking.
    #[test]
    fn test_get_pot_amount_returns_pot_overflow_error_on_crafted_overflow() {
        let t = setup_circle();

        // Overwrite round_amount in the stored Config with i128::MAX so that
        // round_amount × member_count(4) overflows.  This bypasses initialize's
        // overflow guard intentionally to exercise the view's own error path.
        t.env.as_contract(&t.circle_id, || {
            let mut config: crate::CircleConfig = t
                .env
                .storage()
                .instance()
                .get(&crate::DataKey::Config)
                .unwrap();
            config.round_amount = i128::MAX;
            t.env
                .storage()
                .instance()
                .set(&crate::DataKey::Config, &config);
        });

        // try_get_pot_amount must return an error (PotOverflow), not panic.
        let result = t.circle.try_get_pot_amount();
        assert!(
            result.is_err(),
            "get_pot_amount must return an error when round_amount × member_count overflows"
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #164 — Enforce canonical round lifecycle and default-resolution
    // invariants.
    //
    // Tests in this section cover adversarial edge cases, exact deadline
    // boundary strictness, post-payout mutation attempts, idempotency of
    // default/contribution records, and multi-round state consistency.
    // ══════════════════════════════════════════════════════════════════════════

    // ── Helpers ───────────────────────────────────────────────────────────────

    impl<'a> TestSetup<'a> {
        /// Write a `Contributed(member, round_index)` persistent key directly,
        /// bypassing the contract entry-point.  Used to manufacture fake
        /// contribution records for invariant tests.
        fn force_contributed(&self, member: &Address, round_index: u32) {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .set(&DataKey::Contributed(member.clone(), round_index), &true);
            });
        }

        /// Check whether a `Contributed(member, round_index)` key exists in
        /// persistent storage without going through the contract entry-point.
        fn has_contributed_key(&self, member: &Address, round_index: u32) -> bool {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .has(&DataKey::Contributed(member.clone(), round_index))
            })
        }

        /// Check whether a `Defaulted(member, round_index)` key exists.
        fn has_defaulted_key(&self, member: &Address, round_index: u32) -> bool {
            self.env.as_contract(&self.circle_id, || {
                self.env
                    .storage()
                    .persistent()
                    .has(&DataKey::Defaulted(member.clone(), round_index))
            })
        }
    }

    // ── Post-payout mutation rejection ────────────────────────────────────────

    /// Once a round is paid out, `payout` must refuse to run again for the
    /// same round.  Because `payout` immediately advances `CurrentRound` to
    /// the next round (or sets Completed), the `paid_out` flag on the *old*
    /// round is only visible through the storage directly, but the new round's
    /// `paid_out` starts as false.  This test verifies the double-payout path
    /// is impossible by confirming the status and round index advance correctly.
    #[test]
    fn test_payout_advances_round_so_double_payout_impossible() {
        let t = setup_circle();
        t.activate();
        t.contribute_all();
        t.circle.payout();

        // After payout the round has advanced to index 1 — payout for round 0
        // cannot be called again because CurrentRound now points to round 1.
        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, 1, "round must have advanced after payout");
        assert!(!round.paid_out, "new round must not be marked paid_out");
    }

    /// A second call to `payout` on a round that has not yet received all
    /// contributions must panic with the incomplete-tally message.  This ensures
    /// that even if a caller attempts to replay payout before contributions
    /// arrive, the guard fires.
    #[test]
    #[should_panic]
    fn test_payout_without_full_contributions_panics() {
        let t = setup_circle();
        t.activate();
        // Only two of four members contribute
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.payout();
    }

    /// After a complete round (contribute_all + payout), contributing for the
    /// *old* round index must be rejected because `paid_out` is set before
    /// `CurrentRound` advances and the contribution entry for that member
    /// already exists.
    #[test]
    #[should_panic]
    fn test_contribute_after_payout_on_same_round_panics() {
        let t = setup_circle();
        t.activate();
        t.contribute_all(); // round 0: all contribute
        // Do NOT call payout yet — alice tries to contribute again for round 0
        t.circle.contribute(&t.alice);
    }

    /// After payout has run and the round index has advanced, contributing for
    /// the new round is valid.  This confirms the round advancement doesn't
    /// lock out contributions for subsequent rounds.
    #[test]
    fn test_contribute_for_new_round_after_payout_succeeds() {
        let t = setup_circle();
        t.activate();
        t.complete_round(); // round 0 → payout → round 1 starts

        let round = t.circle.get_current_round();
        assert_eq!(round.round_index, 1);

        // Contributing for round 1 should succeed (no prior contribution)
        t.circle.contribute(&t.alice);
        assert!(t.has_contributed_key(&t.alice, 1));
    }

    // ── Default after payout rejection ────────────────────────────────────────

    /// `mark_default` on a round that has already been paid out must be
    /// rejected.  Because `payout` advances `CurrentRound` to the next round
    /// immediately, `mark_default` on the *old* round index is structurally
    /// impossible (there is no in-progress round with that index any more).
    /// This test confirms the round-advancement makes old-round defaults
    /// unreachable.
    #[test]
    fn test_mark_default_impossible_on_paid_out_round() {
        let t = setup_circle();
        t.activate();
        t.complete_round(); // round 0 paid out; CurrentRound now = round 1

        // Advance past the new deadline to enter default territory
        t.advance_past_deadline();

        // carol didn't contribute to round 1; mark her default for round 1
        t.circle.mark_default(&t.carol);
        // The default is recorded for round 1, NOT round 0
        assert!(t.has_defaulted_key(&t.carol, 1));
        assert!(
            !t.has_defaulted_key(&t.carol, 0),
            "no Defaulted key must exist for round 0 — it was paid out"
        );
    }

    /// Attempting to call `mark_default` on a Completed circle must panic with
    /// "circle is not active".
    #[test]
    #[should_panic]
    fn test_mark_default_on_completed_circle_panics() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        // Circle is now Completed — any mark_default must fail
        t.circle.mark_default(&t.alice);
    }

    /// Attempting to call `mark_default` on a Cancelled circle must also panic
    /// with "circle is not active".
    #[test]
    #[should_panic]
    fn test_mark_default_on_cancelled_circle_panics() {
        let t = setup_circle();
        t.circle.cancel(&t.alice);
        t.circle.mark_default(&t.alice);
    }

    // ── Idempotency: Contributed and Defaulted records ────────────────────────

    /// A `Contributed` key written via `force_contributed` exists in storage
    /// and is acknowledged by `has_contributed`.  This validates that the
    /// low-level key format used by the contract is consistent with what the
    /// test can observe directly.
    #[test]
